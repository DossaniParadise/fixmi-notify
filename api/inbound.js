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

/* ════════════════════════════════════════════════════════════════════════════
   Pulling the actual message out of a reply.

   Two jobs, done in order: remove the quoted history underneath, then remove
   the signature block. Both are done here rather than by a library — the one
   we used only understood "-- " and "Sent from my iPhone", which is not what a
   corporate Outlook signature looks like, and it cost a package install plus an
   ES-module load on every cold start.
   ════════════════════════════════════════════════════════════════════════════ */

/* Lines that mean "everything from here down is the email being replied to". */
const QUOTE_LINE = [
  /^\s*on\b.{0,240}\bwrote\s*:\s*$/i,               // Gmail, Apple Mail, most clients
  /^\s*on\b.{0,240}\b(wrote|schrieb|escribió|a écrit)\s*:\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,      // Outlook, older style
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^\s*<[^>]+@[^>]+>\s+wrote\s*:\s*$/i,
  /^\s*\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b.{0,120}\bwrote\s*:\s*$/i,
  /^\s*_{5,}\s*$/,                                  // Outlook's rule above the header block
  /^\s*\*?from\s*:\s*.+\bsent\s*:/i,                // header block collapsed onto one line
];
/* "From:" alone is too common in ordinary writing, so it only counts as the
   start of a quote when the next few lines carry the rest of a header block. */
const HDR_FROM = /^\s*\*{0,2}from\s*:\s*\S/i;
const HDR_NEXT = /^\s*\*{0,2}(sent|date|to|cc|subject|reply-to)\s*:\s*\S/i;

function quoteStartsAt(lines, i) {
  const l = lines[i];
  if (QUOTE_LINE.some(re => re.test(l))) return true;
  if (HDR_FROM.test(l)) {
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) if (HDR_NEXT.test(lines[j])) return true;
  }
  // "On <long date>" that wrapped onto the next line before "wrote:"
  if (/^\s*on\b/i.test(l) && i + 1 < lines.length && /\bwrote\s*:\s*$/i.test((l + " " + lines[i + 1]).trim())) return true;
  return false;
}

/** Drop the quoted history: everything from the first quote marker downwards. */
function stripQuotes(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (quoteStartsAt(lines, i)) { cut = i; break; }
  }
  // A trailing run where every remaining non-blank line is ">"-quoted.
  let runStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith(">")) runStart = i; else break;
  }
  if (runStart >= 0 && (cut < 0 || runStart < cut)) cut = runStart;
  const kept = (cut < 0 ? lines : lines.slice(0, cut)).join("\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

/* ---- signature detection -------------------------------------------------
   Judged a line at a time, from the bottom up. "Strong" means a line that is
   almost only ever found in a signature; "soft" means a line that fits in one
   but would also fit elsewhere, so it is only removed when it sits next to
   something strong. That pairing is what stops a two-word answer like
   "Approved" being mistaken for a name and deleted. */
const SIG_SIGNOFF = /^(thanks?|thank you|thanks again|thx|many thanks|much appreciated|appreciate it|appreciated|regards|best|best regards|kind regards|warm regards|warmly|cheers|sincerely|respectfully|yours truly|talk soon|take care|all the best|v\/r|br)[\s,.!;:—–-]*$/i;
const SIG_HARD = [
  /^\s*--\s*$/,                                     // the standard signature delimiter
  /^\s*(-{3,}|_{3,}|={3,}|\*{3,}|•{3,})\s*$/,
  /^\s*(sent|enviado|gesendet)\s+(from|via|desde|von)\b/i,   // Sent from my iPhone
  /^\s*get\s+outlook\s+for\b/i,
];
const SIG_DISCLAIMER = /(confidential|privileged|intended (solely |only )?(for|recipient)|do not disclose|unauthori[sz]ed (use|review|disclosure)|if you (have )?received this (e-?mail|message) in error|please (notify|delete)|this (e-?mail|message) (and any|may contain))/i;
const RE_PHONE   = /(?:\+?\d[\s().-]{0,2}){7,}\d/;
const RE_EMAIL   = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const RE_URL     = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]{2,}\.(?:com|net|org|io|co|us|biz)\b/i;
const RE_LABEL   = /^\s*\(?(t|tel|telephone|p|ph|phone|m|mob|mobile|c|cell|d|direct|o|off|office|f|fax|e|email|w|web|a|addr|address)\)?\s*[:.|]\s*\S/i;
const RE_TITLE   = /\b(director|manager|president|vice ?president|ceo|cfo|coo|cto|owner|partner|principal|founder|supervisor|coordinator|administrator|assistant|specialist|engineer|technician|analyst|officer|executive|consultant|representative|regional|district|general manager|operations|maintenance|facilities|it support|help ?desk|purchasing|accounting|payroll|human resources|franchisee?)\b/i;
const RE_ADDRESS = /\b\d{1,6}\s+[\w.'-]+(\s+[\w.'-]+){0,4}\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pkwy|parkway|hwy|highway|suite|ste|unit|floor|fl)\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i;
const RE_SOCIAL  = /\b(linkedin|twitter|facebook|instagram|x\.com)\b/i;
const RE_LOGO    = /^\s*\[(cid:|image|logo)[^\]]*\]\s*$/i;

