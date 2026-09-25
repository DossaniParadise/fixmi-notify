/**
 * FixMi ← Postmark.  Turns an email reply into a comment on the ticket.
 *
 * Postmark receives mail sent to reply+<ticketId>@reply.dossaniparadise.com,
 * parses it, and POSTs JSON here. We work out which ticket it belongs to and
 * who wrote it, strip the quoted history and the sign-off, append it to the
 * ticket as a comment, and then ask /api/notify to email everyone else on the
 * thread — everyone except the person who just replied.
 *
 * ── SETUP ───────────────────────────────────────────────────────────────────
 * 1. Postmark must be on the Pro plan (inbound isn't on Basic).
 * 2. DNS: an MX record on the subdomain `reply` → inbound.postmarkapp.com,
 *    priority 10. Never on the root domain: that would send all company mail
 *    to Postmark instead of Google.
 * 3. Postmark → your server → Default Inbound Stream → set the inbound domain
 *    to reply.dossaniparadise.com and the webhook URL to:
 *       https://<your project>.vercel.app/api/inbound?key=<FIXMI_SHARED_SECRET>
 *
 * ── ENVIRONMENT VARIABLES (on top of the ones /api/notify already uses) ──────
 *   FIXMI_WRITE_PASSWORD  required   the alignment API's write password
 *   FIXMI_REPLY_DOMAIN    optional   default "reply.dossaniparadise.com"
 *   FIXMI_INBOUND_USER /
 *   FIXMI_INBOUND_PASS    optional   use HTTP Basic auth instead of ?key=
 *
 * Always answers 200. Postmark retries anything else, and a retry loop on a
 * message we can't use would post the same comment again and again.
 */

const DEFAULTS = {
  masterUrl: "https://alignment-api-khaki.vercel.app/api/dpm-alignment",
  ticketsNode: "maintenanceTickets",
};

const lc = v => String(v || "").trim().toLowerCase();
const arr = v => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : (v ? [v] : []));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* A sign-off with no "--" in front of it is the one thing the reply parser
   can't see. Only trimmed when what's left still says something, and only when
   the trailing block is short — a few lines of name, company, phone. */
function trimSignOff(text) {
  const SIGNOFF = /^(thanks|thank you|thanks again|thankyou|regards|best|best regards|kind regards|warm regards|cheers|sincerely|respectfully|thx|many thanks|appreciate it|talk soon)[\s,.!—–-]*$/i;
  const lines = String(text || "").split("\n");
  for (let i = Math.max(0, lines.length - 9); i < lines.length; i++) {
    if (!SIGNOFF.test(lines[i].trim())) continue;
    const after = lines.slice(i + 1).filter(l => l.trim());
    if (after.length > 5) continue;                       // too much to be a signature
    if (after.some(l => l.trim().length > 60)) continue;  // real sentences, not a name block
    const kept = lines.slice(0, i).join("\n").trim();
    if (kept) return kept;
  }
  return String(text || "").trim();
}

/** Just the words this person typed: no quoted history, no signature. */
function cleanReply(payload) {
  const raw = payload.TextBody || payload.StrippedTextReply || "";
  let out = "";
  try {
    const Parser = require("email-reply-parser").default || require("email-reply-parser");
    out = new Parser().read(raw).getVisibleText() || "";
  } catch (e) {
    console.warn("[fixmi-inbound] reply parser unavailable, falling back", e && e.message);
    out = payload.StrippedTextReply || raw;
  }
  out = trimSignOff(out);
  // Last resort: the parser decided everything was quoted, but Postmark's own
  // stripping found something. Better a slightly messy comment than none.
  if (!out.trim() && payload.StrippedTextReply) out = trimSignOff(payload.StrippedTextReply);
  return out.trim();
}

/* Machines talking to machines: out-of-office, bounces, delivery reports.
   None of these are a person replying, and all of them would otherwise land
   on the ticket as a comment. */
function isAutomated(payload) {
  const from = lc((payload.FromFull && payload.FromFull.Email) || payload.From);
  if (/^(mailer-daemon|postmaster|no-?reply|donotreply|bounce)/.test(from.split("@")[0] || "")) return "automated sender";
  const subject = String(payload.Subject || "");
  if (/^(out of office|automatic reply|auto(matic)? response|undeliverable|delivery status notification)/i.test(subject.trim())) return "auto-reply subject";
  const h = {};
  arr(payload.Headers).forEach(x => { if (x && x.Name) h[lc(x.Name)] = String(x.Value || ""); });
  if (/auto-(replied|generated|notified)/i.test(h["auto-submitted"] || "")) return "Auto-Submitted header";
  if (h["x-autoreply"] || h["x-autorespond"] || lc(h["precedence"]) === "auto_reply") return "auto-reply header";
  return null;
}

/** Match the sender against everyone FixMi knows, so we can name them properly. */
function identify(master, email) {
  const want = lc(email);
  const look = (group, role) => {
    for (const o of Object.values(master[group] || {})) {
      if (o && lc(o.email) === want) return { name: o.name || o.storeManager || want, role };
    }
    return null;
  };
  return look("admins", "admin")
    || look("directors", "director")
    || look("areaCoaches", "coach")
    || look("repairTechnicians", "tech")
    || look("restaurants", "manager")
    || null;
}

