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
};
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
  const put = (email, name, role, key) => {
    if (key && !(prefs.roles[key] || {})[event]) return;   // this role is switched off for this event
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

  // Test mode replaces the whole list — nobody real is emailed.
  if (prefs.testMode) return prefs.testTo.map(e => ({ email: e, name: e, role: "Test" }));

  prefs.alwaysTo.forEach(e => { if (!out.has(e)) out.set(e, { email: e, name: e, role: "Always copied" }); });
  // Never tell someone about the thing they just did.
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
function subjectFor(store, ticket) {
  return `[${ticket.shortId || "Ticket"}] ${storeLabel(store)}`;
}

function headlineFor(event, store, ticket, prevStatus, comment) {
  const who = storeLabel(store);
  if (event === "created") return `${who} has a new ticket open.`;
  if (event === "comment") return `${who} — new comment from ${(comment && comment.by) || "someone"}.`;
  const to = STATUS_LABEL[ticket.status] || ticket.status || "updated";
  const from = STATUS_LABEL[prevStatus] || prevStatus;
  return from ? `${who} — ticket moved from ${from} to ${to}.` : `${who} — ticket moved to ${to}.`;
}

function bodyFor({ event, store, ticket, prevStatus, appUrl, actorName, comment }) {
  const url = `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticket._id || "")}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
  const headline = headlineFor(event, store, ticket, prevStatus, comment);
  const photos = arr(ticket.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 6);
  const cPhotos = comment ? arr(comment.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 6) : [];
  const facts = [
    ["Store", storeLabel(store)],
    ["Status", STATUS_LABEL[ticket.status] || ticket.status],
    ["Priority", ticket.priority ? (PRIORITY_LABEL[ticket.priority] || ticket.priority) : "Normal"],
    ["Category", ticket.categoryLabel || [ticket.category, ticket.subcategory].filter(Boolean).join(" › ")],
    ["Reported by", ticket.createdByName || ticket.createdBy],
    event === "created" ? null : [event === "comment" ? "Comment by" : "Changed by", (comment && comment.by) || actorName],
  ].filter(Boolean).filter(([, v]) => String(v == null ? "" : v).trim() !== "");   // a blank row is noise, not "—"

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Ticket ${esc(ticket.shortId || "")}</td></tr>
  <tr><td style="padding:24px 24px 6px"><div style="font-size:19px;font-weight:700;line-height:1.35">${esc(headline)}</div>
    <div style="font-size:14px;color:#6b7280;margin-top:6px">See details below.</div></td></tr>
  <tr><td style="padding:10px 24px 0"><table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7">
    ${facts.map(([k, v]) => `<tr><td style="color:#6b7280;padding-right:16px;white-space:nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
  </table></td></tr>
  <tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Issue</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">${esc(ticket.description || "No description")}</div></td></tr>
  ${photos.length ? `<tr><td style="padding:14px 24px 0">${photos.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="160" alt="Ticket photo" style="width:160px;max-width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</td></tr>` : ""}
  ${comment ? `<tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">New comment · ${esc(comment.by || "")}</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;border-left:3px solid #1d76bb;padding:6px 14px">${esc(comment.text || "")}</div>
    ${cPhotos.length ? `<div style="margin-top:10px">${cPhotos.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="160" alt="Comment photo" style="width:160px;max-width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</div>` : ""}
  </td></tr>` : ""}
  <tr><td style="padding:24px"><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">See more on FixMi →</a></td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af">Dossani Paradise · Repair &amp; Maintenance · Ticket ${esc(ticket.shortId || "")}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    headline, "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "", "ISSUE", ticket.description || "No description",
    ...(photos.length ? ["", "PHOTOS", ...photos] : []),
    ...(comment ? ["", `NEW COMMENT · ${comment.by || ""}`, comment.text || "", ...cPhotos] : []),
    "", `See more on FixMi: ${url}`,
    "", "--", "Dossani Paradise · Repair & Maintenance",
  ].join("\n");

  return { html, text, url };
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
    const { secret, event, ticketId, ticket: sent, prevStatus, actorEmail, actorName, comment } = body;

    const want = process.env.FIXMI_SHARED_SECRET || "";
    if (!want) return res.status(500).json({ error: "FIXMI_SHARED_SECRET is not set on the server" });
    if (secret !== want) return res.status(401).json({ error: "bad secret" });
    const DIAG = ["selftest", "sendtest"];
    if (!EVENTS.includes(event) && !DIAG.includes(event)) return res.status(400).json({ error: `event must be one of ${EVENTS.join(", ")}` });
    if (!ticketId && !DIAG.includes(event)) return res.status(400).json({ error: "ticketId is required" });

    const cfg = {
      token: process.env.POSTMARK_TOKEN || "",
      from: process.env.FIXMI_FROM || DEFAULTS.from,
      appUrl: process.env.FIXMI_APP_URL || DEFAULTS.appUrl,
      masterUrl: process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl,
      stream: process.env.FIXMI_STREAM || DEFAULTS.stream,
      dryRun: process.env.FIXMI_DRY_RUN === "1",
    };
    if (!cfg.token && !cfg.dryRun && event !== "selftest") return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
    if (process.env.FIXMI_NOTIFY_OFF === "1" && !DIAG.includes(event)) return res.status(200).json({ sent: 0, reason: "notifications switched off" });

    // The master is the source of truth for WHO gets mailed. The ticket body may
    // come from the caller because the CDN copy can lag a minute behind a write.
    const r = await fetch(cfg.masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: `could not read the alignment master (HTTP ${r.status})` });
    const master = await r.json();

    /* ---- DIAGNOSTICS -------------------------------------------------------
       "selftest" reports how this function is configured and who a given ticket
       would reach. It never contacts Postmark. "sendtest" sends one real email,
       but only to an address the master already knows or that is listed in
       Settings → Email — so this can't be turned into a way to mail strangers. */
    if (event === "selftest") {
      const prefs0 = prefsFrom(master);
      const out = {
        ok: true,
        tokenPresent: !!cfg.token,
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
      };
      if (ticketId) {
        const t = { ...((master.maintenanceTickets || {})[ticketId] || {}), ...(sent || {}), _id: ticketId };
        const st = (master.restaurants || {})[t.storeId] || {};
        out.ticket = {
          id: ticketId, shortId: t.shortId || null, store: storeLabel(st),
          knownToMaster: !!(master.maintenanceTickets || {})[ticketId],
          subject: t.storeId ? (prefs0.testMode ? "[TEST] " : "") + subjectFor(st, t) : null,
          recipients: t.storeId ? recipientsFor(master, t, { prefs: prefs0, event: "created", actorEmail }) : [],
        };
      }
      return res.status(200).json(out);
    }

    if (event === "sendtest") {
      const prefs0 = prefsFrom(master);
      const known = new Set([...prefs0.testTo, ...prefs0.alwaysTo]);
      [master.admins, master.directors, master.areaCoaches, master.repairTechnicians, master.restaurants]
        .forEach(g => Object.values(g || {}).forEach(o => { const e = lc(o && o.email); if (e) known.add(e); }));
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
    if (!people.length) return res.status(200).json({
      sent: 0,
      reason: prefs.testMode ? "test mode is on but no test addresses are set"
                             : "nobody is set to receive this event — check Settings → Email, and that these people have emails in FindMi",
    });

    const { html, text, url } = bodyFor({ event, store, ticket, prevStatus, appUrl: cfg.appUrl, actorName, comment });
    const subject = (prefs.testMode ? "[TEST] " : "") + subjectFor(store, ticket);
    const threadId = `<fixmi-${ticketId}@dossaniparadise.com>`;    // same on every mail about this ticket → clients thread them

    const messages = people.map(p => ({
      From: `FixMi <${cfg.from}>`,
      To: `"${String(p.name).replace(/"/g, "")}" <${p.email}>`,
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