/** Does this line belong to a signature on its own merits? */
function strongSig(line, who) {
  const t = line.trim();
  if (!t) return false;
  if (RE_LOGO.test(t)) return true;
  if (RE_LABEL.test(t)) return true;
  if (RE_EMAIL.test(t)) return true;
  if (RE_URL.test(t)) return true;
  if (RE_SOCIAL.test(t)) return true;
  if (RE_ADDRESS.test(t)) return true;
  if (RE_PHONE.test(t) && t.length < 70) return true;
  if (RE_TITLE.test(t) && t.length < 70) return true;
  if (who.brand && t.length < 70 && t.toLowerCase().replace(/[^a-z]/g, "").includes(who.brand)) return true;
  if (who.names.length && t.length < 60 && who.names.some(n => t.toLowerCase().includes(n))) return true;
  return false;
}
/** Plausible inside a signature, but only when something strong is nearby. */
function softSig(line) {
  const t = line.trim();
  if (!t) return true;                               // blank lines ride along
  if (t.length > 52) return false;                   // that is a sentence, not a name
  if (/[.!?]$/.test(t) && t.split(/\s+/).length > 4) return false;
  if (/\|/.test(t)) return true;                     // "Name | Company"
  return /^[^a-z]*$/.test(t)                         // ALL CAPS line
      || t.split(/\s+/).length <= 6;                 // short fragment: name, title, city
}

/**
 * Remove the trailing signature block.
 * `who` carries what we know about the sender — their name and the company in
 * their email domain — because their own name appearing on a line of its own is
 * one of the clearest signals there is.
 */
function stripSignature(text, who) {
  who = who || {};
  /* Anything typed into "Also cut replies at these lines" in Settings → Email.
     Matched as a whole line, ignoring case and trailing punctuation, so a new
     house style can be handled without waiting on a redeploy. */
  const extra = (who.cutLines || []).map(x => String(x || "").trim().toLowerCase().replace(/[\s,.!;:—–-]+$/, "")).filter(Boolean);
  const isSignOff = line => {
    const t = String(line || "").trim();
    if (SIG_SIGNOFF.test(t)) return true;
    const bare = t.toLowerCase().replace(/[\s,.!;:—–-]+$/, "");
    return !!bare && extra.includes(bare);
  };
  const names = [];
  String(who.name || "").split(/[\s,()]+/).forEach(w => { if (w.length > 2) names.push(w.toLowerCase()); });
  if (who.name && String(who.name).trim().length > 2) names.push(String(who.name).trim().toLowerCase());
  const domain = String(who.email || "").split("@")[1] || "";
  const brand = (domain.split(".")[0] || "").replace(/[^a-z]/gi, "").toLowerCase();
  const ctx = { names, brand: brand.length > 3 ? brand : "" };

  let lines = String(text || "").split("\n");
  const keep = () => lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const before = keep();
  if (!before) return "";

  /* 1. A sign-off on a line of its own ends the message. Every Dossani
        signature opens with "Thank You," and runs straight on from the last
        sentence with no blank line between them, so there is no block to spot —
        the sign-off itself is the boundary, and everything below it goes.

        The one exception is a sign-off with nothing signature-like under it but
        real writing instead ("Thanks," then another question) — that is someone
        still talking, so it is left alone and the checks below handle it. */
  for (let i = 0; i < lines.length; i++) {
    if (!isSignOff(lines[i])) continue;
    const head = lines.slice(0, i).join("\n").trim();
    if (!head) continue;                                   // the whole reply is "Thanks!"
    const after = lines.slice(i + 1);
    const markers = after.some(l =>
      strongSig(l, ctx) || SIG_DISCLAIMER.test(l) || SIG_HARD.some(re => re.test(l)));
    const stillTalking = after.some(l => l.includes("?") || l.trim().length > 60);
    if (!markers && stillTalking) continue;
    lines = lines.slice(0, i);
    break;
  }

  // 2. Hard markers cut everything below them, however long they run.
  for (let i = 0; i < lines.length; i++) {
    if (SIG_HARD.some(re => re.test(lines[i])) || (SIG_DISCLAIMER.test(lines[i]) && i > 0)) {
      const head = lines.slice(0, i).join("\n").trim();
      if (head) { lines = lines.slice(0, i); break; }
    }
  }

  /* 3. Walk up a paragraph at a time. Judging whole paragraphs rather than
        single lines is what keeps a short message safe: "Looks good to me." is
        its own paragraph with nothing signature-like in it, so the walk stops
        there instead of nibbling into it. */
  const fits = l => strongSig(l, ctx) || softSig(l) || (l.trim().length <= 90 && !/[.!?]$/.test(l.trim()));
  let i = lines.length - 1, sawStrong = false;
  for (;;) {
    while (i >= 0 && !lines[i].trim()) i--;                          // trailing blanks
    if (i < 0) break;
    let start = i;
    while (start >= 0 && lines[start].trim()) start--;
    start++;
    const para = lines.slice(start, i + 1);
    if (para.length <= 14 && para.some(l => strongSig(l, ctx)) && para.every(fits)) {
      sawStrong = true; i = start - 1; continue;                     // a signature block
    }
    if (sawStrong && para.length === 1 && isSignOff(para[0])) {
      i = start - 1; continue;                                       // the "Thanks," above it
    }
    break;
  }
  if (sawStrong) {
    const head = lines.slice(0, i + 1).join("\n").trim();
    if (head) lines = lines.slice(0, i + 1);
  } else {
    // No signature markers — still drop a bare "Thanks," on the last line.
    let j = lines.length - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    if (j > 0 && isSignOff(lines[j])) {
      const head = lines.slice(0, j).join("\n").trim();
      if (head) lines = lines.slice(0, j);
    }
  }
  return keep() || before;
}

