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
           tech: { created: false, status: false, comment: false }, reporter: { created: false, status: false, comment: false } },
  testMode: false, testTo: [], alwaysTo: [],
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
    if (raw.people && typeof raw.people === "object") {
      Object.entries(raw.people).forEach(([em, v]) => {
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
    ["testTo", "alwaysTo"].forEach(k => {
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
  put(ticket.createdBy, ticket.createdByName, "Reported by", "reporter");

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
function headlineFor(event, store, ticket, prevStatus, comment, extra) {
  const who = storeLabel(store);
  if (event === "created") return `${who} has a new ticket open.`;
  if (event === "comment") return `${who} — new comment from ${(comment && comment.by) || "someone"}.`;

  const assignee = (extra && extra.assignee) || ticket.assigneeLabel || "";
  // Who it's on beats which column it sits in — lead with that when it changed.
  if (extra && extra.assigneeChanged) {
    return assignee
      ? `${who} — ticket assigned to ${assignee}.`
      : `${who} — ticket put back in the unassigned pool.`;
  }
  switch (ticket.status) {
    case "closed":      return `${who} — ticket closed.`;
    case "finished":    return `${who} — work finished.`;
    case "in_progress": return `${who} — work started.`;
    // The reasons are already phrased as "Awaiting parts" — lowercasing them
    // into "waiting on awaiting parts" reads like a stutter.
    case "waiting":     return `${who} — on hold${ticket.waitingReason ? " — " + ticket.waitingReason : ""}.`;
    case "unassigned":  return `${who} — ticket put back in the unassigned pool.`;
    case "assigned":
    case "dispatched":  return assignee ? `${who} — ticket is with ${assignee}.` : `${who} — ticket dispatched.`;
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
        ${ph.length ? `<div style="margin-top:8px">${ph.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="120" alt="" style="width:120px;border-radius:6px;border:1px solid #e5e7eb;display:inline-block;margin:0 6px 6px 0"></a>`).join("")}</div>` : ""}
      </div></td></tr>`;
  }).join("");
  // The new comment, big, directly under the headline — no scrolling for it.
  const newCommentBlock = comment ? `<tr><td style="padding:4px 24px 0">
    <div style="border-left:4px solid #1d76bb;background:#eff6ff;border-radius:0 9px 9px 0;padding:12px 16px">
      <div style="font-size:12px;font-weight:700;color:#1d76bb;text-transform:uppercase;letter-spacing:.06em">New comment · ${esc(comment.by || "")}${comment.ts ? " · " + esc(fmtWhen(comment.ts)) : ""}</div>
      ${comment.text ? `<div style="font-size:16px;line-height:1.55;white-space:pre-wrap;margin-top:6px">${esc(comment.text)}</div>` : ""}
      ${cPhotos.length ? `<div style="margin-top:10px">${cPhotos.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="160" alt="Comment photo" style="width:160px;max-width:100%;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</div>` : ""}
    </div></td></tr>` : "";
  const facts = [
    ["Store", storeLabel(store)],
    ["Status", STATUS_LABEL[ticket.status] || ticket.status],
    ["Priority", ticket.priority ? (PRIORITY_LABEL[ticket.priority] || ticket.priority) : "Normal"],
    ["Category", ticket.categoryLabel || [ticket.category, ticket.subcategory].filter(Boolean).join(" › ")],
    ["Assigned to", assignee],
    ticket.status === "waiting" ? ["Waiting on", ticket.waitingReason] : null,
    ["Reported by", ticket.createdByName || ticket.createdBy],
    ["Opened", ticket.createdAt ? `${fmtDay(ticket.createdAt)}  (${ageOf(ticket.createdAt)} ago)` : ""],
    event === "created" ? null : [event === "comment" ? "Comment by" : "Changed by", (comment && comment.by) || actorName],
  ].filter(Boolean).filter(([, v]) => String(v == null ? "" : v).trim() !== "");   // a blank row is noise, not "—"

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Ticket ${esc(ticket.shortId || "")}</td></tr>
  ${wouldHaveGoneTo ? `<tr><td style="background:#fffbeb;border-bottom:1px solid #fde68a;padding:11px 24px;font-size:12.5px;color:#92400e">
    <b>Test mode.</b> Nobody else received this. Live, it would have gone to: ${esc(wouldHaveGoneTo.join(", ") || "nobody")}.</td></tr>` : ""}
  <tr><td style="padding:24px 24px 6px"><div style="font-size:19px;font-weight:700;line-height:1.35">${esc(headline)}</div>
    <div style="font-size:14px;color:#6b7280;margin-top:6px">See details below.</div></td></tr>
  ${newCommentBlock}
  <tr><td style="padding:14px 24px 0"><table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7">
    ${facts.map(([k, v]) => `<tr><td style="color:#6b7280;padding-right:16px;white-space:nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
  </table></td></tr>
  <tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Issue${ticket.createdAt ? ` <span style="font-weight:400;text-transform:none;letter-spacing:0">· ${esc(ticket.createdByName || ticket.createdBy || "")} · ${esc(fmtDay(ticket.createdAt))}</span>` : ""}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">${esc(ticket.description || "No description")}</div></td></tr>
  ${photos.length ? `<tr><td style="padding:14px 24px 0">${photos.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="160" alt="Ticket photo" style="width:160px;max-width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</td></tr>` : ""}
  ${closeNote ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Closing notes · ${esc(closeNote.by || "")}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px">${esc(closeNote.text)}</div>
  </td></tr>` : ""}
  ${convoHtml ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Conversation · ${convo.length} comment${convo.length === 1 ? "" : "s"}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${convoHtml}</table>
  </td></tr>` : ""}
  ${canReply ? `<tr><td style="padding:18px 24px 0"><div style="font-size:13px;color:#6b7280;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:11px 14px">
    <b style="color:#111827">You can just reply to this email.</b> Your reply is added to the ticket as a comment and everyone else on it is notified.</div></td></tr>` : ""}
  <tr><td style="padding:24px"><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">See more on FixMi →</a></td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af">Dossani Paradise · Repair &amp; Maintenance · Ticket ${esc(ticket.shortId || "")}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    ...(comment ? [`NEW COMMENT · ${comment.by || ""}${comment.ts ? " · " + fmtWhen(comment.ts) : ""}`, comment.text || "", ...cPhotos, ""] : []),
    ...(wouldHaveGoneTo ? [`TEST MODE — nobody else received this. Live, it would have gone to: ${wouldHaveGoneTo.join(", ") || "nobody"}.`, ""] : []),
    headline, "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "", "ISSUE", ticket.description || "No description",
    ...(photos.length ? ["", "PHOTOS", ...photos] : []),
    ...(closeNote ? ["", `CLOSING NOTES · ${closeNote.by || ""}`, closeNote.text] : []),
    ...(convo.length ? ["", `CONVERSATION (${convo.length})`,
      ...convo.map((c, i) => `${i + 1}. ${c.by || "Someone"} · ${fmtWhen(c.ts)}${(Number(c.ts) || 0) === newestTs ? "  ← newest" : ""}\n   ${(c.text || "").replace(/\n/g, "\n   ")}`)] : []),
    ...(canReply ? ["", "Reply to this email and your reply is added to the ticket as a comment."] : []),
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
function answerSig(ticketId, answer, email) {
  return require("crypto").createHmac("sha256", process.env.FIXMI_SHARED_SECRET || "")
    .update(`${ticketId}|${answer}|${lc(email)}`).digest("hex").slice(0, 32);
}
function answerUrl(base, ticketId, answer, email) {
  const q = new URLSearchParams({ t: ticketId, a: answer, e: lc(email), s: answerSig(ticketId, answer, email) });
  return `${base.replace(/\/$/, "")}/api/answer?${q}`;
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
  const out = { ok: false, sent: 0, failed: [] };
  for (let i = 0; i < messages.length; i += 500) {          // Postmark caps a batch at 500
    const slice = messages.slice(i, i + 500);
    const pm = await fetch("https://api.postmarkapp.com/email/batch", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.token },
      body: JSON.stringify(slice),
    });
    const results = await pm.json().catch(() => []);
    const list = Array.isArray(results) ? results : [results];
    if (!pm.ok) { out.failed.push({ status: pm.status, detail: list }); continue; }
    list.forEach((x, j) => {
      if (x && x.ErrorCode) out.failed.push({ to: (slice[j] || {}).To, code: x.ErrorCode, message: x.Message });
      else out.sent++;
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

function shell(title, subtitle, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Weekly summary</td></tr>
  <tr><td style="padding:22px 24px 4px"><div style="font-size:20px;font-weight:700;line-height:1.3">${esc(title)}</div>
    <div style="font-size:14px;color:#6b7280;margin-top:5px">${esc(subtitle)}</div></td></tr>
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
      subject: `FixMi weekly — ${label}: nothing open`,
      html: shell(`Nothing open at ${label}`, "No maintenance tickets are outstanding this week. Nothing for you to do.",
        `<tr><td style="padding:14px 24px 24px"><div style="font-size:15px;line-height:1.55;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;padding:14px 16px">All clear. If something breaks, open a ticket in FixMi and it will appear here next week.</div></td></tr>`),
      text: `Nothing open at ${label}.\n\nNo maintenance tickets are outstanding this week.`,
    };
  }
  const rows = tickets.map(t => {
    const yes = answerUrl(cfg.selfUrl, t._id, "yes", person.email);
    const no = answerUrl(cfg.selfUrl, t._id, "no", person.email);
    const cat = t.categoryLabel || [t.category, t.subcategory].filter(Boolean).join(" › ");
    return `<tr><td style="padding:0 24px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px">
        <tr><td style="padding:14px 16px">
          <div style="font-size:12px;color:#6b7280">${priChip(t.priority)} &nbsp; <b style="color:#111827">${esc(t.shortId || "")}</b> · ${esc(STATUS_LABEL[t.status] || t.status)} · open ${esc(ageOf(t.createdAt))}</div>
          ${cat ? `<div style="font-size:13px;color:#6b7280;margin-top:5px">${esc(cat)}</div>` : ""}
          <div style="font-size:15px;line-height:1.5;margin-top:6px;white-space:pre-wrap">${esc(t.description || "No description")}</div>
          <div style="font-size:12.5px;color:#6b7280;margin-top:7px">Opened ${esc(fmtDay(t.createdAt))} by ${esc(t.createdByName || t.createdBy || "someone")}${t.assigneeLabel ? ` · assigned to ${esc(t.assigneeLabel)}` : ""}</div>
          <div style="margin-top:13px;font-size:13.5px;font-weight:700">Is this still a problem?</div>
          <div style="margin-top:8px">
            <a href="${esc(yes)}" style="display:inline-block;background:#e8091b;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:9px 22px;border-radius:8px;margin-right:8px">Yes — still open</a>
            <a href="${esc(no)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:9px 22px;border-radius:8px">No — it's fixed</a>
          </div>
          <div style="margin-top:9px;font-size:12px"><a href="${esc(ticketUrlFor(cfg.appUrl, t))}" style="color:#1d76bb">Open it in FixMi</a></div>
        </td></tr>
      </table></td></tr>`;
  }).join("");
  const text = [
    `${label} — ${tickets.length} open ticket${tickets.length === 1 ? "" : "s"}`, "",
    ...tickets.map(t => [
      `${t.shortId} · ${PRIORITY_LABEL[lc(t.priority)] || "Normal"} · ${STATUS_LABEL[t.status] || t.status} · open ${ageOf(t.createdAt)}`,
      t.description || "No description",
      `Still a problem?  YES: ${answerUrl(cfg.selfUrl, t._id, "yes", person.email)}`,
      `                  NO:  ${answerUrl(cfg.selfUrl, t._id, "no", person.email)}`,
      "",
    ].join("\n")),
  ].join("\n");
  return {
    subject: `FixMi weekly — ${label}: ${tickets.length} open ticket${tickets.length === 1 ? "" : "s"}`,
    html: shell(`${tickets.length} open at ${label}`,
      "Please answer Yes or No on each one. One click — your answer is written straight onto the ticket.",
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
        <a href="${esc(storeUrlFor(app, b.sid))}" style="color:#111827;text-decoration:none">${esc(b.label)} <span style="color:#1d76bb;font-size:12px;font-weight:400">view store &rsaquo;</span></a>
        <span style="float:right;color:#6b7280;font-weight:400">${b.tickets.length} open</span></div>
      ${b.tickets.length
        ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13.5px;line-height:1.5;margin-top:7px">${
            b.tickets.map(t => `<tr>
              <td style="padding:4px 8px 4px 0;white-space:nowrap;vertical-align:top">${priChip(t.priority)}</td>
              <td style="padding:4px 0;vertical-align:top"><a href="${esc(ticketUrlFor(app, t))}" style="color:#111827;text-decoration:none">
                <b style="color:#1d76bb">${esc(t.shortId || "")}</b> — ${esc(t.categoryLabel || [t.category, t.subcategory].filter(Boolean).join(" › ") || "Ticket")}
                <span style="color:#6b7280">· ${esc(STATUS_LABEL[t.status] || t.status)} · ${esc(ageOf(t.createdAt))}</span></a></td></tr>`).join("")
          }</table>`
        : `<div style="font-size:13.5px;color:#059669;margin-top:6px">Nothing open.</div>`}
    </td></tr>`).join("");
  const text = [`${total} open across ${blocks.length} store${blocks.length === 1 ? "" : "s"}`, "",
    ...blocks.map(b => `${b.label} — ${b.tickets.length} open\n${storeUrlFor(app, b.sid)}\n` +
      (b.tickets.length ? b.tickets.map(t => `  ${t.shortId} — ${t.categoryLabel || t.category || "Ticket"} (${PRIORITY_LABEL[lc(t.priority)] || "Normal"}, ${STATUS_LABEL[t.status] || t.status}, ${ageOf(t.createdAt)})\n  ${ticketUrlFor(app, t)}`).join("\n") : "  Nothing open.") + "\n")].join("\n");
  return {
    subject: `FixMi weekly — ${total} open across your ${blocks.length} store${blocks.length === 1 ? "" : "s"}`,
    html: shell(`${total} open across your ${blocks.length} store${blocks.length === 1 ? "" : "s"}`,
      "Every open ticket on your patch, busiest store first. Tap a store to see all of its tickets, or a line to open that one.",
      `<tr><td style="height:10px"></td></tr>${rows}`),
    text,
  };
}

/** The Director's league table: counts only, worst first. */
function summaryDO(master, person, cfg) {
  const app = (cfg && cfg.appUrl) || DEFAULTS.appUrl;
  const rowsData = person.storeIds.map(sid => {
    const store = (master.restaurants || {})[sid] || {};
    const tickets = openTicketsFor(master, sid);
    return {
      sid, label: storeLabel(store), n: tickets.length,
      urgent: tickets.filter(t => ["emergency", "urgent"].includes(lc(t.priority))).length,
      oldest: tickets.length ? Math.min(...tickets.map(t => t.createdAt || Date.now())) : 0,
    };
  }).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  const total = rowsData.reduce((n, r) => n + r.n, 0);
  const worst = Math.max(1, ...rowsData.map(r => r.n));
  const rows = rowsData.map(r => `<tr>
      <td style="padding:7px 10px 7px 0;font-size:14px;border-bottom:1px solid #f3f4f6"><a href="${esc(storeUrlFor(app, r.sid))}" style="color:#111827;text-decoration:none">${esc(r.label)}</a></td>
      <td style="padding:7px 10px;width:45%;border-bottom:1px solid #f3f4f6">
        <div style="background:#f3f4f6;border-radius:999px;height:8px"><div style="background:${r.urgent ? "#e8091b" : "#1d76bb"};width:${Math.round((r.n / worst) * 100)}%;height:8px;border-radius:999px"></div></div></td>
      <td style="padding:7px 0;text-align:right;font-size:14px;font-weight:700;white-space:nowrap;border-bottom:1px solid #f3f4f6">${r.n}${r.urgent ? `<span style="color:#e8091b;font-weight:400;font-size:12px"> · ${r.urgent} urgent+</span>` : ""}</td>
    </tr>`).join("");
  const text = [`${total} open across ${rowsData.length} stores`, "",
    ...rowsData.map(r => `${String(r.n).padStart(3)}  ${r.label}${r.urgent ? `  (${r.urgent} urgent or emergency)` : ""}`)].join("\n");
  return {
    subject: `FixMi weekly — ${total} open across ${rowsData.length} stores`,
    html: shell(`${total} open across ${rowsData.length} stores`,
      "Open ticket count per store, most to least. Tap a store to see its tickets.",
      `<tr><td style="padding:14px 24px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table></td></tr>`),
    text,
  };
}

/* Everyone who should get a summary, and what each of them should see. Roles
   come from FindMi at send time, so a new GM is included the week they start. */
function summaryAudience(master, kind, prefs) {
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
  if (person.kind === "gm") return summaryGM(master, person, cfg);
  if (person.kind === "dm") return summaryDM(master, person, cfg);
  return summaryDO(master, person, cfg);
}

/* A stand-in used by the "send me a test" buttons, so a summary can be seen
   even by someone who isn't a GM anywhere. Picks the busiest real store /
   patch, so the test looks like the real thing rather than an empty shell. */
function sampleAudience(master, kind, email, prefs) {
  const real = summaryAudience(master, kind, prefs);
  const mine = real.find(p => p.email === lc(email));
  if (mine) return { ...mine, email: lc(email) };
  const busiest = real.map(p => ({
    p, n: (p.kind === "gm" ? [p.storeId] : p.storeIds).reduce((n, sid) => n + openTicketsFor(master, sid).length, 0),
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
    const DIAG = ["selftest", "sendtest", "postmark", "summary"];
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
      const r = await fetch(cfg.masterUrl, { headers: { accept: "application/json" } });
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
      const kind = ["gm", "dm", "do"].includes(body.kind) ? body.kind : "gm";
      const sCfg = {
        appUrl: cfg.appUrl,
        selfUrl: (process.env.FIXMI_SELF_URL || `https://${req.headers.host || ""}`).replace(/\/$/, ""),
      };

      if (mode === "preview" || mode === "test") {
        const who = sampleAudience(master, kind, body.to || (arr(body.to)[0]) || "preview@example.com", prefs0);
        if (!who) return res.status(200).json({ ok: false, reason: `there are no ${kind.toUpperCase()}s with an email address in FindMi yet` });
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

      // mode "run" — the real weekly send
      if (!cfg.token) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
      const kinds = arr(body.kinds).length ? arr(body.kinds).filter(k => ["gm", "dm", "do"].includes(k)) : ["gm", "dm", "do"];
      const messages = [], log = [];
      kinds.forEach(k => {
        summaryAudience(master, k, prefs0).forEach(person => {
          const built = buildSummary(master, person, sCfg);
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
      if (!messages.length) return res.status(200).json({ ok: true, sent: 0, reason: "nobody to send to — no store, DM or Director in FindMi has an email address" });
      if (prefs0.testMode && !prefs0.testTo.length) return res.status(200).json({ ok: false, sent: 0, reason: "test mode is on but no test addresses are set" });
      const r3 = await sendBatch(cfg, messages);
      console.log("[fixmi-notify] weekly summaries", { testMode: prefs0.testMode, built: log.length, sent: r3.sent });
      return res.status(200).json({ ok: r3.ok, sent: r3.sent, testMode: prefs0.testMode, people: log, failed: r3.failed });
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

module.exports.recipientsFor = recipientsFor;
module.exports.prefsFrom = prefsFrom;
module.exports.bodyFor = bodyFor;
module.exports.subjectFor = subjectFor;
module.exports.storeLabel = storeLabel;
module.exports.headlineFor = headlineFor;
