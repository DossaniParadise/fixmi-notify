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
 *   FIXMI_CC_REPORTER     optional   "1" to also email whoever filed the ticket
 *   FIXMI_SKIP_ACTOR      optional   "1" to skip whoever caused the change
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

/** Director + District Manager(s) + General Manager for this store. */
function recipientsFor(master, ticket, opts) {
  const store = (master.restaurants || {})[ticket.storeId] || {};
  const out = new Map();                                   // email → {email, name, role}
  const put = (email, name, role) => {
    const e = lc(email);
    if (e && e.includes("@") && !out.has(e)) out.set(e, { email: e, name: name || e, role });
  };
  const dir = (master.directors || {})[store.assignedDirectorId];
  if (dir) put(dir.email, dir.name, "Director");
  storeCoachIds(store).forEach(id => {
    const dm = (master.areaCoaches || {})[id];
    if (dm) put(dm.email, dm.name, "District Manager");
  });
  put(store.email, store.storeManager || store.storeName, "General Manager");
  if (opts.ccReporter) put(ticket.createdBy, ticket.createdByName, "Reported by");
  if (opts.skipActor && opts.actorEmail) out.delete(lc(opts.actorEmail));
  return [...out.values()];
}

function subjectFor(store, ticket) {
  return `[${ticket.shortId || "Ticket"}] Store #${store.storeNumber || "?"} — ${store.storeName || "Store"}`;
}

function headlineFor(event, store, ticket, prevStatus) {
  const who = `${store.storeName || "Store"} #${store.storeNumber || ""}`.trim();
  if (event === "created") return `${who} has a new ticket open.`;
  const to = STATUS_LABEL[ticket.status] || ticket.status || "updated";
  const from = STATUS_LABEL[prevStatus] || prevStatus;
  return from ? `${who} — ticket moved from ${from} to ${to}.` : `${who} — ticket moved to ${to}.`;
}

function bodyFor({ event, store, ticket, prevStatus, appUrl, actorName }) {
  const url = `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticket._id || "")}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
  const headline = headlineFor(event, store, ticket, prevStatus);
  const photos = arr(ticket.photos).filter(u => typeof u === "string" && /^https?:/i.test(u)).slice(0, 6);
  const facts = [
    ["Store", `${store.storeName || "—"} &nbsp;#${store.storeNumber || ""}`],
    ["Status", STATUS_LABEL[ticket.status] || ticket.status || "—"],
    ["Priority", PRIORITY_LABEL[ticket.priority] || "Normal"],
    ["Category", [ticket.category, ticket.subcategory].filter(Boolean).join(" › ")],
    ["Reported by", ticket.createdByName || ticket.createdBy || "—"],
    event === "created" ? null : ["Changed by", actorName || "—"],
  ].filter(Boolean).filter(([, v]) => v && v !== "—" || true);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#1d76bb;padding:14px 24px;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">FixMi &nbsp;·&nbsp; Ticket ${esc(ticket.shortId || "")}</td></tr>
  <tr><td style="padding:24px 24px 6px"><div style="font-size:19px;font-weight:700;line-height:1.35">${esc(headline)}</div>
    <div style="font-size:14px;color:#6b7280;margin-top:6px">See details below.</div></td></tr>
  <tr><td style="padding:10px 24px 0"><table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7">
    ${facts.map(([k, v]) => `<tr><td style="color:#6b7280;padding-right:16px;white-space:nowrap">${esc(k)}</td><td>${k === "Store" ? v : esc(v)}</td></tr>`).join("")}
  </table></td></tr>
  <tr><td style="padding:18px 24px 0">
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Issue</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">${esc(ticket.description || "No description")}</div></td></tr>
  ${photos.length ? `<tr><td style="padding:14px 24px 0">${photos.map(u => `<a href="${esc(u)}"><img src="${esc(u)}" width="160" alt="Ticket photo" style="width:160px;max-width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;margin:0 8px 8px 0"></a>`).join("")}</td></tr>` : ""}
  <tr><td style="padding:24px"><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">See more on FixMi →</a></td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 24px;font-size:12px;color:#9ca3af">Dossani Paradise · Repair &amp; Maintenance · Ticket ${esc(ticket.shortId || "")}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    headline, "",
    ...facts.map(([k, v]) => `${k}: ${String(v).replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, "")}`),
    "", "ISSUE", ticket.description || "No description",
    ...(photos.length ? ["", "PHOTOS", ...photos] : []),
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
    const { secret, event, ticketId, ticket: sent, prevStatus, actorEmail, actorName } = body;

    const want = process.env.FIXMI_SHARED_SECRET || "";
    if (!want) return res.status(500).json({ error: "FIXMI_SHARED_SECRET is not set on the server" });
    if (secret !== want) return res.status(401).json({ error: "bad secret" });
    if (event !== "created" && event !== "status") return res.status(400).json({ error: "event must be 'created' or 'status'" });
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const cfg = {
      token: process.env.POSTMARK_TOKEN || "",
      from: process.env.FIXMI_FROM || DEFAULTS.from,
      appUrl: process.env.FIXMI_APP_URL || DEFAULTS.appUrl,
      masterUrl: process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl,
      stream: process.env.FIXMI_STREAM || DEFAULTS.stream,
      ccReporter: process.env.FIXMI_CC_REPORTER === "1",
      skipActor: process.env.FIXMI_SKIP_ACTOR === "1",
      dryRun: process.env.FIXMI_DRY_RUN === "1",
    };
    if (!cfg.token && !cfg.dryRun) return res.status(500).json({ error: "POSTMARK_TOKEN is not set on the server" });
    if (process.env.FIXMI_NOTIFY_OFF === "1") return res.status(200).json({ sent: 0, reason: "notifications switched off" });

    // The master is the source of truth for WHO gets mailed. The ticket body may
    // come from the caller because the CDN copy can lag a minute behind a write.
    const r = await fetch(cfg.masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: `could not read the alignment master (HTTP ${r.status})` });
    const master = await r.json();

    const fromMaster = (master.maintenanceTickets || {})[ticketId];
    const ticket = { ...(sent || {}), ...(fromMaster || {}), _id: ticketId };
    if (sent && sent.status) ticket.status = sent.status;          // caller's write is the freshest
    if (sent && sent.shareToken) ticket.shareToken = sent.shareToken;
    if (!ticket.storeId) return res.status(404).json({ error: "ticket has no storeId — is the id right?" });

    const store = (master.restaurants || {})[ticket.storeId] || {};
    const people = recipientsFor(master, ticket, { ccReporter: cfg.ccReporter, skipActor: cfg.skipActor, actorEmail });
    if (!people.length) return res.status(200).json({ sent: 0, reason: "no Director, DM or GM email on this store" });

    const { html, text, url } = bodyFor({ event, store, ticket, prevStatus, appUrl: cfg.appUrl, actorName });
    const subject = subjectFor(store, ticket);
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
      return res.status(200).json({ sent: 0, dryRun: true, subject, to: people });
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
      subject,
    });
  } catch (e) {
    console.error("[fixmi-notify] crashed", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.recipientsFor = recipientsFor;
module.exports.bodyFor = bodyFor;
module.exports.subjectFor = subjectFor;
module.exports.headlineFor = headlineFor;