/** Just the words this person typed: no quoted history, no signature. */
function cutLinesFrom(master) {
  const raw = ((master && master.admins) || {}).notifyPrefs;
  const v = raw && raw.cutLines;
  return (Array.isArray(v) ? v : String(v || "").split("\n")).map(x => String(x || "").trim()).filter(Boolean);
}

function cleanReply(payload, who) {
  const raw = payload.TextBody || payload.StrippedTextReply || "";
  let out = stripQuotes(raw);
  // Postmark strips the quote its own way; if ours removed everything but
  // theirs kept something, theirs is the better starting point.
  if (!out && payload.StrippedTextReply) out = stripQuotes(payload.StrippedTextReply);
  out = stripSignature(out, who);
  return out.replace(/[ \t]+$/gm, "").trim();
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

/* Find the ticket a piece of mail belongs to: the +hash on the address first,
   then the [23086-PLM-0004] tag the subject always carries. Shared by the real
   handler and by the simulator behind the connection checker. */
function matchTicket(tickets, payload) {
  let id = String(payload.MailboxHash || "").trim();
  if (id && tickets[id]) return { id, how: "the +hash on the reply address" };
  const m = String(payload.Subject || "").match(/\[([A-Za-z0-9-]+-[A-Za-z]+-\d+)\]/);
  if (m) {
    const want = m[1].toUpperCase();
    const hit = Object.keys(tickets).find(k => String(tickets[k].shortId || "").toUpperCase() === want);
    if (hit) return { id: hit, how: `the ${m[1]} tag in the subject` };
  }
  return { id: "", how: null };
}

/* ── DIAGNOSTICS ─────────────────────────────────────────────────────────────
   FixMi's Settings → Email checker calls these with the shared secret in the
   body. "selftest" reports how this function is configured and proves it can
   actually write to the master; "simulate" runs a made-up reply all the way
   through and reports what WOULD happen, writing nothing and emailing nobody. */
async function diagnostics(p, req, res) {
  const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
  const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
  const self = (process.env.FIXMI_SELF_URL || `https://${req.headers.host}`).replace(/\/$/, "");

  let master = null, masterErr = null;
  try {
    const r = await fetch(masterUrl, { headers: { accept: "application/json" } });
    if (r.ok) master = await r.json(); else masterErr = `HTTP ${r.status}`;
  } catch (e) { masterErr = (e && e.message) || String(e); }

  if (p.event === "selftest") {
    // Proves the quote/signature stripping is the build we think it is.
    let parser = false, parserError = null;
    try {
      const probe = cleanReply({ TextBody: "Yes please.\n\nThanks,\nSam Smith\nAcme Corp\n555-123-4567\n\nOn Mon, X wrote:\n> hello" },
        { name: "Sam Smith", email: "sam@acme.com" });
      parser = probe === "Yes please.";
      if (!parser) parserError = `self-test returned ${JSON.stringify(probe)}`;
    } catch (e) { parserError = (e && e.message) || String(e); }

    /* Prove the write password, rather than only reporting that one is set —
       a wrong password is the failure that would otherwise only show up when a
       real reply silently vanished. Writes one tiny bookkeeping node. */
    let writeOk = null, writeErr = null;
    if (writePass) {
      try {
        const w = await fetch(masterUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: writePass, updates: { "admins/inboundCheck": { at: Date.now(), by: "connection check" } } }),
        });
        writeOk = w.ok;
        if (!w.ok) writeErr = `HTTP ${w.status} ${(await w.text().catch(() => "")).slice(0, 120)}`;
      } catch (e) { writeOk = false; writeErr = (e && e.message) || String(e); }
    }

    return res.status(200).json({
      ok: true,
      writePassPresent: !!writePass,
      writeOk, writeErr,
      replyDomain: process.env.FIXMI_REPLY_DOMAIN || "",
      basicAuth: !!(process.env.FIXMI_INBOUND_USER && process.env.FIXMI_INBOUND_PASS),
      parser, parserError,
      selfUrl: self,
      webhookUrl: `${self}/api/inbound?key=<your FIXMI_SHARED_SECRET>`,
      masterOk: !!master, masterErr,
      ticketsSeen: master ? Object.keys(master[DEFAULTS.ticketsNode] || {}).length : 0,
    });
  }

  if (p.event === "simulate") {
    if (!master) return res.status(200).json({ ok: false, reason: `could not read the master (${masterErr})` });
    const tickets = master[DEFAULTS.ticketsNode] || {};
    const from = lc(p.from);
    if (!from.includes("@")) return res.status(200).json({ ok: false, reason: "give a from address" });

    const payload = {
      FromFull: { Email: from, Name: p.fromName || "" },
      From: from,
      Subject: p.subject || "",
      TextBody: p.text || "",
      StrippedTextReply: "",
      MailboxHash: p.ticketId || "",
      MessageID: "simulated",
      Headers: [],
    };

    const automated = isAutomated(payload);
    const { id, how } = matchTicket(tickets, payload);
    const ticket = id ? tickets[id] : null;
    const text = cleanReply(payload, { name: p.fromName || "", email: from, cutLines: cutLinesFrom(master) });
    const known = identify(master, from);
    const by = known ? known.name : ((p.fromName || "").trim() ? `${p.fromName.trim()} (${from})` : from);
    const dupe = !!(ticket && arr(ticket.comments).some(c => c && lc(c.email) === from && String(c.text || "").trim() === text.trim()));

    // Who the comment notification would go to — asked of /api/notify so the
    // answer comes from the same code that really sends it.
    let wouldEmail = null, notifyErr = null;
    if (ticket && !automated && text) {
      try {
        const j = await callNotify({ event: "selftest", ticketId: id, forEvent: "comment", actorEmail: from, _master: master }, req);
        if (j && j.ticket) wouldEmail = arr(j.ticket.recipients).map(x => `${x.email} (${x.role})`);
        else notifyErr = (j && j.error) || "no answer from the notifier";
      } catch (e) { notifyErr = (e && e.message) || String(e); }
    }

    const store = ticket ? (master.restaurants || {})[ticket.storeId] || {} : {};
    return res.status(200).json({
      ok: true,
      automated,
      matched: !!ticket,
      matchedBy: how,
      ticket: ticket ? { id, shortId: ticket.shortId || id, store: store.storeName || store.name || ticket.storeId || "", comments: arr(ticket.comments).length } : null,
      author: { by, role: known ? known.role : "guest", known: !!known },
      wouldWatch: !known,
      text,
      rawChars: String(p.text || "").length,
      keptChars: text.length,
      removed: (() => {
        const rawNorm = String(p.text || "").replace(/\r\n?/g, "\n");
        if (!text) return rawNorm.trim();
        const last = text.split("\n").pop();
        const at = rawNorm.lastIndexOf(last);
        return at < 0 ? "" : rawNorm.slice(at + last.length).trim();
      })(),
      duplicate: dupe,
      wouldEmail, notifyErr,
    });
  }

  return res.status(400).json({ error: "unknown diagnostic event" });
}

