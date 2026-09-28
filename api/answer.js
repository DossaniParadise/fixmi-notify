/**
 * One-click answers from the weekly summary email.
 *
 * A General Manager opens their Monday summary and, against each open ticket,
 * presses "Yes — still open" or "No — it's fixed". That press lands here. We
 * write their answer onto the ticket as a comment in their name, then email
 * everyone else on the ticket — never the person who just pressed it — and show
 * them a small page saying it worked.
 *
 * No login: the link has to work from a phone, a week later, with one tap. What
 * makes that safe is the signature. Each link is signed with FIXMI_SHARED_SECRET
 * over the ticket, the answer and the address it was sent to, so the three
 * cannot be edited into a different combination, and a link for one ticket is
 * useless against another.
 *
 * Answered twice — a double tap, an email client pre-fetching links — only
 * writes once; the second press just shows the same confirmation.
 */

const crypto = require("crypto");

const DEFAULTS = {
  masterUrl: "https://alignment-api-khaki.vercel.app/api/dpm-alignment",
  appUrl: "https://dossaniparadise.github.io/DPM-FixMi/",
  ticketsNode: "maintenanceTickets",
};
const lc = v => String(v || "").trim().toLowerCase();
const arr = v => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : (v ? [v] : []));
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const TEXT = {
  yes: "This issue is still not resolved.",
  no: "This issue has been resolved.",
};

function sign(ticketId, answer, email) {
  return crypto.createHmac("sha256", process.env.FIXMI_SHARED_SECRET || "")
    .update(`${ticketId}|${answer}|${lc(email)}`).digest("hex").slice(0, 32);
}
/** Compare in constant time, so the signature can't be guessed a byte at a time. */
function sigOk(given, want) {
  const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function page({ title, line, tone, link }) {
  const colour = tone === "bad" ? "#e8091b" : tone === "warn" ? "#b45309" : "#059669";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:440px;margin:12vh auto;padding:0 18px">
  <div style="background:#fff;border-radius:14px;padding:30px 26px;box-shadow:0 8px 28px rgba(20,30,45,.09)">
    <div style="width:46px;height:46px;border-radius:50%;background:${colour};color:#fff;font-size:24px;line-height:46px;text-align:center;font-weight:700">
      ${tone === "bad" ? "!" : "&#10003;"}</div>
    <h1 style="font-size:20px;margin:18px 0 8px">${esc(title)}</h1>
    <p style="font-size:15px;line-height:1.55;color:#4b5563;margin:0">${esc(line)}</p>
    ${link ? `<a href="${esc(link)}" style="display:inline-block;margin-top:20px;background:#1d76bb;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:9px">Open the ticket in FixMi</a>` : ""}
  </div>
  <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px">Dossani Paradise · FixMi</p>
</div></body></html>`;
}

module.exports = async (req, res) => {
  const html = (code, opts) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.statusCode = code;
    res.end(page(opts));                                   // end(), not send(): always there
  };
  try {
    const q = req.query || {};
    const ticketId = String(q.t || "").trim();
    const answer = lc(q.a);
    const email = lc(q.e);
    const secret = process.env.FIXMI_SHARED_SECRET || "";
    const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
    const appUrl = process.env.FIXMI_APP_URL || DEFAULTS.appUrl;

    if (!secret) return html(500, { title: "Not set up yet", line: "FIXMI_SHARED_SECRET is missing on the server, so this link can't be checked.", tone: "bad" });
    if (!ticketId || !["yes", "no"].includes(answer) || !email)
      return html(400, { title: "That link is incomplete", line: "Please open the ticket in FixMi and leave a comment there instead.", tone: "bad" });
    if (!sigOk(q.s, sign(ticketId, answer, email)))
      return html(403, { title: "That link isn't valid", line: "It may have been altered or retyped. Open the ticket in FixMi and comment there instead.", tone: "bad" });
    if (!writePass)
      return html(500, { title: "Not set up yet", line: "FIXMI_WRITE_PASSWORD is missing on the server, so your answer can't be saved.", tone: "bad" });

    const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
    const r = await fetch(masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return html(502, { title: "Couldn't reach FixMi", line: "Please try again in a minute.", tone: "bad" });
    const master = await r.json();
    const ticket = (master[DEFAULTS.ticketsNode] || {})[ticketId];
    if (!ticket) return html(404, { title: "That ticket is gone", line: "It may have been closed and archived since the summary was sent.", tone: "warn" });

    const url = `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticketId)}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
    const text = TEXT[answer];

    /* Who is answering. The address was signed into the link, so this is the
       person the summary was addressed to, not whoever forwarded it. */
    const store = (master.restaurants || {})[ticket.storeId] || {};
    let by = store.storeManager || store.storeName || email, role = "manager";
    [["admins", "admin"], ["directors", "director"], ["areaCoaches", "coach"], ["repairTechnicians", "tech"]].forEach(([g, rl]) => {
      Object.values(master[g] || {}).forEach(o => { if (o && lc(o.email) === email) { by = o.name || by; role = rl; } });
    });

    const comments = arr(ticket.comments).slice();
    const already = comments.find(c => c && c.answerKey === `${ticketId}|${answer}|${email}`);
    if (already) {
      return html(200, {
        title: answer === "yes" ? "Already noted — still open" : "Already noted — resolved",
        line: `Your answer was recorded on ${ticket.shortId || "this ticket"} and everyone on it has been told. Nothing more to do.`,
        link: url,
      });
    }

    comments.push({
      id: uid(), by, role, email, text,
      ts: Date.now(),
      viaEmail: true,
      answer,                                    // so the app can show it as an answer, not just a comment
      answerKey: `${ticketId}|${answer}|${email}`,
    });
    const updated = { ...ticket, comments, updatedAt: Date.now() };

    const w = await fetch(masterUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: writePass, updates: { [`${DEFAULTS.ticketsNode}/${ticketId}`]: updated } }),
    });
    if (!w.ok) {
      console.error("[fixmi-answer] write failed", w.status, (await w.text().catch(() => "")).slice(0, 200));
      return html(502, { title: "Couldn't save that", line: "Please open the ticket in FixMi and leave a comment there instead.", tone: "bad", link: url });
    }

    // Everyone else on the ticket hears about it — never the person answering.
    try {
      const notify = require("./notify.js");
      await notify({ method: "POST", query: {}, headers: {}, body: {
        secret, event: "comment", ticketId, ticket: updated,
        comment: { by, text, ts: Date.now() },
        thread: comments.slice(-25).map(c => ({ by: c.by, role: c.role, email: c.email, text: c.text, ts: c.ts })),
        actorEmail: email, actorName: by, _master: master,
      } }, { status() { return this; }, setHeader() {}, json() { return this; }, end() { return this; } });
    } catch (e) {
      console.error("[fixmi-answer] saved, but the notification failed", e && e.message);
    }

    console.log("[fixmi-answer]", ticket.shortId || ticketId, answer, "from", email);
    return html(200, {
      title: answer === "yes" ? "Thanks — marked as still open" : "Thanks — marked as resolved",
      line: answer === "yes"
        ? `We've noted that ${ticket.shortId || "this ticket"} is still a problem, and told everyone working on it.`
        : `We've noted that ${ticket.shortId || "this ticket"} is fixed, and told everyone working on it.`,
      link: url,
    });
  } catch (e) {
    console.error("[fixmi-answer] crashed", e);
    return html(500, { title: "Something went wrong", line: "Please open the ticket in FixMi and leave a comment there instead.", tone: "bad" });
  }
};

module.exports.sign = sign;
