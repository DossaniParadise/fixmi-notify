/**
 * FixMi → Postmark notifier.  Deploy as a Vercel serverless function.
 *
 * Emails the store's Director, District Manager(s) and General Manager when a
 * ticket is created or its status changes.
 *
 * WHY THIS LIVES ON A SERVER AND NOT IN THE APP
 * The Postmark Server API token can send mail as dossaniparadise.com to anyone
 * on earth. FixMi's HTML is public — store managers, techs and (through share
 * links) outside vendors all load it — so the token must never be in it. The
 * app calls this function; only this function holds the token.
 *
 * The app sends a ticket id + a shared secret. Recipients are NOT taken from
 * the request: this function looks the store up in the alignment master and
 * mails that store's own Director / DM / GM. So even if someone digs the shared
 * secret out of the app's source, the worst they can do is re-send a real
 * ticket's notification to the three people who were already going to get it.
 *
 * ── ENVIRONMENT VARIABLES (Vercel → Settings → Environment Variables) ────────
 *   POSTMARK_TOKEN        required   Server API token (Postmark → your server → API Tokens)
 *   FIXMI_SHARED_SECRET   required   Any long random string; must match NOTIFY_SECRET in the app
 *   FIXMI_FROM            optional   default "randm@dossaniparadise.com" (must be a verified sender)
 *   FIXMI_APP_URL         optional   default "https://dossaniparadise.github.io/DPM-FixMi/"
 *   FIXMI_MASTER_URL      optional   default the dpm-alignment endpoint
 *   FIXMI_ALLOW_ORIGIN    optional   default "*" — set to "https://dossaniparadise.github.io" to lock it down
 *   FIXMI_STREAM          optional   default "outbound" (Postmark's Default Transactional Stream)
 *
 * Whoever performed the action is never emailed about their own change.
 *
 * WHO ACTUALLY GETS EMAILED is not set here — it is edited in FixMi under
 * Settings → Email and stored in the master at admins/notifyPrefs. This
 * function reads that record on every send, so changing it takes effect
 * immediately with no redeploy. If the record is missing, the fallback is
 * Director + District Manager + General Manager on both events.
 *   FIXMI_DRY_RUN         optional   "1" to log instead of send (nothing leaves Postmark)
 */

const DEFAULTS = {
  from: "randm@dossaniparadise.com",
  appUrl: "https://dossaniparadise.github.io/DPM-FixMi/",
  masterUrl: "https://alignment-api-khaki.vercel.app/api/dpm-alignment",
  stream: "outbound",
};

const STATUS_LABEL = {
  unassigned: "Unassigned", assigned: "Assigned", dispatched: "Dispatched", waiting: "Waiting",
  in_progress: "In Progress", finished: "Finished", closed: "Closed",
};
const PRIORITY_LABEL = { normal: "Normal", urgent: "Urgent", emergency: "Emergency" };

const lc = v => String(v || "").trim().toLowerCase();
const arr = v => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : (v ? [v] : []));
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* A store can carry several DMs; FindMi mirrors only the first into the legacy
   singular field, so always read the array form when it exists. */
function storeCoachIds(store) {
  let ids = [];
  if (Array.isArray(store.assignedAreaCoachIds)) ids = store.assignedAreaCoachIds.slice();
  else if (store.assignedAreaCoachIds && typeof store.assignedAreaCoachIds === "object") ids = Object.values(store.assignedAreaCoachIds);
  else if (store.assignedAreaCoachId) ids = [store.assignedAreaCoachId];
  return [...new Set(ids.filter(Boolean))];
}