/* Send through /api/notify. Calling its handler in this same process is much
   faster than an HTTP round trip to ourselves — no second cold start and no
   second download of the master, which between them were most of the delay a
   replier felt before their comment showed up. Falls back to the HTTP call if
   the module can't be loaded for any reason. */
async function callNotify(payload, req) {
  const body = { secret: process.env.FIXMI_SHARED_SECRET, ...payload };
  try {
    const handler = require("./notify.js");
    let code = 200, out = null;
    await handler({ method: "POST", body, query: {}, headers: {} }, {
      status(c) { code = c; return this; },
      setHeader() {},
      json(o) { out = o; return this; },
      end() { return this; },
    });
    if (code >= 400) console.error("[fixmi-inbound] notify returned", code, out);
    return out;
  } catch (e) {
    console.warn("[fixmi-inbound] in-process notify failed, falling back to HTTP:", e && e.message);
  }
  try {
    const self = (process.env.FIXMI_SELF_URL || `https://${req.headers.host}`).replace(/\/$/, "");
    const n = await fetch(`${self}/api/notify`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await n.json().catch(() => null);
  } catch (e) {
    console.error("[fixmi-inbound] comment saved but the notification failed", e && e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  const allowOrigin = process.env.FIXMI_ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const ok = (body) => res.status(200).json(body);            // always 200: see the note up top
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const t0 = Date.now();
  try {
    const p = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    /* FixMi's own checker, not Postmark. Postmark payloads never carry a
       `secret`, so the two can't be confused. Authenticated by the same shared
       secret the app already holds. */
    if (p && typeof p.event === "string" && ["selftest", "simulate"].includes(p.event)) {
      const want = process.env.FIXMI_SHARED_SECRET || "";
      if (!want) return res.status(500).json({ error: "FIXMI_SHARED_SECRET is not set" });
      if (p.secret !== want) return res.status(401).json({ error: "bad secret" });
      return await diagnostics(p, req, res);
    }

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
    const tRead = Date.now();
    const tickets = master[DEFAULTS.ticketsNode] || {};

    // No hash means someone wrote to the address directly, or forwarded it —
    // matchTicket falls back to the [23086-PLM-0004] tag in the subject.
    const { id } = matchTicket(tickets, p);
    if (!id || !tickets[id]) {
      console.log("[fixmi-inbound] no ticket for", p.MailboxHash, "|", p.Subject);
      return ok({ ignored: true, reason: "could not tell which ticket this reply belongs to" });
    }
    const ticket = tickets[id];

    // --- the words -----------------------------------------------------------
    const text = cleanReply(p, { name: fromName, email: fromEmail, cutLines: cutLinesFrom(master) });
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
    const tWrite = Date.now();
    if (!w.ok) {
      const detail = await w.text().catch(() => "");
      console.error("[fixmi-inbound] write failed", w.status, detail.slice(0, 200));
      return ok({ ignored: true, reason: `could not save the comment (HTTP ${w.status})` });
    }

    // --- tell everyone else --------------------------------------------------
    const notified = await callNotify({
      event: "comment",
      ticketId: id,
      ticket: updated,
      comment: { by, text, ts: comment.ts },
      thread: comments.slice(-25).map(c => ({ by: c.by, role: c.role, email: c.email, text: c.text, ts: c.ts })),
      actorEmail: fromEmail,              // the replier doesn't get their own reply back
      actorName: by,
      _master: master,
    }, req);

    console.log("[fixmi-inbound] comment added to", ticket.shortId || id, "from", fromEmail,
      "| emailed:", (notified && notified.to) || "none",
      "| ms:", JSON.stringify({ read: tRead - t0, write: tWrite - tRead, notify: Date.now() - tWrite, total: Date.now() - t0 }));
    return ok({ ok: true, ticket: ticket.shortId || id, from: fromEmail, chars: text.length, notified: (notified && notified.to) || [], ms: Date.now() - t0 });
  } catch (e) {
    console.error("[fixmi-inbound] crashed", e);
    return res.status(200).json({ ignored: true, error: String((e && e.message) || e) });
  }
};

module.exports.cleanReply = cleanReply;
module.exports.stripQuotes = stripQuotes;
module.exports.stripSignature = stripSignature;
module.exports.isAutomated = isAutomated;
module.exports.identify = identify;
module.exports.matchTicket = matchTicket;