module.exports = async (req, res) => {
  const ok = (body) => res.status(200).json(body);            // always 200: see the note up top
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // --- who's calling -------------------------------------------------------
    const user = process.env.FIXMI_INBOUND_USER, pass = process.env.FIXMI_INBOUND_PASS;
    if (user && pass) {
      const want = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
      if ((req.headers.authorization || "") !== want) return res.status(401).json({ error: "bad basic auth" });
    } else {
      const key = (req.query && req.query.key) || "";
      if (!process.env.FIXMI_SHARED_SECRET) return res.status(500).json({ error: "FIXMI_SHARED_SECRET is not set" });
      if (key !== process.env.FIXMI_SHARED_SECRET) return res.status(401).json({ error: "bad or missing ?key=" });
    }

    const p = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
    const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
    if (!writePass) return ok({ ignored: true, reason: "FIXMI_WRITE_PASSWORD is not set — cannot write the comment" });

    const why = isAutomated(p);
    if (why) { console.log("[fixmi-inbound] ignored:", why, p.From); return ok({ ignored: true, reason: why }); }

    const fromEmail = lc((p.FromFull && p.FromFull.Email) || p.From);
    const fromName = ((p.FromFull && p.FromFull.Name) || "").trim();
    if (!fromEmail) return ok({ ignored: true, reason: "no sender address" });

    // --- which ticket --------------------------------------------------------
    const r = await fetch(masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return ok({ ignored: true, reason: `could not read the master (HTTP ${r.status})` });
    const master = await r.json();
    const tickets = master[DEFAULTS.ticketsNode] || {};

    let id = String(p.MailboxHash || "").trim();
    if (!id || !tickets[id]) {
      // No hash (someone wrote to the address directly, or forwarded it) —
      // fall back to the [23086-PLM-0004] tag the subject always carries.
      const m = String(p.Subject || "").match(/\[([A-Za-z0-9-]+-[A-Za-z]+-\d+)\]/);
      if (m) {
        const want = m[1].toUpperCase();
        id = Object.keys(tickets).find(k => String(tickets[k].shortId || "").toUpperCase() === want) || "";
      }
    }
    if (!id || !tickets[id]) {
      console.log("[fixmi-inbound] no ticket for", p.MailboxHash, "|", p.Subject);
      return ok({ ignored: true, reason: "could not tell which ticket this reply belongs to" });
    }
    const ticket = tickets[id];

    // --- the words -----------------------------------------------------------
    const text = cleanReply(p);
    if (!text) return ok({ ignored: true, reason: "nothing left after removing the quoted history" });

    // --- don't post the same reply twice on a webhook retry ------------------
    const msgId = String(p.MessageID || "").trim();
    const comments = arr(ticket.comments).slice();
    if (msgId && comments.some(c => c && c.mailId === msgId)) return ok({ ignored: true, reason: "already posted", id });

    // --- who wrote it --------------------------------------------------------
    const known = identify(master, fromEmail);
    const by = known ? known.name : (fromName ? `${fromName} (${fromEmail})` : fromEmail);
    const comment = {
      id: uid(),
      by,
      role: known ? known.role : "guest",
      email: fromEmail,
      text,
      ts: Date.now(),
      viaEmail: true,                       // the app puts a ✉ on these
      ...(known ? {} : { guest: true }),
      ...(msgId ? { mailId: msgId } : {}),
    };
    comments.push(comment);

    // Anyone who replies by email stays on the thread for later updates.
    const watchers = [...new Set([...arr(ticket.guestWatchers).map(lc), ...(known ? [] : [fromEmail])])];
    const updated = { ...ticket, comments, guestWatchers: watchers, updatedAt: Date.now() };

    const w = await fetch(masterUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: writePass, updates: { [`${DEFAULTS.ticketsNode}/${id}`]: updated } }),
    });
    if (!w.ok) {
      const detail = await w.text().catch(() => "");
      console.error("[fixmi-inbound] write failed", w.status, detail.slice(0, 200));
      return ok({ ignored: true, reason: `could not save the comment (HTTP ${w.status})` });
    }

    // --- tell everyone else --------------------------------------------------
    let notified = null;
    try {
      const self = process.env.FIXMI_SELF_URL || `https://${req.headers.host}`;
      const n = await fetch(`${self.replace(/\/$/, "")}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.FIXMI_SHARED_SECRET,
          event: "comment",
          ticketId: id,
          ticket: updated,
          comment: { by, text, ts: comment.ts },
          thread: comments.slice(-25).map(c => ({ by: c.by, role: c.role, email: c.email, text: c.text, ts: c.ts })),
          actorEmail: fromEmail,            // the replier doesn't get their own reply back
          actorName: by,
        }),
      });
      notified = await n.json().catch(() => null);
    } catch (e) {
      console.error("[fixmi-inbound] comment saved but the notification failed", e && e.message);
    }

    console.log("[fixmi-inbound] comment added to", ticket.shortId || id, "from", fromEmail, "| emailed:", (notified && notified.to) || "none");
    return ok({ ok: true, ticket: ticket.shortId || id, from: fromEmail, chars: text.length, notified: (notified && notified.to) || [] });
  } catch (e) {
    console.error("[fixmi-inbound] crashed", e);
    return res.status(200).json({ ignored: true, error: String((e && e.message) || e) });
  }
};

module.exports.cleanReply = cleanReply;
module.exports.trimSignOff = trimSignOff;
module.exports.isAutomated = isAutomated;
module.exports.identify = identify;