const EVENTS = ["created", "status", "comment"];
const PREF_DEFAULTS = {
  on: true,
  roles: { director: { created: true, status: true, comment: true }, dm: { created: true, status: true, comment: true },
           gm: { created: true, status: true, comment: true },
           tech: { created: false, status: false, comment: false }, reporter: { created: false, status: false, comment: false },
           /* Anyone who joined the thread from outside — a vendor who replied
              to a FixMi email, a guest who commented on a share link. They
              were being recorded on the ticket and then never written to
              again, so a conversation with an outside vendor went one way. */
           watcher: { created: false, status: false, comment: true } },
  testMode: false, testTo: [], alwaysTo: [],
  /* The VP summary has no role behind it — it goes to a named list. */
  vpTo: [],
  digestTo: [],
  /* Nudges for tickets that are waiting on the store rather than on a tech.
     This one ships switched on so the feature works the moment both files are
     deployed, rather than waiting for somebody to open Settings and press
     Save. Saving an empty list here deletes it, as you would expect. */
  reminders: [{
    id: "headset-return", on: true, name: "Headset exchange return",
    match: ["headset exchange", "headsets to be replaced", "headset return", "return has been shipped"],
    days: 7, repeatDays: 7, to: ["gm", "dm"],
    message: "Reminder to keep an eye out for your headset exchange, be sure to send the old ones back to avoid being charged.",
  }],
  /* Which priorities each role/event pair actually wants. Absent means all
     three, so every record saved before this existed keeps behaving the same. */
  pri: {},
  /* One named person's own settings, which beat their role's. Keyed by email.
     Only the parts actually set are honoured, so someone can be given their own
     answer on comments while still following their role for everything else. */
  people: {},
};
const PRIORITIES = ["emergency", "urgent", "normal"];
/** Read Settings → Email out of the master, falling back to sane defaults. */
function prefsFrom(master) {
  const raw = (master.admins || {}).notifyPrefs;
  const p = JSON.parse(JSON.stringify(PREF_DEFAULTS));
  if (raw && typeof raw === "object") {
    if (typeof raw.on === "boolean") p.on = raw.on;
    if (typeof raw.testMode === "boolean") p.testMode = raw.testMode;
    if (raw.roles && typeof raw.roles === "object")
      Object.keys(p.roles).forEach(k => {
        const v = raw.roles[k]; if (!v || typeof v !== "object") return;
        // A record saved before comments existed has no `comment` key — keep the
        // default for it rather than reading undefined as "off".
        EVENTS.forEach(e => { if (v[e] !== undefined) p.roles[k][e] = !!v[e]; });
      });
    if (raw.pri && typeof raw.pri === "object") {
      Object.keys(p.roles).forEach(role => {
        const r = raw.pri[role]; if (!r || typeof r !== "object") return;
        p.pri[role] = {};
        EVENTS.forEach(e => {
          const v = r[e];
          if (Array.isArray(v)) p.pri[role][e] = v.map(lc).filter(x => PRIORITIES.includes(x));
        });
      });
    }
    if (raw.reminders !== undefined) p.reminders = arr(raw.reminders);
    if (raw.people && typeof raw.people === "object") {
      /* Written as a list, because the database refuses a key with a dot in it
         and every one of these is keyed by an email address. An older record
         may still be a map, so both are read. */
      const entries = Array.isArray(raw.people)
        ? raw.people.filter(Boolean).map(v => [v && v.email, v])
        : Object.entries(raw.people).map(([k, v]) => [(v && v.email) || k, v]);
      entries.forEach(([em, v]) => {
        const e = lc(em); if (!e.includes("@") || !v || typeof v !== "object") return;
        const rec = {};
        if (v.roles && typeof v.roles === "object") {
          rec.roles = {};
          EVENTS.forEach(ev => { if (typeof v.roles[ev] === "boolean") rec.roles[ev] = v.roles[ev]; });
        }
        if (v.pri && typeof v.pri === "object") {
          rec.pri = {};
          EVENTS.forEach(ev => {
            const list = v.pri[ev];
            if (Array.isArray(list)) rec.pri[ev] = list.map(lc).filter(x => PRIORITIES.includes(x));
          });
        }
        if (typeof v.weekly === "boolean") rec.weekly = v.weekly;
        if (Object.keys(rec).length) p.people[e] = rec;
      });
    }
    ["testTo", "alwaysTo", "vpTo", "digestTo"].forEach(k => {
      const v = raw[k];
      p[k] = (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map(lc).filter(e => e.includes("@"));
    });
  }
  return p;
}

/** Everyone who should get this particular email, per Settings → Email. */
function recipientsFor(master, ticket, opts) {
  const { prefs, event } = opts;
  const store = (master.restaurants || {})[ticket.storeId] || {};
  const out = new Map();                                   // email → {email, name, role}
  /* Blank priority counts as Normal, and a pref that was never set counts as
     "all of them" — so nobody silently stops getting email because a record
     predates this setting. */
  const pri = lc(ticket.priority) || "normal";
  /* A person's own setting wins over their role's, in both directions: it can
     switch them off when the role is on, and on when the role is off. Anything
     they have no answer for falls back to the role. */
  const wants = (key, email) => {
    const ov = (prefs.people || {})[lc(email)] || null;
    const evOn = (ov && ov.roles && typeof ov.roles[event] === "boolean")
      ? ov.roles[event]
      : (prefs.roles[key] || {})[event];
    if (!evOn) return false;
    const list = (ov && ov.pri && Array.isArray(ov.pri[event]))
      ? ov.pri[event]
      : ((prefs.pri || {})[key] || {})[event];
    return !Array.isArray(list) || list.includes(pri);
  };
  const put = (email, name, role, key) => {
    if (key && !wants(key, email)) return;                 // off for this event, priority, or person
    const e = lc(email);
    if (e && e.includes("@") && !out.has(e)) out.set(e, { email: e, name: name || e, role });
  };
  const dir = (master.directors || {})[store.assignedDirectorId];
  if (dir) put(dir.email, dir.name, "Director", "director");
  storeCoachIds(store).forEach(id => {
    const dm = (master.areaCoaches || {})[id];
    if (dm) put(dm.email, dm.name, "District Manager", "dm");
  });
  put(store.email, store.storeManager || store.storeName, "General Manager", "gm");
  const tech = (master.repairTechnicians || {})[ticket.assignedTechId];
  if (tech) put(tech.email, tech.name, "Assigned tech", "tech");
  /* A DM the ticket has been handed to is already in the list as a District
     Manager, but they have been asked to do something — so they are added
     under the "dm" key regardless, and the role label says which it is. */
  const owner = (master.areaCoaches || {})[ticket.assignedCoachId];
  if (owner) put(owner.email, owner.name, "Assigned District Manager", "dm");
  put(ticket.createdBy, ticket.createdByName, "Reported by", "reporter");
  arr(ticket.guestWatchers).forEach(e => put(e, e, "On the thread", "watcher"));

  // Never tell someone about the thing they just did.
  if (opts.actorEmail) out.delete(lc(opts.actorEmail));

  /* Test mode replaces the whole list — nobody real is emailed. It still
     respects an empty list, so switching a priority off really does go quiet
     in testing instead of quietly still arriving. */
  if (prefs.testMode) {
    if (!out.size && !prefs.alwaysTo.length) return [];
    return prefs.testTo.map(e => ({ email: e, name: e, role: "Test" }));
  }
  prefs.alwaysTo.forEach(e => { if (!out.has(e)) out.set(e, { email: e, name: e, role: "Always copied" }); });
  if (opts.actorEmail) out.delete(lc(opts.actorEmail));
  return [...out.values()];
}

/* Store names in FindMi often already carry the number ("Burger King #11460
   Bonham"), and some storeNumber values arrive with a "#" already on them.
   Naming a store in one place stops subjects like "Store ##11460 — Burger
   King #11460 Bonham". */
function storeLabel(store) {
  const name = String(store.storeName || "Store").trim();
  const num = String(store.storeNumber || "").replace(/^#+/, "").trim();
  if (!num || name.includes(num)) return name;
  return `${name} #${num}`;
}
/* The subject has to stay IDENTICAL for every email about one ticket, or mail
   clients stop threading them. Ticket number, store, then what's broken. */
function subjectFor(store, ticket) {
  const cat = String(ticket.categoryLabel || [ticket.category, ticket.subcategory].filter(Boolean).join(" → ")).trim();
  return `[${ticket.shortId || "Ticket"}] ${storeLabel(store)}${cat ? " — " + cat : ""}`;
}

/* Say what actually happened in words, not a status-code diff. "Moved from
   Finished to Closed" tells a District Manager far less than "closed". */
/* A status email's whole job is "what changed, and does that need anything
   from me". The old one buried the change as one row in a table of nine and
   left the reader to work out what "Waiting" meant for them. These three
   pieces — the plain-English headline, the from → to band, and a line saying
   what happens next — replace that guesswork. */
const STATUS_TONE = {
  unassigned:  "#4b5563",
  assigned:    "#1d76bb",
  dispatched:  "#1d76bb",
  in_progress: "#1d76bb",
  waiting:     "#c2740a",
  finished:    "#047857",
  closed:      "#047857",
};
/** Drop the decoration so a name reads as a name inside a sentence. */
function plainAssignee(a) {
  return String(a || "").replace(/^[^\w(]+/, "").replace(/\s*\((in-house|third-party|District Manager)\)\s*$/i, "").trim();
}
function headlineFor(event, store, ticket, prevStatus, comment, extra) {
  const who = storeLabel(store);
  if (event === "created") return `${who} has a new ticket open.`;
  if (event === "comment") return `${who} — new comment from ${(comment && comment.by) || "someone"}.`;

  const assignee = (extra && extra.assignee) || ticket.assigneeLabel || "";
  const name = plainAssignee(assignee);
  /* One sentence that fits every assignee — a technician, a plumbing firm, or
     a holding queue like "Reminders". Who it is on beats which column it sits
     in, so lead with that when it changed. */
  const assignedLine = name ? `${who} — this ticket has been assigned to ${name}.`
                            : `${who} — this ticket is back in the queue, with nobody assigned.`;
  if (extra && extra.assigneeChanged) return assignedLine;
  switch (ticket.status) {
    case "closed":      return `${who} — this ticket is closed.`;
    case "finished":    return `${who} — the work on this ticket is done.`;
    case "in_progress": return `${who} — work has started on this ticket.`;
    // The reason is already phrased as "Awaiting parts", so "waiting on
    // awaiting parts" would stutter.
    case "waiting":     return `${who} — this ticket is paused${ticket.waitingReason ? ", " + String(ticket.waitingReason).charAt(0).toLowerCase() + String(ticket.waitingReason).slice(1) : ""}.`;
    case "unassigned":  return `${who} — this ticket is back in the queue, with nobody assigned.`;
    case "assigned":
    case "dispatched":  return assignedLine;
  }
  const to = STATUS_LABEL[ticket.status] || ticket.status || "updated";
  const from = STATUS_LABEL[prevStatus] || prevStatus;
  return from ? `${who} — ticket moved from ${from} to ${to}.` : `${who} — ticket moved to ${to}.`;
}

function fmtWhen(ts) {
  const n = Number(ts);
  if (!n) return "";
  return new Date(n).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
/* Longer form, with the year, for the ticket's own opening date — a comment
   from this morning reads fine as "Sep 28, 9:14 AM", but a ticket that has been
   open since the spring needs to say so. */
function fmtDay(ts) {
  const n = Number(ts);
  if (!n) return "";
  return new Date(n).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
/** "3 days ago", but "today" on its own — "today ago" is not a thing. */
function agePhrase(ts) {
  const a = ageOf(ts);
  return !a ? "" : (a === "today" ? "today" : `${a} ago`);
}
/** "3 days" — how long a ticket has been sitting there. */
function ageOf(ts) {
  const n = Number(ts); if (!n) return "";
  const d = Math.floor((Date.now() - n) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "1 day";
  return `${d} days`;
}
function bodyFor({ event, store, ticket, prevStatus, appUrl, actorName, comment, wouldHaveGoneTo, extra, thread, canReply }) {
  const url = `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticket._id || "")}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
  const headline = headlineFor(event, store, ticket, prevStatus, comment, extra);
  const closeNote = ticket.closeNote && ticket.closeNote.text ? ticket.closeNote : null;
  /* Instructions written when a job was handed to a District Manager. They are
     the reason that assignment exists, so they travel with every email about
     the ticket until it is closed out, not just the one that announced it. */
  const assignNote = ticket.assignNote && ticket.assignNote.text && ticket.status !== "closed" ? ticket.assignNote : null;
  const assignee = (extra && extra.assignee) || ticket.assigneeLabel || "";
  const photos = arr(ticket.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 6);
  const cPhotos = comment ? arr(comment.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 6) : [];
  /* The whole conversation, oldest first, with the one that triggered this
     email picked out. Only on comment emails — bolting it onto every status
     change would bury the change itself. */
  const convo = (event === "comment" ? arr(thread) : []).filter(c => c && (c.text || (c.photos || []).length));
  const newestTs = convo.length ? Math.max(...convo.map(c => Number(c.ts) || 0)) : 0;
  const convoHtml = convo.map((c, i) => {
    const isNew = (Number(c.ts) || 0) === newestTs;
    const ph = arr(c.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 4);
    return `<tr><td style="padding:0 0 10px">
      <div style="border:1px solid ${isNew ? "#1d76bb" : "#e5e7eb"};background:${isNew ? "#eff6ff" : "#fff"};border-radius:9px;padding:10px 13px">
        <div style="font-size:12px;color:#6b7280"><b style="color:#111827">${i + 1}. ${esc(c.by || "Someone")}</b>${c.email ? ` &lt;${esc(c.email)}&gt;` : ""} · ${esc(fmtWhen(c.ts))}${isNew ? ` <span style="color:#1d76bb;font-weight:700">· newest</span>` : ""}</div>
        ${c.text ? `<div style="font-size:14.5px;line-height:1.5;white-space:pre-wrap;margin-top:4px">${esc(c.text)}</div>` : ""}
        ${ph.length ? `<div style="margin-top:8px">${ph.map(u => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" width="120" alt="" style="width:120px;border-radius:6px;border:1px solid #e5e7eb;display:inline-block;margin:0 6px 6px 0"></a>`).join("")}</div>` : ""}
      </div></td></tr>`;
  }).join("");
  // The new comment, big, directly under the headline — no scrolling for it.
  const newCommentBlock = comment ? `<tr><td style="padding:4px 24px 0">
    <div style="border-left:4px solid #1d76bb;background:#eff6ff;border-radius:0 9px 9px 0;padding:12px 16px">
      <div style="font-size:12px;font-weight:700;color:#1d76bb;text-transform:uppercase;letter-spacing:.06em">New comment · ${esc(comment.by || "")}${comment.ts ? " · " + esc(fmtWhen(comment.ts)) : ""}</div>
      ${comment.text ? `<div style="font-size:16px;line-height:1.55;white-space:pre-wrap;margin-top:6px">${esc(comment.text)}</div>` : ""}
      ${cPhotos.length ? `<div style="margin-top:10px">${cPhotos.map(u => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" width="160" alt="Comment photo" style="width:160px;max-width:100%;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</div>` : ""}
    </div></td></tr>` : "";
  /* The change itself, shown as a change. Only on status emails — on a new
     ticket or a comment there is no "from". */
  const isStatus = event === "status";
  const moved = isStatus && prevStatus && prevStatus !== ticket.status;
  const tone = STATUS_TONE[ticket.status] || "#1d76bb";
  const chip = (label, colour, strong) =>
    `<span style="display:inline-block;border:1px solid ${strong ? colour : "#d1d5db"};${strong ? `background:${colour};color:#fff;` : "color:#6b7280;"}font-size:13px;font-weight:${strong ? 700 : 400};border-radius:7px;padding:4px 11px;white-space:nowrap">${esc(label)}</span>`;
  const changeBand = isStatus ? `<tr><td style="padding:14px 24px 0">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      ${moved ? `<td style="padding-right:9px">${chip(STATUS_LABEL[prevStatus] || prevStatus, "", false)}</td>
                 <td style="padding-right:9px;color:#9ca3af;font-size:17px">&rarr;</td>` : ""}
      <td>${chip(STATUS_LABEL[ticket.status] || ticket.status, tone, true)}</td>
    </tr></table>
    <div style="font-size:12.5px;color:#6b7280;margin-top:8px">Changed by ${esc(actorName || "someone")} · ${esc(fmtWhen(Date.now()))}</div>
  </td></tr>` : "";
  const facts = [
    ["Store", storeLabel(store)],
    // On a status email the status is the headline, the band and the next-step
    // box — a ninth row repeating it is what made these hard to read.
    isStatus ? null : ["Status", STATUS_LABEL[ticket.status] || ticket.status],
    ["Priority", ticket.priority ? (PRIORITY_LABEL[ticket.priority] || ticket.priority) : "Normal"],
    ["Category", ticket.categoryLabel || [ticket.category, ticket.subcategory].filter(Boolean).join(" › ")],
    ["Assigned to", assignee],
    (ticket.status === "waiting" && !isStatus) ? ["Waiting on", ticket.waitingReason] : null,
    ["Reported by", ticket.createdByName || ticket.createdBy],
    ["Opened", ticket.createdAt ? `${fmtDay(ticket.createdAt)}  (${agePhrase(ticket.createdAt)})` : ""],
    (event === "created" || isStatus) ? null : ["Comment by", (comment && comment.by) || actorName],
  ].filter(Boolean).filter(([, v]) => String(v == null ? "" : v).trim() !== "");   // a blank row is noise, not "—"

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Ticket ${esc(ticket.shortId || "")}</td></tr>
  ${wouldHaveGoneTo ? `<tr><td style="background:#fffbeb;border-bottom:1px solid #fde68a;padding:11px 24px;font-size:12.5px;color:#92400e">
    <b>Test mode.</b> Nobody else received this. Live, it would have gone to: ${esc(wouldHaveGoneTo.join(", ") || "nobody")}.</td></tr>` : ""}
  <tr><td style="padding:24px 24px 6px"><div style="font-size:19px;font-weight:700;line-height:1.35">${esc(headline)}</div>
    ${isStatus ? "" : `<div style="font-size:14px;color:#6b7280;margin-top:6px">See details below.</div>`}</td></tr>
  ${changeBand}
  ${newCommentBlock}
  <tr><td style="padding:14px 24px 0"><table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7">
    ${facts.map(([k, v]) => `<tr><td style="color:#6b7280;padding-right:16px;white-space:nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
  </table></td></tr>
  <tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Issue${ticket.createdAt ? ` <span style="font-weight:400;text-transform:none;letter-spacing:0">· ${esc(ticket.createdByName || ticket.createdBy || "")} · ${esc(fmtDay(ticket.createdAt))}</span>` : ""}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">${esc(ticket.description || "No description")}</div></td></tr>
  ${photos.length ? `<tr><td style="padding:14px 24px 0">${photos.map(u => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" width="160" alt="Ticket photo" style="width:160px;max-width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</td></tr>` : ""}
  ${assignNote ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Instructions${assignNote.to ? ` for ${esc(assignNote.to)}` : ""} · ${esc(assignNote.by || "")}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px">${esc(assignNote.text)}</div>
  </td></tr>` : ""}
  ${closeNote ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Closing notes · ${esc(closeNote.by || "")}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px">${esc(closeNote.text)}</div>
  </td></tr>` : ""}
  ${convoHtml ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Conversation · ${convo.length} comment${convo.length === 1 ? "" : "s"}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${convoHtml}</table>
  </td></tr>` : ""}
  <tr><td style="padding:24px 24px 6px"><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px" target="_blank">Open in FixMi →</a>
    ${canReply ? `<div style="font-size:13px;color:#9ca3af;margin-top:12px">Reply to this email to add a comment.</div>` : ""}</td></tr>
  <tr><td style="height:12px"></td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af">Dossani Paradise · Repair &amp; Maintenance · Ticket ${esc(ticket.shortId || "")}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    ...(comment ? [`NEW COMMENT · ${comment.by || ""}${comment.ts ? " · " + fmtWhen(comment.ts) : ""}`, comment.text || "", ...cPhotos, ""] : []),
    ...(wouldHaveGoneTo ? [`TEST MODE — nobody else received this. Live, it would have gone to: ${wouldHaveGoneTo.join(", ") || "nobody"}.`, ""] : []),
    headline, "",
    ...(isStatus ? [
      moved ? `${STATUS_LABEL[prevStatus] || prevStatus}  →  ${STATUS_LABEL[ticket.status] || ticket.status}`
            : `Now: ${STATUS_LABEL[ticket.status] || ticket.status}`,
      `Changed by ${actorName || "someone"} · ${fmtWhen(Date.now())}`,
      "",
    ] : []),
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "", "ISSUE", ticket.description || "No description",
    ...(photos.length ? ["", "PHOTOS", ...photos] : []),
    ...(assignNote ? ["", `INSTRUCTIONS${assignNote.to ? ` FOR ${String(assignNote.to).toUpperCase()}` : ""} · ${assignNote.by || ""}`, assignNote.text] : []),
    ...(closeNote ? ["", `CLOSING NOTES · ${closeNote.by || ""}`, closeNote.text] : []),
    ...(convo.length ? ["", `CONVERSATION (${convo.length})`,
      ...convo.map((c, i) => `${i + 1}. ${c.by || "Someone"} · ${fmtWhen(c.ts)}${(Number(c.ts) || 0) === newestTs ? "  ← newest" : ""}\n   ${(c.text || "").replace(/\n/g, "\n   ")}`)] : []),
    ...(canReply ? ["", "Reply to this email to add a comment."] : []),
    "", `See more on FixMi: ${url}`,
    "", "--", "Dossani Paradise · Repair & Maintenance",
  ].join("\n");

  return { html, text, url };
}

/* ════════════════════════════════════════════════════════════════════════════
   WEEKLY SUMMARIES

   Three different emails, because three different people need three different
   things on a Monday morning:

     gm  — one store, every open ticket in full, each with a Yes/No button so
           the manager can tell us in one click whether it is still a problem.
     dm  — their whole patch, grouped by store, subject lines only.
     do  — a league table: how many are open at each store, worst first.
   ════════════════════════════════════════════════════════════════════════════ */

const OPEN_STATUSES = ["unassigned", "assigned", "dispatched", "waiting", "in_progress", "finished"];
const PRI_RANK = { emergency: 0, urgent: 1, normal: 2 };

function openTicketsFor(master, storeId) {
  return Object.entries(master.maintenanceTickets || {})
    .filter(([, t]) => t && t.storeId === storeId && OPEN_STATUSES.includes(t.status))
    .map(([id, t]) => ({ ...t, _id: id }))
    .sort((a, b) => (PRI_RANK[a.priority] === undefined ? 2 : PRI_RANK[a.priority]) - (PRI_RANK[b.priority] === undefined ? 2 : PRI_RANK[b.priority])
      || (a.createdAt || 0) - (b.createdAt || 0));
}

/* The Yes/No links have to survive being forwarded, sat in an inbox for a week
   and clicked from a phone with no login. They are signed with the shared
   secret so the ticket id and the answer can't be edited into something else,
   and they carry who was asked, so the comment is attributed properly. */
/* The alignment master sits behind a CDN that will happily serve a copy up to
   a minute old. Anywhere we read a ticket, change it and write the whole thing
   back, that copy is a hazard: two people answering the same ticket a few
   seconds apart would each read the world as it was before the other, and the
   second write would erase the first one's comment. A unique query string is a
   different object as far as the CDN is concerned, so this always reaches the
   origin — and if the API ever objects to the extra parameter, the plain read
   still runs. */
async function readMaster(url) {
  const opts = { headers: { accept: "application/json", "cache-control": "no-cache" }, cache: "no-store" };
  const bust = url + (url.includes("?") ? "&" : "?") + "_fresh=" + Date.now().toString(36);
  const r = await fetch(bust, opts).catch(() => null);
  return (r && r.ok) ? r : fetch(url, opts);
}

function answerSig(ticketId, answer, email, when, role) {
  return require("crypto").createHmac("sha256", process.env.FIXMI_SHARED_SECRET || "")
    .update(`${ticketId}|${answer}|${lc(email)}|${when || ""}${role ? "|" + lc(role) : ""}`).digest("hex").slice(0, 32);
}
/* `when` is the day this summary went out. It is signed in so that each week's
   buttons are their own links — otherwise a manager who answered last week
   would be told "already noted" every week after. */
/* `role` is what the press is allowed to do. A General Manager's press only
   ever writes a comment; a District Manager's "Resolved" also moves the ticket
   to Finished. It is signed along with everything else, so the two cannot be
   swapped by editing the address bar, and a link with no role at all — one
   sent before this existed — is treated as the GM case, which changes nothing. */
function answerUrl(base, ticketId, answer, email, when, role) {
  const q = new URLSearchParams({ t: ticketId, a: answer, e: lc(email), w: when || "", r: lc(role || "gm"),
    s: answerSig(ticketId, answer, email, when, role || "gm") });
  return `${base.replace(/\/$/, "")}/api/answer?${q}`;
}
function todayStamp() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = t => (f.find(x => x.type === t) || {}).value || "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** The pair of buttons that turn a summary line into a one-tap answer. */
function answerButtons(cfg, ticketId, email, size, role) {
  const w = cfg.stamp || todayStamp();
  const pad = size === "sm" ? "7px 15px" : "9px 22px";
  const fs = size === "sm" ? "13px" : "14px";
  return `<a href="${esc(answerUrl(cfg.selfUrl, ticketId, "unresolved", email, w, role))}" target="_blank" style="display:inline-block;background:#c81e1e;color:#fff;text-decoration:none;font-weight:700;font-size:${fs};padding:${pad};border-radius:8px;margin:0 8px 6px 0">Unresolved</a>` +
    `<a href="${esc(answerUrl(cfg.selfUrl, ticketId, "resolved", email, w, role))}" target="_blank" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;font-weight:700;font-size:${fs};padding:${pad};border-radius:8px;margin:0 0 6px 0">Resolved</a>`;
}

function ticketUrlFor(appUrl, t) {
  return `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(t.shortId || t._id || "")}${t.shareToken ? "/" + t.shareToken : ""}`;
}
/* One store, all of its tickets. Staff only — there is no share token on this
   one, so FixMi asks whoever follows it to sign in first. */
function storeUrlFor(appUrl, storeId) {
  return `${appUrl.replace(/#.*$/, "")}#s/${encodeURIComponent(storeId)}`;
}

const PRI_CHIP = {
  emergency: 'background:#fee2e2;color:#991b1b',
  urgent: 'background:#ffedd5;color:#9a3412',
  normal: 'background:#f3f4f6;color:#4b5563',
};
function priChip(p) {
  const k = lc(p) || "normal";
  return `<span style="display:inline-block;${PRI_CHIP[k] || PRI_CHIP.normal};font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;text-transform:uppercase;letter-spacing:.04em">${esc(PRIORITY_LABEL[k] || k)}</span>`;
}

/** Everyone FixMi already emails — the guard on "send a test to this address". */
function knownAddresses(master, prefs) {
  const known = new Set([...(prefs.testTo || []), ...(prefs.alwaysTo || [])]);
  [master.admins, master.directors, master.areaCoaches, master.repairTechnicians, master.restaurants]
    .forEach(g => Object.values(g || {}).forEach(o => { const e = lc(o && o.email); if (e) known.add(e); }));
  return known;
}

/** Post a batch to Postmark and read the per-message results properly. */
async function sendBatch(cfg, messages) {
  const out = { ok: false, sent: 0, failed: [], perMessage: [] };
  for (let i = 0; i < messages.length; i += 500) {          // Postmark caps a batch at 500
    const slice = messages.slice(i, i + 500);
    const pm = await fetch("https://api.postmarkapp.com/email/batch", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.token },
      body: JSON.stringify(slice),
    });
    const results = await pm.json().catch(() => []);
    const list = Array.isArray(results) ? results : [results];
    if (!pm.ok) {
      out.failed.push({ status: pm.status, detail: list });
      slice.forEach(m => out.perMessage.push({ ok: false, to: m.To }));
      continue;
    }
    list.forEach((x, j) => {
      const bad = !!(x && x.ErrorCode);
      if (bad) out.failed.push({ to: (slice[j] || {}).To, code: x.ErrorCode, message: x.Message });
      else out.sent++;
      out.perMessage.push({ ok: !bad, to: (slice[j] || {}).To });
    });
  }
  out.ok = out.sent > 0 && !out.failed.length;
  return out;
}

function testBanner(person, html) {
  return html.replace(/(<tr><td style="background:#1d76bb[^]*?<\/td><\/tr>)/,
    `$1<tr><td style="background:#fffbeb;border-bottom:1px solid #fde68a;padding:11px 24px;font-size:12.5px;color:#92400e">` +
    `<b>Test mode.</b> Live, this would have gone to ${esc(person.name)} &lt;${esc(person.email)}&gt;.</td></tr>`);
}

/* The role goes in the subject so a Director with three hats can tell at a
   glance which of their summaries this is, and so a forwarded one is
   self-explanatory. Overwatch gets the VP view, but says Overwatch. */
const SUMMARY_TAG = { gm: "GM", dm: "DM", do: "DO", vp: "VP", ow: "Overwatch", tech: "Tech" };
function summarySubject(kind, rest) {
  return `FixMi ${SUMMARY_TAG[kind] || "Weekly"} Weekly Summary — ${rest}`;
}

function shell(title, subtitle, inner, band) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; ${esc(band || "Weekly summary")}</td></tr>
  ${title ? `<tr><td style="padding:22px 24px 4px"><div style="font-size:20px;font-weight:700;line-height:1.3">${esc(title)}</div>
    ${subtitle ? `<div style="font-size:14px;color:#6b7280;margin-top:5px">${esc(subtitle)}</div>` : ""}</td></tr>` : ""}
  ${inner}
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af;line-height:1.5">
    Dossani Paradise · Repair &amp; Maintenance · sent every week from FixMi</td></tr>
</table></td></tr></table></body></html>`;
}

/** The General Manager's store, in full, with a question against each ticket. */
function summaryGM(master, person, cfg) {
  const store = person.store || {};
  const tickets = openTicketsFor(master, person.storeId);
  const label = storeLabel(store);
  if (!tickets.length) {
    return {
      subject: summarySubject("gm", `${label}: nothing open`),
      html: shell(`Nothing open at ${label}`, "No open tickets this week.",
        `<tr><td style="padding:14px 24px 24px"><div style="font-size:15px;line-height:1.55;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;padding:14px 16px">All clear.</div></td></tr>`),
      text: `Nothing open at ${label}.\n\nNo maintenance tickets are outstanding this week.`,
    };
  }
  const rows = tickets.map(t => {
    const cat = t.categoryLabel || [t.category, t.subcategory].filter(Boolean).join(" › ");
    return `<tr><td style="padding:0 24px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px">
        <tr><td style="padding:14px 16px">
          <div style="font-size:12px;color:#6b7280">${priChip(t.priority)} &nbsp; <b style="color:#111827">${esc(t.shortId || "")}</b> · ${esc(STATUS_LABEL[t.status] || t.status)} · open ${esc(ageOf(t.createdAt))}</div>
          ${cat ? `<div style="font-size:13px;color:#6b7280;margin-top:5px">${esc(cat)}</div>` : ""}
          <div style="font-size:15px;line-height:1.5;margin-top:6px;white-space:pre-wrap">${esc(t.description || "No description")}</div>
          <div style="font-size:12.5px;color:#6b7280;margin-top:7px">Opened ${esc(fmtDay(t.createdAt))} by ${esc(t.createdByName || t.createdBy || "someone")}${t.assigneeLabel ? ` · assigned to ${esc(t.assigneeLabel)}` : ""}</div>
          <div style="margin-top:13px;font-size:13px;color:#6b7280">Still a problem?</div>
          <div style="margin-top:8px">${answerButtons(cfg, t._id, person.email, null, "gm")}</div>
          <div style="margin-top:9px;font-size:12px"><a href="${esc(ticketUrlFor(cfg.appUrl, t))}" target="_blank" style="color:#1d76bb">Open it in FixMi</a></div>
        </td></tr>
      </table></td></tr>`;
  }).join("");
  const text = [
    `${label} — ${tickets.length} open ticket${tickets.length === 1 ? "" : "s"}`, "",
    ...tickets.map(t => [
      `${t.shortId} · ${PRIORITY_LABEL[lc(t.priority)] || "Normal"} · ${STATUS_LABEL[t.status] || t.status} · open ${ageOf(t.createdAt)}`,
      t.description || "No description",
      `UNRESOLVED: ${answerUrl(cfg.selfUrl, t._id, "unresolved", person.email, cfg.stamp, "gm")}`,
      `                  RESOLVED:   ${answerUrl(cfg.selfUrl, t._id, "resolved", person.email, cfg.stamp, "gm")}`,
      "",
    ].join("\n")),
  ].join("\n");
  return {
    subject: summarySubject("gm", `${label}: ${tickets.length} open ticket${tickets.length === 1 ? "" : "s"}`),
    html: shell(`${tickets.length} open at ${label}`,
      "Either answer leaves a note on the ticket.",
      `<tr><td style="height:10px"></td></tr>${rows}`),
    text,
  };
}

/** The District Manager's patch: every store, subject lines only. */
function summaryDM(master, person, cfg) {
  const app = (cfg && cfg.appUrl) || DEFAULTS.appUrl;
  const blocks = person.storeIds.map(sid => {
    const store = (master.restaurants || {})[sid] || {};
    const tickets = openTicketsFor(master, sid);
    return { sid, label: storeLabel(store), tickets };
  }).sort((a, b) => b.tickets.length - a.tickets.length || a.label.localeCompare(b.label));
  const total = blocks.reduce((n, b) => n + b.tickets.length, 0);
  /* Everything here is a link: the store name opens that store's whole list,
     each line opens the ticket itself. Underlines are left off so it still
     reads as a list rather than a wall of blue. */
  const rows = blocks.map(b => `<tr><td style="padding:0 24px 14px">
      <div style="font-size:14px;font-weight:700;border-bottom:1px solid #e5e7eb;padding-bottom:5px">
        <a href="${esc(storeUrlFor(app, b.sid))}" target="_blank" style="color:#111827;text-decoration:none">${esc(b.label)} <span style="color:#1d76bb;font-size:12px;font-weight:400">view store &rsaquo;</span></a>
        <span style="float:right;color:#6b7280;font-weight:400">${b.tickets.length} open</span></div>
      ${b.tickets.length
        ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13.5px;line-height:1.5;margin-top:7px">${
            b.tickets.map(t => `<tr>
              <td style="padding:8px 8px 14px 0;white-space:nowrap;vertical-align:top">${priChip(t.priority)}</td>
              <td style="padding:8px 0 14px;vertical-align:top">
                <a href="${esc(ticketUrlFor(app, t))}" target="_blank" style="color:#111827;text-decoration:none">
                  <b style="color:#1d76bb">${esc(t.shortId || "")}</b> — ${esc(t.categoryLabel || [t.category, t.subcategory].filter(Boolean).join(" › ") || "Ticket")}
                  <span style="color:#6b7280">· ${esc(STATUS_LABEL[t.status] || t.status)} · ${esc(ageOf(t.createdAt))}</span></a>
                <!-- Without the issue itself a DM is being asked to mark
                     something resolved on the strength of its category. -->
                <div style="font-size:14px;line-height:1.5;color:#111827;margin-top:4px;white-space:pre-wrap">${esc(t.description || "No description")}</div>
                <div style="margin-top:8px">${answerButtons(cfg, t._id, person.email, "sm", "dm")}</div></td></tr>`).join("")
          }</table>`
        : `<div style="font-size:13.5px;color:#059669;margin-top:6px">Nothing open.</div>`}
    </td></tr>`).join("");
  const text = [`${total} open across ${blocks.length} store${blocks.length === 1 ? "" : "s"}`, "",
    ...blocks.map(b => `${b.label} — ${b.tickets.length} open\n${storeUrlFor(app, b.sid)}\n` +
      (b.tickets.length ? b.tickets.map(t => `  ${t.shortId} — ${t.categoryLabel || t.category || "Ticket"} (${PRIORITY_LABEL[lc(t.priority)] || "Normal"}, ${STATUS_LABEL[t.status] || t.status}, ${ageOf(t.createdAt)})\n  ${(t.description || "No description").replace(/\n/g, "\n  ")}\n  ${ticketUrlFor(app, t)}\n  Unresolved: ${answerUrl(cfg.selfUrl, t._id, "unresolved", person.email, cfg.stamp, "dm")}\n  Resolved:   ${answerUrl(cfg.selfUrl, t._id, "resolved", person.email, cfg.stamp, "dm")}`).join("\n\n") : "  Nothing open.") + "\n")].join("\n");
  return {
    subject: summarySubject("dm", `${total} open across your ${blocks.length} store${blocks.length === 1 ? "" : "s"}`),
    html: shell(`${total} open across your ${blocks.length} store${blocks.length === 1 ? "" : "s"}`,
      "Busiest store first. Resolved moves a ticket to Finished; Unresolved notes it.",
      `<tr><td style="height:10px"></td></tr>${rows}`),
    text,
  };
}

/** The Director's league table: counts only, worst first. */
/* ---- severity, shared by every aggregate view -----------------------------
   Severity colours are validated for colour-blind separation against a white
   email background (ΔE 15.6 normal vision, 9.2 deutan, all ≥3:1 contrast), and
   every count is written out in words beside its colour, so nothing here is
   carried by hue alone. */
const SEV = {
  emergency: { fill: "#c81e1e", label: "emergency" },
  urgent:    { fill: "#c2740a", label: "urgent" },
  normal:    { fill: "#1d76bb", label: "normal" },
};
const SEV_ORDER = ["emergency", "urgent", "normal"];
const zeroCounts = () => ({ emergency: 0, urgent: 0, normal: 0 });
function countSeverity(tickets) {
  const c = zeroCounts();
  tickets.forEach(t => { const k = lc(t.priority); c[SEV[k] ? k : "normal"]++; });
  return c;
}
const addCounts = (into, from) => { SEV_ORDER.forEach(k => { into[k] += from[k]; }); return into; };

function statTile(n, label, colour) {
  return `<td width="33%" style="padding:0 5px" valign="top">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px">
      <tr><td style="padding:12px 14px">
        <div style="font-size:30px;line-height:1.05;font-weight:800;color:${colour}">${n}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:3px;text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
      </td></tr></table></td>`;
}
function statRow(counts) {
  const total = counts.emergency + counts.urgent + counts.normal;
  return `<tr><td style="padding:14px 19px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    ${statTile(total, "open in total", "#111827")}
    ${statTile(counts.emergency, "emergency", counts.emergency ? SEV.emergency.fill : "#9ca3af")}
    ${statTile(counts.urgent, "urgent", counts.urgent ? SEV.urgent.fill : "#9ca3af")}
  </tr></table></td></tr>`;
}

/* A thin stacked bar. Its LENGTH is the store's share of the busiest store, so
   volume is comparable from row to row; its segments are the split by
   severity. Measuring each bar against its own total instead would make one
   emergency look the same weight as four tickets. 2px of surface between
   segments rather than a border. */
function sevBar(counts, max, marginTop) {
  const scale = Math.max(1, max);
  const keys = SEV_ORDER.filter(k => counts[k]);
  const segs = keys.map(k =>
    `<td width="${Math.max(3, Math.round((counts[k] / scale) * 100))}%" style="background:${SEV[k].fill};height:8px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td>` +
    `<td width="2" style="font-size:0;line-height:0">&nbsp;</td>`).join("");
  const used = keys.reduce((n, k) => n + Math.max(3, Math.round((counts[k] / scale) * 100)), 0);
  const rest = Math.max(0, 100 - used);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:${marginTop == null ? 9 : marginTop}px;table-layout:fixed"><tr>${segs}` +
    (rest ? `<td width="${rest}%" style="font-size:0;line-height:0">&nbsp;</td>` : "") + `</tr></table>`;
}

/** The colour key, spelled out. `extra` rides along as one more grey item. */
function sevLegend(counts, extra) {
  const parts = SEV_ORDER.filter(k => counts[k]).map(k =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${SEV[k].fill}"></span> ${counts[k]} ${SEV[k].label}`);
  if (extra) parts.push(`<span style="color:#9ca3af">${esc(extra)}</span>`);
  /* The separator belongs to the item after it and rides inside the same
     nowrap span, so a legend that wraps never strands a dot at a line end. */
  return parts.map((html, i) => `<span style="white-space:nowrap">${i ? "&nbsp;·&nbsp; " : ""}${html}</span>`).join(" ");
}
function sevWords(counts) {
  return SEV_ORDER.filter(k => counts[k]).map(k => `${counts[k]} ${SEV[k].label}`).join(", ");
}

/* ---- what is open, by category -------------------------------------------
   Before reading store names, a Director wants to know whether this is an
   equipment week or an IT week. Only the top level counts: a ticket filed as
   "IT → Network Issues" is one IT ticket. Older records carry the label and
   nothing else, newer ones carry the key, so read whichever is there. */
const CAT_TITLE = { it: "IT", pos: "POS", hvac: "HVAC", ops_support: "OPS Support" };
const titleCat = raw => CAT_TITLE[lc(raw)] || String(raw).replace(/_/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase());
function topCategory(t) {
  const fromLabel = String(t.categoryLabel || "").split(/[\u2192\u203a>|]/)[0].trim();
  /* A label that is already cased is used as it stands — it is what the app
     shows. Legacy records saved the raw key into the label field, so anything
     with no capital in it goes through the same tidy-up as a bare key. */
  if (fromLabel) return /[A-Z]/.test(fromLabel) ? fromLabel : titleCat(fromLabel);
  return lc(t.category) ? titleCat(t.category) : "Other";
}
function categoryCounts(tickets) {
  const m = new Map();
  tickets.forEach(t => { const k = topCategory(t); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}
function catGrid(counts) {
  if (!counts.length) return "";
  const cells = counts.map(c => `<td width="33%" style="padding:0 5px 10px" valign="top">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:9px">
        <tr><td style="padding:9px 12px">
          <div style="font-size:19px;font-weight:800;line-height:1.1">${c.n}</div>
          <div style="font-size:11.5px;color:#6b7280;margin-top:2px">${esc(c.label)}</div>
        </td></tr></table></td>`);
  const rows = [];
  for (let i = 0; i < cells.length; i += 3) {
    const row = cells.slice(i, i + 3);
    while (row.length < 3) row.push('<td width="33%"></td>');
    rows.push(`<tr>${row.join("")}</tr>`);
  }
  return `<tr><td style="padding:17px 24px 3px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">By category</td></tr>
    <tr><td style="padding:0 19px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed">${rows.join("")}</table></td></tr>`;
}
function catText(counts) {
  return counts.length ? ["BY CATEGORY", ...counts.map(c => `${String(c.n).padStart(3)}  ${c.label}`), ""].join("\n") : "";
}

/* One heading that carries a name on the left and its count on the right. */
function groupHead(name, n, level) {
  return level === 1
    ? `<tr><td style="padding:19px 24px 0"><div style="border-top:2px solid #111827;padding-top:9px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em">
        ${esc(name)}<span style="float:right;font-weight:400;color:#6b7280;text-transform:none;letter-spacing:0">${n} open</span></div></td></tr>`
    : `<tr><td style="padding:13px 24px 5px;font-size:12.5px;font-weight:700;color:#4b5563">
        ${esc(name)}<span style="float:right;font-weight:400;color:#9ca3af">${n} open</span></td></tr>`;
}

/* Which Director and which DM a store answers to. A store can carry several
   DMs; the first is the one it is grouped under, the way FixMi treats it
   everywhere else. */
function ownersOf(master, store) {
  const dir = (master.directors || {})[store.assignedDirectorId];
  const dm = storeCoachIds(store).map(id => (master.areaCoaches || {})[id]).find(Boolean);
  return {
    dirKey: dir ? (lc(dir.email) || lc(dir.name)) : "",
    dirName: dir ? (dir.name || dir.email) : "No Director assigned",
    dmKey: dm ? (lc(dm.email) || lc(dm.name)) : "",
    dmName: dm ? (dm.name || dm.email) : "No District Manager assigned",
  };
}
/* Emergencies first, then urgents, then sheer volume. Anything with nobody
   assigned to it sinks to the bottom whatever its numbers, because it is a
   data problem rather than a store problem. */
const bySeverity = (a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1)
  || b.counts.emergency - a.counts.emergency || b.counts.urgent - a.counts.urgent
  || b.n - a.n || String(a.name).localeCompare(String(b.name));

function groupBy(list, keyOf, nameOf) {
  const out = [], map = new Map();
  list.forEach(item => {
    const k = keyOf(item);
    let g = map.get(k);
    if (!g) { g = { key: k, name: nameOf(item), items: [], n: 0, counts: zeroCounts() }; map.set(k, g); out.push(g); }
    g.items.push(item); g.n += item.total; addCounts(g.counts, item.counts);
  });
  return out;
}

/** The Director's week, split by District Manager. */
function summaryDO(master, person, cfg) {
  const app = (cfg && cfg.appUrl) || DEFAULTS.appUrl;
  const stores = person.storeIds.map(sid => {
    const store = (master.restaurants || {})[sid] || {};
    const tickets = openTicketsFor(master, sid);
    return {
      sid, label: storeLabel(store), tickets, total: tickets.length,
      counts: countSeverity(tickets),
      oldest: tickets.length ? ageOf(Math.min(...tickets.map(t => t.createdAt || Date.now()))) : "",
      ...ownersOf(master, store),
    };
  });
  const open = stores.filter(s => s.total);
  const clear = stores.filter(s => !s.total).sort((a, b) => a.label.localeCompare(b.label));
  const tot = stores.reduce((acc, s) => addCounts(acc, s.counts), zeroCounts());
  const total = tot.emergency + tot.urgent + tot.normal;
  const busiest = Math.max(1, ...stores.map(s => s.total));

  const dms = groupBy(open, s => s.dmKey, s => s.dmName).sort(bySeverity);
  dms.forEach(g => g.items.sort((a, b) => b.counts.emergency - a.counts.emergency
    || b.counts.urgent - a.counts.urgent || b.total - a.total || a.label.localeCompare(b.label)));

  /* Every cell of the row is the same link. A Director reading this on a phone
     should not have to find the store name to get anywhere — the bar and the
     number open the store's list just as the name does. */
  const storeRow = (s, last) => {
    const url = esc(storeUrlFor(app, s.sid));
    const link = inner => `<a href="${url}" target="_blank" style="display:block;color:inherit;text-decoration:none">${inner}</a>`;
    const rule = last ? "" : "border-bottom:1px solid #f3f4f6;";
    return `<tr>
      <td width="40%" style="padding:10px 10px 10px 0;${rule}vertical-align:top">
        ${link(`<span style="font-size:14px;font-weight:700;color:#1d76bb">${esc(s.label)} &rsaquo;</span>`)}</td>
      <td width="42%" style="padding:10px;${rule}vertical-align:top">
        ${link(`${sevBar(s.counts, busiest, 3)}<div style="font-size:11.5px;color:#4b5563;margin-top:6px;line-height:1.7">${sevLegend(s.counts, s.oldest && "oldest " + s.oldest)}</div>`)}</td>
      <td width="18%" style="padding:10px 0;text-align:right;${rule}vertical-align:top">
        ${link(`<span style="font-size:19px;font-weight:800;color:#111827">${s.total}</span>`)}</td>
    </tr>`;
  };

  const sections = dms.map(g => groupHead(g.name, g.n, 1) +
    `<tr><td style="padding:2px 24px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed">${g.items.map((s, i) => storeRow(s, i === g.items.length - 1)).join("")}</table></td></tr>`).join("");

  const inner = statRow(tot) + catGrid(categoryCounts(stores.flatMap(s => s.tickets))) +
    (open.length
      ? `<tr><td style="padding:17px 24px 0;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">
          By District Manager<span style="float:right;font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af">any row opens the store</span></td></tr>${sections}`
      : `<tr><td style="padding:16px 24px 8px"><div style="font-size:15px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;padding:14px 16px">Nothing open across your stores.</div></td></tr>`) +
    (clear.length ? `<tr><td style="padding:17px 24px 20px;font-size:12.5px;color:#6b7280;line-height:1.6">
        <b style="color:#059669">All clear (${clear.length}):</b> ${clear.map(s => esc(s.label)).join(" · ")}</td></tr>` : `<tr><td style="height:14px"></td></tr>`);

  const text = [
    `${total} open across ${open.length} of ${stores.length} store${stores.length === 1 ? "" : "s"}`,
    sevWords(tot) || "nothing open", "",
    catText(categoryCounts(stores.flatMap(s => s.tickets))),
    ...dms.map(g => [`${g.name.toUpperCase()} — ${g.n} open`,
      ...g.items.map(s => `${String(s.total).padStart(5)}  ${s.label}  (${sevWords(s.counts)}${s.oldest ? `, oldest ${s.oldest}` : ""})\n         ${storeUrlFor(app, s.sid)}`), ""].join("\n")),
    clear.length ? `All clear: ${clear.map(s => s.label).join(", ")}` : "",
  ].filter(x => x !== "").join("\n");

  return {
    subject: summarySubject("do", `${total} open across ${open.length} store${open.length === 1 ? "" : "s"}${tot.emergency ? `, ${tot.emergency} emergency` : ""}`),
    html: shell(`${total} open across ${open.length} of ${stores.length} stores`, "", inner),
    text,
  };
}

/* Every summary kind this function knows how to build. */
const SUMMARY_KINDS = ["gm", "dm", "do", "vp", "ow", "tech"];

/* ════════════════════════════════════════════════════════════════════════════
   GEOGRAPHIC ZONES

   Four zones, worked out from where the stores actually are rather than from
   a list somebody has to maintain. Buy three stores in Tyler and the eastern
   zone grows to meet them; nobody edits anything.

   k-means on latitude and longitude, k = 4. Two details matter more than the
   algorithm:

     • It is DETERMINISTIC. The seeds are picked by spreading evenly through
       the stores sorted north-to-south, never at random, so Monday's email
       and the app agree, and so the same week's zones don't drift between
       one run and the next.

     • Longitude is scaled by cos(latitude) before any distance is measured.
       At 33°N a degree of longitude is about 58 miles against 69 for a
       degree of latitude; skip this and the clusters come out stretched
       east-west and the names stop matching the map.

   Naming is a separate step. Each zone's centre is compared with the middle
   of all of them, and the four compass words are handed out by trying all 24
   arrangements and keeping the one that fits best overall. That guarantees
   four different names — a greedy pass would happily call two zones North.
   ════════════════════════════════════════════════════════════════════════════ */

const ZONE_K = 4;
const DEG = Math.PI / 180;

function storePoint(store) {
  const lat = parseFloat(store && store.latitude), lng = parseFloat(store && store.longitude);
  return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
}
/* Flat-earth is fine over one metro: x in "latitude-equivalent degrees". */
const projX = (p, lat0) => p.lng * Math.cos(lat0 * DEG);

/* Seeds by farthest-point, starting from a given store: each next seed is
   whichever store is furthest from every seed so far. Deterministic, and it
   finds corners — but on its own it chases outliers, so it is run from
   several starting points below and the best result is kept. */
function seedFarthest(xy, k, first) {
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const picked = [first];
  while (picked.length < k) {
    let best = -1, bestD = -1;
    for (let i = 0; i < xy.length; i++) {
      if (picked.includes(i)) continue;
      let near = Infinity;
      for (const j of picked) near = Math.min(near, d2(xy[i], xy[j]));
      if (near > bestD + 1e-12) { bestD = near; best = i; }   // ties keep the earlier store
    }
    if (best < 0) break;
    picked.push(best);
  }
  return picked.map(i => ({ x: xy[i].x, y: xy[i].y }));
}

/** One run of Lloyd's algorithm from a given seeding. */
function lloyd(xy, cent) {
  let assign = xy.map(() => -1);
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    xy.forEach((p, idx) => {
      let best = 0, bestD = Infinity;
      cent.forEach((c, j) => {
        const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
        if (d < bestD - 1e-12) { bestD = d; best = j; }       // ties keep the lower zone index
      });
      if (assign[idx] !== best) { assign[idx] = best; moved = true; }
    });
    const sums = cent.map(() => ({ x: 0, y: 0, n: 0 }));
    xy.forEach((p, idx) => { const s = sums[assign[idx]]; s.x += p.x; s.y += p.y; s.n++; });
    cent = cent.map((c, j) => sums[j].n ? { x: sums[j].x / sums[j].n, y: sums[j].y / sums[j].n } : c);
    if (!moved && pass) break;
  }
  const inertia = xy.reduce((n, p, idx) => {
    const c = cent[assign[idx]];
    return n + (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
  }, 0);
  return { assign, cent, inertia };
}

/* A single farthest-point run is at the mercy of whichever store happens to
   be most remote: acquire five in East Texas and the seeds go out to meet
   them, leaving every DFW store in one lump called North. So the same run is
   repeated from a spread of deterministic starting stores and the tightest
   result wins. Ties go to the earlier start, so the answer never wobbles. */
const ZONE_RESTARTS = 12;
function kmeans(points, k) {
  const lat0 = points.reduce((n, p) => n + p.lat, 0) / points.length;
  const xy = points.map(p => ({ x: projX(p, lat0), y: p.lat }));
  const starts = new Set();
  const mid = { x: xy.reduce((n, p) => n + p.x, 0) / xy.length, y: xy.reduce((n, p) => n + p.y, 0) / xy.length };
  let nearest = 0;
  xy.forEach((p, i) => {
    const d = (p.x - mid.x) ** 2 + (p.y - mid.y) ** 2;
    const b = (xy[nearest].x - mid.x) ** 2 + (xy[nearest].y - mid.y) ** 2;
    if (d < b - 1e-12) nearest = i;
  });
  starts.add(nearest);
  for (let t = 0; t < ZONE_RESTARTS; t++) starts.add(Math.floor(t * xy.length / ZONE_RESTARTS));
  let best = null;
  [...starts].forEach(first => {
    const r = lloyd(xy, seedFarthest(xy, k, first));
    if (!best || r.inertia < best.inertia - 1e-12) best = r;
  });
  return { assign: best.assign, cent: best.cent, lat0 };
}

const COMPASS = ["North", "South", "East", "West"];
/* How well a centre sits in each direction, measured from the middle of all
   the centres and normalised by the spread so a wide, short region is not
   forced into East and West for everything. */
function directionScores(c, mid, span) {
  const dy = (c.y - mid.y) / span.y, dx = (c.x - mid.x) / span.x;
  return { North: dy, South: -dy, East: dx, West: -dx };
}
function nameZones(cent) {
  const mid = { x: cent.reduce((n, c) => n + c.x, 0) / cent.length, y: cent.reduce((n, c) => n + c.y, 0) / cent.length };
  const span = {
    x: Math.max(1e-9, Math.max(...cent.map(c => c.x)) - Math.min(...cent.map(c => c.x))),
    y: Math.max(1e-9, Math.max(...cent.map(c => c.y)) - Math.min(...cent.map(c => c.y))),
  };
  const scores = cent.map(c => directionScores(c, mid, span));
  const words = COMPASS.slice(0, cent.length);
  let best = null;
  const walk = (left, taken, total) => {
    if (!left.length) { if (!best || total > best.total) best = { total, taken: taken.slice() }; return; }
    left.forEach((w, i) => {
      const rest = left.slice(0, i).concat(left.slice(i + 1));
      walk(rest, taken.concat(w), total + scores[taken.length][w]);
    });
  };
  walk(words, [], 0);
  return best.taken;
}

/** storeId → zone name, recomputed from the master every time it is needed. */
function storeZones(master) {
  const stores = master.restaurants || {};
  const pts = [], ids = [];
  /* Sorted by id, not by however the master happens to be keyed: the zones a
     technician is emailed must not depend on the order records came back in. */
  Object.keys(stores).sort().forEach(sid => {
    const p = storePoint(stores[sid]);
    if (p) { pts.push(p); ids.push(sid); }
  });
  const out = {};
  if (pts.length < 2) { ids.forEach(sid => { out[sid] = ""; }); return out; }
  const k = Math.min(ZONE_K, pts.length);
  const { assign, cent } = kmeans(pts, k);
  const names = nameZones(cent);
  ids.forEach((sid, i) => { out[sid] = names[assign[i]]; });
  return out;
}
/* Zones read in a fixed order wherever they are listed, so two emails never
   disagree about which one comes first. */
const ZONE_ORDER = { North: 0, East: 1, South: 2, West: 3, "": 9 };
/* A store with no coordinates on it cannot be placed. In a technician's email
   that is not their problem to read about, so the group is simply "Other
   stores" and it sorts last; if NOTHING can be placed the zone headings are
   dropped altogether rather than shouting one meaningless title. */
const zoneLabel = z => z ? `${z} zone` : "Other stores";

/* ---- what a technician actually finished last week ------------------------
   FixMi's API drops closed tickets from the normal payload — they were about
   seven tenths of it — so a week's completed work is mostly invisible from
   the master alone. The weekly run therefore asks for the closed set once,
   for everybody, and hands it down. If that call fails the summaries still go
   out; the line about last week is simply left off rather than shown wrong. */
async function fetchClosed(masterUrl) {
  try {
    const url = masterUrl + (masterUrl.includes("?") ? "&" : "?") + "closed=only";
    const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.maintenanceTickets) || null;
  } catch (e) { return null; }
}

/* When the work was actually done. A status change always leaves a stamped
   entry on the ticket's own timeline, so that is the first place to look;
   the explicit fields are next, and the last-touched time is the fallback. */
const DONE_STATUSES = ["finished", "closed"];
function completedAt(t) {
  const marks = arr(t.activity)
    .filter(a => a && a.action === "status" && DONE_STATUSES.includes(lc(a.toStatus)) && a.ts)
    .map(a => Number(a.ts));
  if (marks.length) return Math.max(...marks);
  return Number(t.finishedAt) || Number(t.closedAt) || Number(t.updatedAt) || 0;
}
/** Tickets this technician finished or closed in the seven days just gone. */
function lastWeekFor(techId, pool, nowTs) {
  const from = (nowTs || Date.now()) - 7 * 86400000;
  const done = Object.values(pool || {}).filter(t =>
    t && t.assignedTechId === techId && DONE_STATUSES.includes(lc(t.status)) && completedAt(t) >= from);
  return { tickets: done.length, stores: new Set(done.map(t => t.storeId)).size };
}

/* "Gino Rossi" → "Gino". A first name is how you greet somebody. */
const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";
function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Everything dispatched to one technician by name, wherever it is. */
function techTickets(master, techId) {
  return Object.entries(master.maintenanceTickets || {})
    .filter(([, t]) => t && t.assignedTechId === techId && OPEN_STATUSES.includes(t.status))
    .map(([id, t]) => ({ ...t, _id: id }))
    .sort((a, b) => (PRI_RANK[a.priority] === undefined ? 2 : PRI_RANK[a.priority]) - (PRI_RANK[b.priority] === undefined ? 2 : PRI_RANK[b.priority])
      || (a.createdAt || 0) - (b.createdAt || 0));
}

/* ---- the technician's worklist -------------------------------------------
   Grouped by store, because that is how the week is actually driven: one trip
   per site. Within a store the worst thing comes first. The two buttons only
   ever leave a comment — a technician saying "that one's done" is a report
   from the field, and moving the ticket on stays with the District Manager. */
/* ---- the technician's week ------------------------------------------------
   Written for a phone held in one hand in a van. A zone name big enough to
   find by thumb, the count beside it, and then the only three things that
   decide what gets done first: how bad it is, what is broken, and where.

   No buttons: a technician tells us a job is done by finishing it in FixMi,
   not by answering a question in an email. No category, no status, no ticket
   age buried in a run-on line. Everything here is one tap to the ticket.

   Severity colours are the validated trio used across FixMi's emails —
   ΔE 15.6 normal vision, 9.2 deutan, all at or above 3:1 on white — and each
   one carries its word, so nothing is told by colour alone. */
function techPriTag(p) {
  const k = lc(p) || "normal";
  const c = SEV[k] ? SEV[k] : SEV.normal;
  return `<span style="display:inline-block;background:${c.fill};color:#fff;font-size:11px;font-weight:800;
    letter-spacing:.07em;text-transform:uppercase;border-radius:5px;padding:3px 8px;white-space:nowrap">${esc(PRIORITY_LABEL[k] || k)}</span>`;
}

function summaryTech(master, person, cfg) {
  const app = (cfg && cfg.appUrl) || DEFAULTS.appUrl;
  const tickets = techTickets(master, person.techId);
  const zones = storeZones(master);
  const stores = master.restaurants || {};

  const byZone = [];
  const zSeen = new Map();
  tickets.forEach(t => {
    const zone = zones[t.storeId] || "";
    let z = zSeen.get(zone);
    if (!z) { z = { zone, label: zoneLabel(zone), tickets: [], stores: new Set(), counts: zeroCounts() }; zSeen.set(zone, z); byZone.push(z); }
    z.tickets.push(t); z.stores.add(t.storeId);
    const k = lc(t.priority); z.counts[SEV[k] ? k : "normal"]++;
  });
  byZone.sort((a, b) => (ZONE_ORDER[a.zone] ?? 9) - (ZONE_ORDER[b.zone] ?? 9));
  const placed = byZone.some(z => z.zone);

  const line = t => {
    const st = stores[t.storeId] || {};
    return `<tr><td style="padding:0 0 4px">
      <a href="${esc(ticketUrlFor(app, t))}" target="_blank" style="display:block;text-decoration:none;color:#111827;
         border:1px solid #e5e7eb;border-left:5px solid ${(SEV[lc(t.priority)] || SEV.normal).fill};border-radius:10px;padding:13px 14px">
        ${techPriTag(t.priority)}
        <div style="font-size:17px;line-height:1.35;font-weight:600;margin-top:9px">${esc(t.description || "No description")}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:6px">${esc(storeLabel(st))} &nbsp;·&nbsp; ${esc(ageOf(t.createdAt))}</div>
      </a></td></tr>`;
  };

  /* Only the HEADING is conditional. With no coordinates anywhere there is no
     zone to announce, but the tickets themselves still have to be listed. */
  const zoneHead = z => `<tr><td style="padding:22px 20px 0">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:3px solid #111827">
        <tr>
          <td style="padding:12px 0 2px;vertical-align:bottom">
            <div style="font-size:27px;line-height:1.1;font-weight:800;letter-spacing:-.01em">${esc(z.label)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:5px">${
              SEV_ORDER.filter(k => z.counts[k]).map(k => `${z.counts[k]} ${SEV[k].label}`).join(" · ")
            } &nbsp;·&nbsp; ${z.stores.size} store${z.stores.size === 1 ? "" : "s"}</div>
          </td>
          <td style="padding:12px 0 2px;text-align:right;vertical-align:bottom;white-space:nowrap">
            <span style="font-size:46px;line-height:1;font-weight:800">${z.tickets.length}</span>
          </td>
        </tr>
      </table></td></tr>`;
  const zoneBlock = z => (placed ? zoneHead(z) : "") +
    `<tr><td style="padding:${placed ? 14 : 18}px 20px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${
      z.tickets.map(line).join("")}</table></td></tr>`;

  const lw = person.lastWeek;
  const hello = `${greeting()}${firstName(person.name) ? " " + esc(firstName(person.name)) : ""}.`;
  const recap = lw
    ? (lw.tickets
        ? `Last week you closed ${lw.tickets} ticket${lw.tickets === 1 ? "" : "s"} across ${lw.stores} store${lw.stores === 1 ? "" : "s"}.`
        : "Nothing came through as closed last week.")
    : "";

  const head = `<tr><td style="padding:24px 20px 0">
      <div style="font-size:22px;font-weight:700;line-height:1.3">${hello}</div>
      ${recap ? `<div style="font-size:16px;color:#374151;line-height:1.45;margin-top:7px">${esc(recap)}</div>` : ""}
      <div style="font-size:16px;color:#374151;line-height:1.45;margin-top:${recap ? 14 : 7}px">${
        tickets.length
          ? `Here&rsquo;s a preview of this week:`
          : `Nothing is assigned to you this week.`}</div></td></tr>`;

  const text = [
    `${greeting()}${firstName(person.name) ? " " + firstName(person.name) : ""}.`,
    recap, "",
    tickets.length ? "Here's a preview of this week:" : "Nothing is assigned to you this week.", "",
    ...byZone.map(z => [
      ...(placed ? [z.label.toUpperCase() + `  —  ${z.tickets.length}`,
        SEV_ORDER.filter(k => z.counts[k]).map(k => `${z.counts[k]} ${SEV[k].label}`).join(" · ") +
          ` · ${z.stores.size} store${z.stores.size === 1 ? "" : "s"}`, ""] : []),
      ...z.tickets.map(t => `  [${(PRIORITY_LABEL[lc(t.priority)] || "Normal").toUpperCase()}] ${t.description || "No description"}\n  ${storeLabel(stores[t.storeId] || {})} · ${ageOf(t.createdAt)}\n  ${ticketUrlFor(app, t)}`),
      "",
    ].join("\n")),
  ].filter(x => x !== "").join("\n");

  return {
    subject: summarySubject("tech", `${tickets.length} assigned to you${placed && byZone.length > 1 ? ` across ${byZone.length} zones` : ""}`),
    html: shell("", "", head + byZone.map(zoneBlock).join("") + `<tr><td style="height:22px"></td></tr>`),
    text,
  };
}

/* ---- the VP view: every store at once, three to a row, Director then DM --- */
function storeTile(row, app, max) {
  const worst = SEV_ORDER.find(k => row.counts[k]) || "normal";
  /* Every tile lists three severity slots whether or not it has all three,
     the unused ones as blank space underneath. Percentage heights on a
     nested table are
     ignored by most mail clients, so this is what actually makes three tiles
     in a row finish level with one another. */
  const listed = SEV_ORDER.filter(k => row.counts[k]);
  const legend = listed.map(k =>
    `<div style="white-space:nowrap;margin-top:3px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${SEV[k].fill}"></span> ${row.counts[k]} ${SEV[k].label}</div>`).join("")
    + Array(SEV_ORDER.length - listed.length).fill(`<div style="margin-top:3px;font-size:11px;line-height:1.45">&nbsp;</div>`).join("");
  return `<td width="33%" style="padding:0 5px 10px" valign="top">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-left:4px solid ${SEV[worst].fill};border-radius:10px">
      <tr><td style="padding:11px 12px" valign="top">
        <a href="${esc(storeUrlFor(app, row.sid))}" target="_blank" style="color:#111827;text-decoration:none">
          <div style="font-size:12.5px;font-weight:700;line-height:1.3;color:#1d76bb">${esc(row.label)} &rsaquo;</div>
          <div style="font-size:24px;font-weight:800;line-height:1.1;margin-top:5px">${row.total}<span style="font-size:11px;font-weight:400;color:#6b7280"> open</span></div>
          ${sevBar(row.counts, max, 8)}
          <div style="font-size:11px;color:#4b5563;margin-top:5px;line-height:1.45">${legend}</div>
          <div style="font-size:10.5px;color:#9ca3af;margin-top:6px">${row.oldest ? "oldest " + esc(row.oldest) : "&nbsp;"}</div>
        </a>
      </td></tr></table></td>`;
}

/** Everything, everywhere — the whole company, under the people who own it. */
function summaryVP(master, person, cfg) {
  const app = (cfg && cfg.appUrl) || DEFAULTS.appUrl;
  const rows = Object.keys(master.restaurants || {}).map(sid => {
    const store = (master.restaurants || {})[sid] || {};
    const tickets = openTicketsFor(master, sid);
    return {
      sid, label: storeLabel(store), tickets, total: tickets.length,
      counts: countSeverity(tickets),
      oldest: tickets.length ? ageOf(Math.min(...tickets.map(t => t.createdAt || Date.now()))) : "",
      ...ownersOf(master, store),
    };
  });
  const busy = rows.filter(r => r.total);
  const clear = rows.filter(r => !r.total).sort((a, b) => a.label.localeCompare(b.label));
  const tot = rows.reduce((acc, r) => addCounts(acc, r.counts), zeroCounts());
  const total = tot.emergency + tot.urgent + tot.normal;
  const busiest = Math.max(1, ...busy.map(r => r.total));

  /* Director, then DM, then stores. A VP reading down the page is reading an
     org chart with this week's numbers on it, which is how the conversation
     afterwards is going to go. */
  const dirs = groupBy(busy, r => r.dirKey, r => r.dirName).sort(bySeverity);
  dirs.forEach(d => {
    d.dms = groupBy(d.items, r => r.dmKey, r => r.dmName).sort(bySeverity);
    d.dms.forEach(m => m.items.sort((a, b) => b.counts.emergency - a.counts.emergency
      || b.counts.urgent - a.counts.urgent || b.total - a.total || a.label.localeCompare(b.label)));
  });

  const grid3 = list => {
    const out = [];
    for (let i = 0; i < list.length; i += 3) {
      const row = list.slice(i, i + 3);
      out.push(`<tr>${row.map(r => storeTile(r, app, busiest)).join("")}${Array(3 - row.length).fill('<td width="33%"></td>').join("")}</tr>`);
    }
    return out.join("");
  };
  const sections = dirs.map(d => groupHead(d.name, d.n, 1) + d.dms.map(m => groupHead(m.name, m.n, 2) +
    `<tr><td style="padding:0 19px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed">${grid3(m.items)}</table></td></tr>`).join("")).join("");

  const inner = statRow(tot) + catGrid(categoryCounts(rows.flatMap(r => r.tickets))) +
    (busy.length
      ? `<tr><td style="padding:17px 24px 0;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">
          Stores with something open · ${busy.length}<span style="float:right;font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af">any tile opens the store</span></td></tr>${sections}`
      : `<tr><td style="padding:16px 24px 8px"><div style="font-size:15px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;padding:14px 16px">Nothing open anywhere.</div></td></tr>`) +
    (clear.length ? `<tr><td style="padding:17px 24px 20px;font-size:12.5px;color:#6b7280;line-height:1.6">
        <b style="color:#059669">All clear (${clear.length}):</b> ${clear.map(r => esc(r.label)).join(" · ")}</td></tr>` : `<tr><td style="height:14px"></td></tr>`);

  const text = [
    `${total} open across ${busy.length} of ${rows.length} store${rows.length === 1 ? "" : "s"}`,
    sevWords(tot) || "nothing open", "",
    catText(categoryCounts(rows.flatMap(r => r.tickets))),
    ...dirs.map(d => [`${d.name.toUpperCase()} — ${d.n} open`,
      ...d.dms.map(m => [`  ${m.name} — ${m.n} open`,
        ...m.items.map(r => `${String(r.total).padStart(7)}  ${r.label}  (${sevWords(r.counts)}${r.oldest ? `, oldest ${r.oldest}` : ""})\n           ${storeUrlFor(app, r.sid)}`)].join("\n")), ""].join("\n")),
    clear.length ? `All clear: ${clear.map(r => r.label).join(", ")}` : "",
  ].filter(x => x !== "").join("\n");

  return {
    subject: summarySubject(person.kind === "ow" ? "ow" : "vp", `${total} open across ${busy.length} store${busy.length === 1 ? "" : "s"}${tot.emergency ? `, ${tot.emergency} emergency` : ""}`),
    html: shell(`${total} open across ${busy.length} of ${rows.length} stores`, "", inner),
    text,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   THE MONDAY RECEIPT

   The weekly run sends dozens of emails to people who mostly will not reply.
   Without a receipt the only way to know it worked is to ask someone whether
   they got theirs. This is the list: every summary, every reminder, who it
   went to, and which ones Postmark refused.
   ════════════════════════════════════════════════════════════════════════════ */

const KIND_PLURAL = { gm: "General Managers", dm: "District Managers", do: "Directors", vp: "VP list", ow: "Overwatch", tech: "Repair technicians" };
const KIND_ORDER = ["ow", "vp", "do", "dm", "gm", "tech"];

/** Who gets the receipt: the addresses set in Settings, or Overwatch. */
function digestAudience(master, prefs) {
  const set = arr(prefs.digestTo).map(lc).filter(e => e.includes("@"));
  if (set.length) return [...new Set(set)];
  const ow = Object.values(master.admins || {})
    .filter(a => a && lc(a.tier) === "overwatch" && lc(a.email).includes("@")).map(a => lc(a.email));
  return [...new Set(ow)];
}

function digestBody({ summaries, reminders, testMode, when, appUrl }) {
  /* Counted in EMAILS, not rows. One reminder rule can nudge a GM and a DM,
     and in test mode one person's summary becomes one message per test
     address — so a row is not reliably one email. */
  const nTo = r => Math.max(1, arr(r.to).length);
  const emails = rows => rows.reduce((n, r) => n + nTo(r), 0);
  const total = emails(summaries) + emails(reminders);
  const failed = emails(summaries.filter(r => !r.ok)) + emails(reminders.filter(r => !r.ok));

  const groups = KIND_ORDER
    .map(k => ({ k, rows: summaries.filter(r => r.kind === k) }))
    .filter(g => g.rows.length);

  const line = (label, sub, ok, to) => `<tr>
    <td style="padding:7px 10px 7px 0;font-size:13.5px;border-bottom:1px solid #f3f4f6;vertical-align:top">
      <b>${esc(label)}</b><div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(sub)}</div></td>
    <td style="padding:7px 0;text-align:right;font-size:12px;white-space:nowrap;border-bottom:1px solid #f3f4f6;vertical-align:top">
      ${ok ? '<span style="color:#059669;font-weight:700">sent</span>'
           : '<span style="color:#c81e1e;font-weight:700">FAILED</span>'}
      <div style="color:#9ca3af;margin-top:2px">${esc(to)}</div></td></tr>`;

  const inner = `
  <tr><td style="padding:14px 19px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    ${statTile(total, "emails sent", "#111827")}
    ${statTile(emails(summaries), "summaries", "#1d76bb")}
    ${statTile(failed, "failed", failed ? "#c81e1e" : "#9ca3af")}
  </tr></table></td></tr>
  ${testMode ? `<tr><td style="padding:14px 24px 0"><div style="background:#fffbeb;border:1px solid #fde68a;border-radius:9px;padding:12px 14px;font-size:13px;color:#92400e">
      <b>Test mode was on.</b> Nobody in the list below received their own copy — everything went to the test addresses instead.</div></td></tr>` : ""}
  ${failed ? `<tr><td style="padding:14px 24px 0"><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:12px 14px;font-size:13px;color:#991b1b">
      <b>${failed} did not go out.</b> They are marked below. Postmark's Activity page says why.</div></td></tr>` : ""}
  ${groups.map(g => `<tr><td style="padding:17px 24px 0;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">
      ${esc(KIND_PLURAL[g.k] || g.k)} · ${g.rows.length}</td></tr>
    <tr><td style="padding:2px 24px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${
      g.rows.map(r => line(r.name || r.email, r.subject, r.ok, arr(r.to).join(", ") || r.email)).join("")
    }</table></td></tr>`).join("")}
  ${reminders.length ? `<tr><td style="padding:17px 24px 0;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">
      Reminders · ${reminders.length}</td></tr>
    <tr><td style="padding:2px 24px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${
      reminders.map(r => line(`${r.shortId || ""} — ${r.rule || "Reminder"}`, r.store || "", r.ok, arr(r.to).join(", "))).join("")
    }</table></td></tr>` : ""}
  ${!total ? `<tr><td style="padding:16px 24px 8px"><div style="font-size:15px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:9px;padding:14px 16px">
      Nothing went out this morning.</div></td></tr>` : `<tr><td style="height:16px"></td></tr>`}`;

  const text = [
    `${total} email${total === 1 ? "" : "s"} sent${failed ? `, ${failed} FAILED` : ""}`,
    testMode ? "TEST MODE was on — everything went to the test addresses." : "", "",
    ...groups.map(g => [`${(KIND_PLURAL[g.k] || g.k).toUpperCase()} (${g.rows.length})`,
      ...g.rows.map(r => `  ${r.ok ? "sent  " : "FAILED"}  ${r.name || r.email} <${arr(r.to).join(", ") || r.email}>\n          ${r.subject}`), ""].join("\n")),
    reminders.length ? ["REMINDERS (" + reminders.length + ")",
      ...reminders.map(r => `  ${r.ok ? "sent  " : "FAILED"}  ${r.shortId || ""} — ${r.rule || "Reminder"} → ${arr(r.to).join(", ")}`), ""].join("\n") : "",
    `FixMi: ${appUrl}`,
  ].filter(x => x !== "").join("\n");

  return {
    subject: `FixMi Weekly Send Receipt — ${total} email${total === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}${testMode ? " (test mode)" : ""}`,
    html: shell(`${total} email${total === 1 ? "" : "s"} went out`, when || "", inner, "Weekly send receipt"),
    text,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   REMINDERS

   Some tickets are waiting on the store rather than on a technician — a
   headset exchange where the old units have to go back, a part that has to be
   returned. Nothing is broken, so nothing prompts anybody, and the first sign
   of trouble is an invoice. A reminder rule watches for those: match some
   words, wait a number of days, then nudge the people who can act.

   Rules are edited in Settings → Email, so a new one never needs a redeploy.
   ════════════════════════════════════════════════════════════════════════════ */

const REMINDER_ROLES = ["director", "dm", "gm", "tech", "reporter"];

function remindersFrom(raw) {
  return arr(raw).filter(r => r && typeof r === "object").map(r => ({
    id: String(r.id || "").trim() || "r" + Math.random().toString(36).slice(2, 9),
    name: String(r.name || "Reminder").trim(),
    on: r.on !== false,
    match: (Array.isArray(r.match) ? r.match : String(r.match || "").split(/[,\n]/))
      .map(x => lc(x)).filter(Boolean),
    days: Math.max(0, Number(r.days) || 0),
    repeatDays: Math.max(0, Number(r.repeatDays) || 0),
    to: (Array.isArray(r.to) ? r.to : []).filter(k => REMINDER_ROLES.includes(k)),
    message: String(r.message || "").trim(),
  })).filter(r => r.match.length && r.message && r.to.length);
}

/* Everything the rule could reasonably be looking for: what was typed when the
   ticket was raised, what it was filed under, and anything said since — the
   instruction about sending the old units back often arrives as a comment
   rather than in the original description. */
function ruleHaystack(ticket) {
  return lc([
    ticket.description, ticket.categoryLabel, ticket.category, ticket.subcategory,
    ...arr(ticket.comments).map(c => c && c.text),
  ].filter(Boolean).join("\n"));
}
function ruleMatches(rule, ticket) {
  const hay = ruleHaystack(ticket);
  return rule.match.some(phrase => hay.includes(phrase));
}

/** Which reminders are due right now, and who each one should go to. */
function dueReminders(master, prefs, nowTs) {
  const now = nowTs || Date.now();
  const out = [];
  const tickets = master.maintenanceTickets || {};
  remindersFrom(prefs.reminders).forEach(rule => {
    if (!rule.on) return;
    Object.entries(tickets).forEach(([id, t]) => {
      if (!t || !OPEN_STATUSES.includes(t.status)) return;          // closed ones are nobody's problem
      if (!ruleMatches(rule, t)) return;
      const ageDays = (now - (Number(t.createdAt) || now)) / 86400000;
      if (ageDays < rule.days) return;
      const last = Number((t.nudges || {})[rule.id]) || 0;
      if (last) {
        if (!rule.repeatDays) return;                                // once only, and it has been sent
        if ((now - last) / 86400000 < rule.repeatDays) return;       // not due again yet
      }
      const people = reminderPeople(master, t, rule, prefs);
      if (!people.length) return;
      out.push({ rule, id, ticket: { ...t, _id: id }, people });
    });
  });
  return out;
}

/** The rule picks roles; the store decides who fills them. */
function reminderPeople(master, ticket, rule, prefs) {
  const store = (master.restaurants || {})[ticket.storeId] || {};
  const seen = new Map();
  const put = (key, email, name, label) => {
    if (!rule.to.includes(key)) return;
    const e = lc(email);
    if (e && e.includes("@") && !seen.has(e)) seen.set(e, { email: e, name: name || e, role: label });
  };
  const dir = (master.directors || {})[store.assignedDirectorId];
  if (dir) put("director", dir.email, dir.name, "Director");
  storeCoachIds(store).forEach(cid => {
    const dm = (master.areaCoaches || {})[cid];
    if (dm) put("dm", dm.email, dm.name, "District Manager");
  });
  put("gm", store.email, store.storeManager || store.storeName, "General Manager");
  const tech = (master.repairTechnicians || {})[ticket.assignedTechId];
  if (tech) put("tech", tech.email, tech.name, "Assigned tech");
  const owner = (master.areaCoaches || {})[ticket.assignedCoachId];
  if (owner) put("dm", owner.email, owner.name, "Assigned District Manager");
  put("reporter", ticket.createdBy, ticket.createdByName, "Reported by");
  if (prefs && prefs.testMode) return seen.size ? prefs.testTo.map(e => ({ email: e, name: e, role: "Test" })) : [];
  return [...seen.values()];
}

/** The reminder email itself: the message first, the ticket underneath. */
function reminderBody(rule, store, ticket, cfg) {
  const url = `${cfg.appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticket._id || "")}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
  const facts = [
    ["Store", storeLabel(store)],
    ["Ticket", ticket.shortId || ""],
    ["Status", STATUS_LABEL[ticket.status] || ticket.status],
    ["Opened", ticket.createdAt ? `${fmtDay(ticket.createdAt)}  (${agePhrase(ticket.createdAt)})` : ""],
  ].filter(([, v]) => String(v || "").trim());

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#c2740a;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Reminder</td></tr>
  <tr><td style="padding:24px 24px 4px">
    <div style="font-size:18px;font-weight:700;line-height:1.45">${esc(rule.message)}</div>
    <div style="font-size:13.5px;color:#6b7280;margin-top:8px">${esc(storeLabel(store))} · opened ${esc(agePhrase(ticket.createdAt))}</div></td></tr>
  <tr><td style="padding:16px 24px 0"><table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7">
    ${facts.map(([k, v]) => `<tr><td style="color:#6b7280;padding-right:16px;white-space:nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
  </table></td></tr>
  <tr><td style="padding:16px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Issue</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">${esc(ticket.description || "No description")}</div></td></tr>
  <tr><td style="padding:20px 24px 24px">
    <a href="${esc(url)}" target="_blank" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">Open the ticket &rarr;</a>
    ${cfg.canReply ? `<div style="font-size:13px;color:#9ca3af;margin-top:12px">Reply to this email to add a comment.</div>` : ""}</td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af">
    Dossani Paradise · Repair &amp; Maintenance · reminder: ${esc(rule.name)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    rule.message, "",
    `${storeLabel(store)} · opened ${agePhrase(ticket.createdAt)}`, "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "", "ISSUE", ticket.description || "No description",
    "", `Open the ticket: ${url}`,
    ...(cfg.canReply ? ["", "Reply to this email to add a comment."] : []),
  ].join("\n");

  return { subject: `[${ticket.shortId || "Ticket"}] ${storeLabel(store)} — ${rule.name}`, html, text, url };
}

/* Everyone who should get a summary, and what each of them should see. Roles
   come from FindMi at send time, so a new GM is included the week they start. */
function summaryAudience(master, kind, prefs, donePool) {
  const stores = master.restaurants || {};
  const people = (prefs && prefs.people) || {};
  const optedOut = e => ((people[lc(e)] || {}).weekly === false);
  const out = [];
  if (kind === "gm") {
    Object.entries(stores).forEach(([sid, st]) => {
      if (lc(st.email).includes("@") && !optedOut(st.email)) out.push({ kind, email: lc(st.email), name: st.storeManager || storeLabel(st), storeId: sid, store: st });
    });
  } else if (kind === "dm") {
    Object.entries(master.areaCoaches || {}).forEach(([id, c]) => {
      if (!lc(c.email).includes("@") || optedOut(c.email)) return;
      const storeIds = Object.keys(stores).filter(sid => storeCoachIds(stores[sid]).includes(id));
      if (storeIds.length) out.push({ kind, email: lc(c.email), name: c.name || c.email, storeIds });
    });
  } else if (kind === "ow") {
    // Overwatch sees the same company-wide picture the VPs get.
    Object.values(master.admins || {}).forEach(a => {
      if (a && lc(a.email).includes("@") && !optedOut(a.email))
        out.push({ kind, email: lc(a.email), name: a.name || a.email, storeIds: Object.keys(stores) });
    });
  } else if (kind === "vp") {
    ((prefs && prefs.vpTo) || []).forEach(e => {
      if (lc(e).includes("@") && !optedOut(e)) out.push({ kind, email: lc(e), name: e, storeIds: Object.keys(stores) });
    });
  } else if (kind === "tech") {
    /* A technician's week is their own worklist: the tickets dispatched to
       them by name, wherever those happen to be. Anyone with nothing assigned
       is left out rather than sent an empty page. */
    Object.entries(master.repairTechnicians || {}).forEach(([id, t]) => {
      if (!lc(t.email).includes("@") || optedOut(t.email)) return;
      const tickets = Object.entries(master.maintenanceTickets || {})
        .filter(([, tk]) => tk && tk.assignedTechId === id && OPEN_STATUSES.includes(tk.status));
      if (tickets.length) out.push({ kind, email: lc(t.email), name: t.name || t.email, techId: id,
        lastWeek: donePool ? lastWeekFor(id, donePool) : null });
    });
  } else if (kind === "do") {
    Object.entries(master.directors || {}).forEach(([id, d]) => {
      if (!lc(d.email).includes("@") || optedOut(d.email)) return;
      const storeIds = Object.keys(stores).filter(sid => stores[sid].assignedDirectorId === id);
      if (storeIds.length) out.push({ kind, email: lc(d.email), name: d.name || d.email, storeIds });
    });
  }
  return out;
}

function buildSummary(master, person, cfg) {
  if (person.kind === "vp" || person.kind === "ow") return summaryVP(master, person, cfg);
  if (person.kind === "gm") return summaryGM(master, person, cfg);
  if (person.kind === "dm") return summaryDM(master, person, cfg);
  if (person.kind === "tech") return summaryTech(master, person, cfg);
  return summaryDO(master, person, cfg);
}

/* A stand-in used by the "send me a test" buttons, so a summary can be seen
   even by someone who isn't a GM anywhere. Picks the busiest real store /
   patch, so the test looks like the real thing rather than an empty shell. */
function sampleAudience(master, kind, email, prefs, donePool) {
  // VP and Overwatch are company-wide, so anyone can preview them as themselves.
  if (kind === "vp" || kind === "ow") return { kind, email: lc(email), name: email, storeIds: Object.keys(master.restaurants || {}) };
  const real = summaryAudience(master, kind, prefs, donePool);
  const mine = real.find(p => p.email === lc(email));
  if (mine) return { ...mine, email: lc(email) };
  const busiest = real.map(p => ({
    p, n: p.kind === "tech" ? techTickets(master, p.techId).length
      : (p.kind === "gm" ? [p.storeId] : p.storeIds).reduce((n, sid) => n + openTicketsFor(master, sid).length, 0),
  })).sort((a, b) => b.n - a.n)[0];
  if (busiest) return { ...busiest.p, email: lc(email), sample: true };
  return null;
}

module.exports = async (req, res) => {
  const allow = process.env.FIXMI_ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { secret, event, ticketId, ticket: sent, prevStatus, actorEmail, actorName, comment, assigneeChanged, assignee, thread } = body;

    const want = process.env.FIXMI_SHARED_SECRET || "";
    if (!want) return res.status(500).json({ error: "FIXMI_SHARED_SECRET is not set on the server" });
    if (secret !== want) return res.status(401).json({ error: "bad secret" });
    const DIAG = ["selftest", "sendtest", "postmark", "summary", "reminders", "digest"];
    if (!EVENTS.includes(event) && !DIAG.includes(event)) return res.status(400).json({ error: `event must be one of ${EVENTS.join(", ")}` });
    if (!ticketId && !DIAG.includes(event)) return res.status(400).json({ error: "ticketId is required" });

    const cfg = {
      token: process.env.POSTMARK_TOKEN || "",
      from: process.env.FIXMI_FROM || DEFAULTS.from,
      appUrl: process.env.FIXMI_APP_URL || DEFAULTS.appUrl,
      masterUrl: process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl,
      stream: process.env.FIXMI_STREAM || DEFAULTS.stream,
      replyDomain: process.env.FIXMI_REPLY_DOMAIN || "",
      dryRun: process.env.FIXMI_DRY_RUN === "1",
    };
    if (!cfg.token && !cfg.dryRun && event !== "selftest" && event !== "postmark") return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
    if (process.env.FIXMI_NOTIFY_OFF === "1" && !DIAG.includes(event)) return res.status(200).json({ sent: 0, reason: "notifications switched off" });

    /* The master is the source of truth for WHO gets mailed. The ticket body may
       come from the caller because the CDN copy can lag a minute behind a write.
       `_master` lets /api/inbound hand over the copy it has already downloaded —
       it is only honoured behind the shared secret, checked just above, and it
       saves a second multi-megabyte download on the reply path. */
    let master;
    if (body._master && typeof body._master === "object") {
      master = body._master;
    } else {
      const r = await readMaster(cfg.masterUrl);
      if (!r.ok) return res.status(502).json({ error: `could not read the alignment master (HTTP ${r.status})` });
      master = await r.json();
    }

    /* ---- DIAGNOSTICS -------------------------------------------------------
       "selftest" reports how this function is configured and who a given ticket
       would reach. It never contacts Postmark. "sendtest" sends one real email,
       but only to an address the master already knows or that is listed in
       Settings → Email — so this can't be turned into a way to mail strangers. */
    if (event === "selftest") {
      const prefs0 = prefsFrom(master);
      /* Probe the other two endpoints from here rather than from the browser:
         no CORS to arrange, and it proves they answer on the public URL that
         Postmark and the buttons in an email will actually use. */
      const self = (process.env.FIXMI_SELF_URL || `https://${req.headers.host || ""}`).replace(/\/$/, "");
      const probe = async (path) => {
        try {
          const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000);
          const r2 = await fetch(`${self}${path}`, { signal: c.signal });
          clearTimeout(t);
          return { status: r2.status };
        } catch (e) { return { status: 0, error: (e && e.message) || String(e) }; }
      };
      const [answerProbe, weeklyProbe] = await Promise.all([probe("/api/answer"), probe("/api/weekly")]);
      const wk = ((master.admins || {}).notifyPrefs || {}).weekly || {};

      const out = {
        ok: true,
        tokenPresent: !!cfg.token,
        selfUrl: self,
        selfUrlSet: !!process.env.FIXMI_SELF_URL,
        endpoints: { answer: answerProbe, weekly: weeklyProbe },
        weekly: {
          on: !!wk.on,
          day: wk.day || "monday",
          kinds: Array.isArray(wk.kinds) && wk.kinds.length ? wk.kinds : ["gm", "dm", "do"],
          lastSentYmd: wk.lastSentYmd || "",
          lastSentAt: wk.lastSentAt || 0,
        },
        writePassPresent: !!process.env.FIXMI_WRITE_PASSWORD,
        dryRun: cfg.dryRun,
        notifyOff: process.env.FIXMI_NOTIFY_OFF === "1",
        from: cfg.from,
        appUrl: cfg.appUrl,
        stream: cfg.stream,
        allowOrigin: process.env.FIXMI_ALLOW_ORIGIN || "*",
        masterOk: true,
        ticketsSeen: Object.keys(master.maintenanceTickets || {}).length,
        prefsFound: !!(master.admins || {}).notifyPrefs,
        prefs: { on: prefs0.on, testMode: prefs0.testMode, testTo: prefs0.testTo, alwaysTo: prefs0.alwaysTo, roles: prefs0.roles },
        overrides: Object.keys(prefs0.people || {}),
        reply: {
          enabled: !!cfg.replyDomain,
          domain: cfg.replyDomain || null,
          sample: cfg.replyDomain && ticketId ? `reply+${ticketId}@${cfg.replyDomain}` : null,
        },
      };
      if (ticketId) {
        const t = { ...((master.maintenanceTickets || {})[ticketId] || {}), ...(sent || {}), _id: ticketId };
        const st = (master.restaurants || {})[t.storeId] || {};
        out.ticket = {
          id: ticketId, shortId: t.shortId || null, store: storeLabel(st),
          knownToMaster: !!(master.maintenanceTickets || {})[ticketId],
          subject: t.storeId ? subjectFor(st, t) : null,
          recipients: t.storeId ? recipientsFor(master, t, { prefs: prefs0, event: EVENTS.includes(body.forEvent) ? body.forEvent : "created", actorEmail }) : [],
        };
      }
      return res.status(200).json(out);
    }

    /* "postmark" asks Postmark itself how this server is set up, so the checker
       can say whether the inbound stream really points back at us — the one
       thing we cannot see from our own side. The token never leaves here, and
       Postmark's copy of it is stripped from the reply. */
    if (event === "postmark") {
      if (!cfg.token) return res.status(200).json({ ok: false, reason: "POSTMARK_TOKEN is not set in Vercel" });
      const H = { "Accept": "application/json", "X-Postmark-Server-Token": cfg.token };
      let srv = null, srvStatus = 0;
      try {
        const s1 = await fetch("https://api.postmarkapp.com/server", { headers: H });
        srvStatus = s1.status;
        srv = await s1.json().catch(() => null);
      } catch (e) {
        return res.status(200).json({ ok: false, reason: `could not reach Postmark (${(e && e.message) || e})` });
      }
      if (srvStatus === 401) return res.status(200).json({ ok: false, reason: "Postmark rejected the token — POSTMARK_TOKEN is wrong, or it is an Account token rather than this server's token" });
      if (srvStatus !== 200 || !srv) return res.status(200).json({ ok: false, reason: `Postmark answered HTTP ${srvStatus}` });

      // Recent inbound, so the checker can show whether any mail has actually landed.
      let inbound = null;
      try {
        const s2 = await fetch("https://api.postmarkapp.com/messages/inbound?count=5&offset=0", { headers: H });
        const j2 = await s2.json().catch(() => null);
        if (s2.ok && j2) inbound = {
          total: j2.TotalCount || 0,
          recent: arr(j2.InboundMessages).slice(0, 5).map(m => ({
            from: m.From, subject: m.Subject, status: m.Status,
            at: m.ReceivedAt, hash: m.MailboxHash || "",
          })),
        };
      } catch (e) { /* a missing inbound list is not fatal */ }

      return res.status(200).json({
        ok: true,
        serverName: srv.Name || "",
        // never echo ApiTokens back to a browser
        inboundHookUrl: srv.InboundHookUrl || "",
        inboundDomain: srv.InboundDomain || "",
        inboundAddress: srv.InboundAddress || "",
        inboundSpamThreshold: srv.InboundSpamThreshold,
        bounceHookUrl: srv.BounceHookUrl || "",
        expectedReplyDomain: cfg.replyDomain || "",
        inbound,
      });
    }

    /* ---- WEEKLY SUMMARIES --------------------------------------------------
       mode "preview" builds one and hands back the HTML without sending.
       mode "test" sends one to addresses FixMi already knows.
       mode "run"  sends the real thing to everyone, honouring test mode. */
    if (event === "summary") {
      const prefs0 = prefsFrom(master);
      const mode = body.mode || "preview";
      const kind = SUMMARY_KINDS.includes(body.kind) ? body.kind : "gm";
      /* Only the technician summary looks back at last week, and only it needs
         the closed set — so the extra call is made only when one is in play. */
      const wantsTech = mode === "run"
        ? (arr(body.kinds).length ? arr(body.kinds) : ["gm", "dm", "do", "vp"]).includes("tech")
        : kind === "tech";
      const donePool = wantsTech
        ? { ...(master.maintenanceTickets || {}), ...(await fetchClosed(cfg.masterUrl) || {}) }
        : null;
      const sCfg = {
        appUrl: cfg.appUrl,
        selfUrl: (process.env.FIXMI_SELF_URL || `https://${req.headers.host || ""}`).replace(/\/$/, ""),
        stamp: todayStamp(),          // signed into every answer link, so each send is its own
      };

      if (mode === "preview" || mode === "test") {
        const who = sampleAudience(master, kind, body.to || (arr(body.to)[0]) || "preview@example.com", prefs0, donePool);
        if (!who) return res.status(200).json({ ok: false, reason: kind === "vp"
          ? "add at least one address to the VP list in Settings → Email"
          : `there are no ${kind.toUpperCase()}s with an email address in FindMi yet` });
        const built = buildSummary(master, who, sCfg);
        if (mode === "preview") return res.status(200).json({ ok: true, kind, sample: !!who.sample, forName: who.name, ...built });

        const known = knownAddresses(master, prefs0);
        const to = [...new Set(arr(body.to).map(lc).filter(e => e.includes("@")))].filter(e => known.has(e));
        if (!to.length) return res.status(400).json({ error: "the test address has to be someone FixMi already knows, or a test address from Settings → Email" });
        if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
        const r2 = await sendBatch(cfg, to.map(e => ({
          From: `FixMi <${cfg.from}>`, To: e,
          Subject: built.subject, HtmlBody: built.html, TextBody: built.text,
          MessageStream: cfg.stream, Tag: `summary-${kind}`, TrackOpens: false, TrackLinks: "None",
        })));
        return res.status(200).json({ ok: r2.ok, kind, to, sample: !!who.sample, forName: who.name, subject: built.subject, detail: r2.failed });
      }

      /* mode "one" — this person's own summary, right now, off-schedule. Their
         weekly opt-out is ignored on purpose: somebody chose them by name and
         pressed send, which is a more specific instruction than a standing
         preference. Test mode still applies, so this can't surprise anyone. */
      if (mode === "one") {
        const to = lc(body.to);
        const list = summaryAudience(master, kind, {}, donePool);   // {} = ignore opt-outs
        let who = list.find(p => p.email === to);
        if (!who && (kind === "vp" || kind === "ow")) who = { kind, email: to, name: to, storeIds: Object.keys(master.restaurants || {}) };
        if (!who) return res.status(200).json({ ok: false, reason: `${to || "that address"} isn't a ${kind.toUpperCase()} FixMi knows about` });
        if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
        const built = buildSummary(master, who, sCfg);
        const targets = prefs0.testMode ? prefs0.testTo : [who.email];
        if (!targets.length) return res.status(200).json({ ok: false, reason: "test mode is on but no test addresses are set" });
        const r1 = await sendBatch(cfg, targets.map(addr => ({
          From: `FixMi <${cfg.from}>`, To: addr,
          Subject: prefs0.testMode ? `${built.subject}  →  ${who.name}` : built.subject,
          HtmlBody: prefs0.testMode ? testBanner(who, built.html) : built.html,
          TextBody: (prefs0.testMode ? `TEST MODE — live, this would have gone to ${who.name} <${who.email}>.\n\n` : "") + built.text,
          MessageStream: cfg.stream, Tag: `summary-${kind}`, TrackOpens: false, TrackLinks: "None",
        })));
        console.log("[fixmi-notify] one-off summary", kind, who.email, "→", targets.join(", "));
        return res.status(200).json({ ok: r1.ok, kind, forName: who.name, forEmail: who.email, to: targets, testMode: prefs0.testMode, subject: built.subject, failed: r1.failed });
      }

      // mode "run" — the real weekly send
      if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
      const kinds = arr(body.kinds).length ? arr(body.kinds).filter(k => SUMMARY_KINDS.includes(k)) : ["gm", "dm", "do", "vp"];
      const messages = [], log = [], manifest = [];
      kinds.forEach(k => {
        summaryAudience(master, k, prefs0, donePool).forEach(person => {
          const built = buildSummary(master, person, sCfg);
          manifest.push({ kind: k, name: person.name, email: person.email, subject: built.subject });
          // Test mode: everything goes to the test addresses instead, and says
          // whose summary it is so a pile of them is still readable.
          const targets = prefs0.testMode ? prefs0.testTo : [person.email];
          targets.forEach(addr => messages.push({
            From: `FixMi <${cfg.from}>`, To: addr,
            Subject: prefs0.testMode ? `${built.subject}  →  ${person.name}` : built.subject,
            HtmlBody: prefs0.testMode ? testBanner(person, built.html) : built.html,
            TextBody: (prefs0.testMode ? `TEST MODE — live, this would have gone to ${person.name} <${person.email}>.\n\n` : "") + built.text,
            MessageStream: cfg.stream, Tag: `summary-${k}`, TrackOpens: false, TrackLinks: "None",
          }));
          log.push(`${k}:${person.email}`);
        });
      });
      if (!messages.length) return res.status(200).json({ ok: true, sent: 0, reason:
        kinds.length === 1 && kinds[0] === "vp"
          ? "the VP list is empty — add the addresses in Settings → Email"
          : "nobody to send to — check that these people have email addresses in FindMi, and that nobody has been opted out" });
      if (prefs0.testMode && !prefs0.testTo.length) return res.status(200).json({ ok: false, sent: 0, reason: "test mode is on but no test addresses are set" });
      const r3 = await sendBatch(cfg, messages);
      /* One manifest row per PERSON, not per message: in test mode one person's
         summary becomes several messages, and the receipt should still read as
         a list of who was covered. A person counts as delivered when every
         message carrying their summary went out. */
      let mi = 0;
      manifest.forEach(row => {
        const n = prefs0.testMode ? Math.max(1, prefs0.testTo.length) : 1;
        const slice = r3.perMessage.slice(mi, mi + n); mi += n;
        row.to = messages.slice(mi - n, mi).map(m => m.To);
        row.ok = slice.length > 0 && slice.every(x => x.ok);
      });
      console.log("[fixmi-notify] weekly summaries", { testMode: prefs0.testMode, built: log.length, sent: r3.sent });
      return res.status(200).json({ ok: r3.ok, sent: r3.sent, testMode: prefs0.testMode, people: log, failed: r3.failed, manifest });
    }

    /* ---- THE RECEIPT -------------------------------------------------------
       Posted by the weekly clock once the morning's sending is done, with the
       manifests the summary and reminder passes handed back. It is a report on
       what already happened, so it never re-sends anything and it goes out even
       when the run was in test mode — that is exactly when you want to read it.
       mode "preview" builds it without sending, for the button in Settings. */
    if (event === "digest") {
      const prefs0 = prefsFrom(master);
      let summaries = arr(body.summaries).filter(r => r && typeof r === "object");
      let reminders = arr(body.reminders).filter(r => r && typeof r === "object");
      /* A preview with no manifest behind it builds one from the people who
         WOULD be emailed on the next run, so what you are looking at is this
         Monday's receipt rather than a mock-up with invented names. */
      if (body.mode === "preview" && !summaries.length) {
        const dCfg = {
          appUrl: cfg.appUrl,
          selfUrl: (process.env.FIXMI_SELF_URL || `https://${req.headers.host || ""}`).replace(/\/$/, ""),
          stamp: todayStamp(),
        };
        const saved = ((master.admins || {}).notifyPrefs || {}).weekly || {};
        const asked = arr(body.dryKinds).filter(k => SUMMARY_KINDS.includes(k));
        const kinds = asked.length ? asked
          : (arr(saved.kinds).filter(k => SUMMARY_KINDS.includes(k)));
        (kinds.length ? kinds : ["gm", "dm", "do", "vp"]).forEach(k => {
          summaryAudience(master, k, prefs0).forEach(person => summaries.push({
            kind: k, name: person.name, email: person.email, to: [person.email], ok: true,
            subject: buildSummary(master, person, dCfg).subject,
          }));
        });
        if (!reminders.length) {
          reminders = dueReminders(master, prefs0, Date.now()).map(d => ({
            rule: d.rule.name, shortId: d.ticket.shortId || d.id,
            store: storeLabel((master.restaurants || {})[d.ticket.storeId] || {}),
            to: d.people.map(x => x.email), ok: true,
          }));
        }
      }
      const built = digestBody({
        summaries, reminders,
        testMode: !!body.testMode,
        when: body.when || new Date().toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
        appUrl: cfg.appUrl,
      });
      const to = digestAudience(master, prefs0);
      if (body.mode === "preview") return res.status(200).json({ ok: true, preview: true, to, ...built });
      if (!to.length) return res.status(200).json({ ok: true, sent: 0, reason: "no receipt address is set — add one in Settings → Email" });
      if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
      const r4 = await sendBatch(cfg, to.map(addr => ({
        From: `FixMi <${cfg.from}>`, To: addr, Subject: built.subject,
        HtmlBody: built.html, TextBody: built.text,
        MessageStream: cfg.stream, Tag: "weekly-receipt", TrackOpens: false, TrackLinks: "None",
      })));
      console.log("[fixmi-notify] weekly receipt →", to.join(", "), r4.sent, "sent");
      return res.status(200).json({ ok: r4.ok, sent: r4.sent, to, subject: built.subject, failed: r4.failed });
    }

    /* ---- REMINDERS ---------------------------------------------------------
       mode "due" just reports what would go out; anything else sends it. The
       caller writes the "already nudged" stamps back onto the tickets, since
       it is the one holding the write password. */
    if (event === "reminders") {
      const prefs0 = prefsFrom(master);
      const rCfg = { appUrl: cfg.appUrl, canReply: !!cfg.replyDomain };
      const due = dueReminders(master, prefs0, Number(body.now) || Date.now());
      const rows = due.map(d => ({
        rule: d.rule.name, ruleId: d.rule.id, ticketId: d.id,
        shortId: d.ticket.shortId || d.id,
        store: storeLabel((master.restaurants || {})[d.ticket.storeId] || {}),
        openFor: agePhrase(d.ticket.createdAt),
        to: d.people.map(p => p.email),
        ok: false,                       // set below once Postmark has answered
      }));
      if (body.mode === "due" || !prefs0.on) {
        return res.status(200).json({ ok: true, due: rows, sent: 0,
          ...(prefs0.on ? {} : { reason: "notifications are switched off in Settings → Email" }) });
      }
      if (!due.length) return res.status(200).json({ ok: true, due: [], sent: 0, reason: "nothing is due" });
      if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });

      const messages = [], owner = [];         // owner[i] is the due item message i belongs to
      due.forEach((d, di) => {
        const store = (master.restaurants || {})[d.ticket.storeId] || {};
        const built = reminderBody(d.rule, store, d.ticket, rCfg);
        const thread = `<fixmi-${d.id}@dossaniparadise.com>`;   // sits in the ticket's own thread
        d.people.forEach(p => { owner.push(di); messages.push({
          From: `FixMi <${cfg.from}>`,
          To: `"${String(p.name).replace(/"/g, "")}" <${p.email}>`,
          ...(cfg.replyDomain ? { ReplyTo: `reply+${d.id}@${cfg.replyDomain}` } : {}),
          Subject: built.subject, HtmlBody: built.html, TextBody: built.text,
          MessageStream: cfg.stream, Tag: "reminder",
          Headers: [{ Name: "In-Reply-To", Value: thread }, { Name: "References", Value: thread }],
          Metadata: { ticketId: d.id, rule: d.rule.id },
          TrackOpens: false, TrackLinks: "None",
        }); });
      });
      const rr = await sendBatch(cfg, messages);

      /* Stamp the tickets here rather than leaving it to whoever called, so a
         reminder sent by hand from Settings counts the same as one sent by the
         nightly run — otherwise the same nudge goes out again a few hours
         later. Only tickets that actually got an email are stamped. */
      const landed = new Set();
      rr.perMessage.forEach((m, i) => { if (m.ok && owner[i] !== undefined) landed.add(owner[i]); });
      // A rule counts as sent once every nudge it produced went out.
      due.forEach((d, di) => {
        const mine = rr.perMessage.filter((m, i) => owner[i] === di);
        rows[di].ok = mine.length > 0 && mine.every(m => m.ok);
      });
      let stamped = 0, stampError = null;
      const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
      if (landed.size && writePass) {
        const updates = {};
        [...landed].forEach(di => {
          const d = due[di];
          const base = updates[`${"maintenanceTickets"}/${d.id}`] || (master.maintenanceTickets || {})[d.id];
          if (!base) return;
          updates[`maintenanceTickets/${d.id}`] = {
            ...base,
            nudges: { ...(base.nudges || {}), [d.rule.id]: Date.now() },
            activity: [...(Array.isArray(base.activity) ? base.activity : []),
              { ts: Date.now(), by: "FixMi", role: "system", action: "reminder", note: `Reminder sent — ${d.rule.name}` }],
          };
        });
        if (Object.keys(updates).length) {
          try {
            const w = await fetch(cfg.masterUrl, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password: writePass, updates }),
            });
            if (w.ok) { stamped = Object.keys(updates).length; Object.entries(updates).forEach(([k, v]) => { master.maintenanceTickets[k.split("/")[1]] = v; }); }
            else stampError = `HTTP ${w.status}`;
          } catch (e) { stampError = (e && e.message) || String(e); }
        }
      } else if (landed.size && !writePass) {
        stampError = "FIXMI_WRITE_PASSWORD is not set, so these will go out again";
      }

      console.log("[fixmi-notify] reminders", { due: due.length, sent: rr.sent, stamped, testMode: prefs0.testMode });
      return res.status(200).json({ ok: rr.ok, sent: rr.sent, stamped, stampError, testMode: prefs0.testMode, due: rows, failed: rr.failed });
    }

    if (event === "sendtest") {
      const prefs0 = prefsFrom(master);
      const known = knownAddresses(master, prefs0);
      const to = [...new Set(arr(body.to).map(lc).filter(e => e.includes("@")))].filter(e => known.has(e));
      if (!to.length) return res.status(400).json({ error: "the test address has to be someone FixMi already knows, or a test address from Settings → Email" });
      if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
      const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
      const pm0 = await fetch("https://api.postmarkapp.com/email/batch", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.token },
        body: JSON.stringify(to.map(e => ({
          From: `FixMi <${cfg.from}>`, To: e,
          Subject: "FixMi connection test",
          TextBody: `This is a FixMi connection test sent ${when}.\n\nIf you are reading this, the whole chain works: FixMi reached the notifier, the notifier reached Postmark, and Postmark delivered as ${cfg.from}.\n\nNo ticket was involved.`,
          HtmlBody: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827"><p><b>FixMi connection test</b> — sent ${esc(when)}.</p><p>If you are reading this, the whole chain works: FixMi reached the notifier, the notifier reached Postmark, and Postmark delivered as ${esc(cfg.from)}.</p><p style="color:#6b7280">No ticket was involved.</p></div>`,
          MessageStream: cfg.stream, Tag: "connection-test", TrackOpens: false, TrackLinks: "None",
        }))),
      });
      const out = await pm0.json().catch(() => []);
      const list = Array.isArray(out) ? out : [out];
      const failed = list.filter(x => x && x.ErrorCode);
      if (!pm0.ok || failed.length) {
        console.error("[fixmi-notify] connection test failed", pm0.status, list);
        return res.status(200).json({ ok: false, sent: 0, status: pm0.status, to, detail: failed.length ? failed : list });
      }
      return res.status(200).json({ ok: true, sent: list.length, to });
    }

    /* The caller just wrote this ticket, so ITS copy wins. The master is served
       through a CDN that lags up to a minute, and for a brand-new ticket it
       usually has nothing at all — which is exactly why the first emails went
       out with no description, category, photos or reporter. Blank values never
       overwrite a good one from the master. */
    const fromMaster = (master.maintenanceTickets || {})[ticketId];
    const fresh = {};
    Object.entries(sent || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") fresh[k] = v;
    });
    const ticket = { ...(fromMaster || {}), ...fresh, _id: ticketId };
    if (!ticket.storeId) return res.status(404).json({ error: "ticket has no storeId — is the id right?" });

    const prefs = prefsFrom(master);
    if (!prefs.on) return res.status(200).json({ sent: 0, reason: "notifications are switched off in Settings → Email" });

    const store = (master.restaurants || {})[ticket.storeId] || {};
    const people = recipientsFor(master, ticket, { prefs, event, actorEmail });
    // In test mode, say inside the email who it WOULD have gone to — more use
    // than a [TEST] tag in the subject, and it leaves threading alone.
    const wouldHaveGoneTo = prefs.testMode
      ? recipientsFor(master, ticket, { prefs: { ...prefs, testMode: false }, event, actorEmail }).map(x => `${x.email} (${x.role})`)
      : null;
    if (!people.length) return res.status(200).json({
      sent: 0,
      reason: !prefs.testMode
        ? "nobody is set to receive this event — check Settings → Email, and that these people have emails in FindMi"
        : (wouldHaveGoneTo && wouldHaveGoneTo.length)
          ? "test mode is on but no test addresses are set"
          : `nobody would receive this even with test mode off — the boxes for this event, or for ${PRIORITY_LABEL[lc(ticket.priority) || "normal"] || "this"} priority, are unticked`,
    });

    const { html, text, url } = bodyFor({ event, store, ticket, prevStatus, appUrl: cfg.appUrl, actorName, comment, wouldHaveGoneTo, extra: { assigneeChanged, assignee }, thread, canReply: !!cfg.replyDomain });
    const subject = subjectFor(store, ticket);   // no [TEST] prefix: it would split the thread when test mode is turned off
    const threadId = `<fixmi-${ticketId}@dossaniparadise.com>`;    // same on every mail about this ticket → clients thread them

    const messages = people.map(p => ({
      From: `FixMi <${cfg.from}>`,
      To: `"${String(p.name).replace(/"/g, "")}" <${p.email}>`,
      // Replies go to reply+<ticket id>@… so Postmark can tell us, on the way
      // back in, which ticket the reply belongs to. Unset until inbound is on.
      ...(cfg.replyDomain ? { ReplyTo: `reply+${ticketId}@${cfg.replyDomain}` } : {}),
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: cfg.stream,
      Tag: `ticket-${event}`,
      Headers: [{ Name: "In-Reply-To", Value: threadId }, { Name: "References", Value: threadId }],
      Metadata: { ticketId, shortId: String(ticket.shortId || ""), event },
      TrackOpens: false,
      TrackLinks: "None",
    }));

    if (cfg.dryRun) {
      console.log("[fixmi-notify] DRY RUN", { event, subject, url, to: people });
      return res.status(200).json({ sent: 0, dryRun: true, testMode: prefs.testMode, subject, to: people.map(p => p.email) });
    }

    const pm = await fetch("https://api.postmarkapp.com/email/batch", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.token },
      body: JSON.stringify(messages),
    });
    const results = await pm.json().catch(() => []);
    if (!pm.ok) {
      console.error("[fixmi-notify] Postmark rejected the call", pm.status, results);
      return res.status(502).json({ error: "Postmark rejected the call", status: pm.status, detail: results });
    }
    // /batch answers 200 even when individual messages fail — inspect each one.
    const list = Array.isArray(results) ? results : [];
    const failed = list.filter(x => x && x.ErrorCode);
    if (failed.length) console.error("[fixmi-notify] some messages failed", failed);
    return res.status(200).json({
      sent: list.length - failed.length,
      failed: failed.map((f, i) => ({ to: (people[i] || {}).email, code: f.ErrorCode, message: f.Message })),
      to: people.map(p => p.email),
      testMode: prefs.testMode,
      subject,
    });
  } catch (e) {
    console.error("[fixmi-notify] crashed", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.storeZones = storeZones;
module.exports.readMaster = readMaster;
module.exports.recipientsFor = recipientsFor;
module.exports.prefsFrom = prefsFrom;
module.exports.bodyFor = bodyFor;
module.exports.subjectFor = subjectFor;
module.exports.storeLabel = storeLabel;
module.exports.headlineFor = headlineFor;
