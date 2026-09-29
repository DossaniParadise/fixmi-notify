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

/* Both answers write a comment in the presser's name. Whether one of them
   also moves the ticket depends on who is pressing it.

   A General Manager is reporting what they can see on the floor: the problem
   has gone away. That is worth saying on the thread, but it is not a decision
   about where the ticket sits. A District Manager pressing the same button is
   making that decision, so theirs moves it to Finished — not Closed, because
   closing is for whoever checks the work and writes the closing notes. */
const ANSWERS = {
  unresolved: { text: ts => `This issue is still unresolved as of ${ts}.`, status: null,
                title: "Thanks — marked as still unresolved",
                line: id => `We've noted that ${id} is still a problem, and told everyone working on it.` },
  resolved:   { text: ts => `This issue has been resolved as of ${ts}, and the ticket can be closed.`, status: "finished",
                title: "Thanks — marked as resolved",
                line: id => `Your answer is on ${id} and everyone working on it has been told.`,
                movedLine: id => `${id} has been moved to Finished and everyone working on it has been told.` },
};
/* Only these roles carry a press through to the ticket's status. Anyone else —
   a GM, a forwarded link, an older link with no role on it at all — writes the
   comment and stops there, which is the harmless half of the action. */
const MAY_MOVE = { dm: true };
// Links sent before the wording changed still work.
const LEGACY = { yes: "unresolved", no: "resolved" };

function stampNow() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/* The week the summary went out is signed in too, so this week's link is a
   different link from last week's. Without it, a manager who answered
   "unresolved" last Monday would find the same answer refused as a duplicate
   every week afterwards. */
function sign(ticketId, answer, email, when, role) {
  return crypto.createHmac("sha256", process.env.FIXMI_SHARED_SECRET || "")
    .update(`${ticketId}|${answer}|${lc(email)}|${when || ""}${role ? "|" + lc(role) : ""}`).digest("hex").slice(0, 32);
}
/** Compare in constant time, so the signature can't be guessed a byte at a time. */
function sigOk(given, want) {
  const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* The alignment master sits behind a CDN that will serve a copy up to a minute
   old. This handler reads a ticket, adds to it and writes the whole thing back,
   so a stale copy is not a cosmetic problem: a GM answering at 9:00:10 and a DM
   answering at 9:00:30 would both read the world as it was before either of
   them pressed, and the second write would erase the first one's comment. A
   unique query string is a different object to the CDN, so this reaches the
   origin every time; if the API ever objects to the extra parameter, the plain
   read still runs. */
async function readMaster(url) {
  const opts = { headers: { accept: "application/json", "cache-control": "no-cache" }, cache: "no-store" };
  const bust = url + (url.includes("?") ? "&" : "?") + "_fresh=" + Date.now().toString(36);
  const r = await fetch(bust, opts).catch(() => null);
  return (r && r.ok) ? r : fetch(url, opts);
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
    const answer = LEGACY[lc(q.a)] || lc(q.a);
    const email = lc(q.e);
    const when = String(q.w || "").trim();          // the week this went out
    /* No role on the link means it was built before roles existed. Treat that
       as the GM case: write the comment, leave the status alone. */
    const linkRole = lc(q.r) || "gm";
    const secret = process.env.FIXMI_SHARED_SECRET || "";
    const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
    const appUrl = process.env.FIXMI_APP_URL || DEFAULTS.appUrl;

    if (!secret) return html(500, { title: "Not set up yet", line: "FIXMI_SHARED_SECRET is missing on the server, so this link can't be checked.", tone: "bad" });
    if (!ticketId || !ANSWERS[answer] || !email)
      return html(400, { title: "That link is incomplete", line: "Please open the ticket in FixMi and leave a comment there instead.", tone: "bad" });
    if (![sign(ticketId, answer, email, when, q.r ? linkRole : null),
          sign(ticketId, lc(q.a), email, when, q.r ? linkRole : null)].some(want => sigOk(q.s, want)))
      return html(403, { title: "That link isn't valid", line: "It may have been altered or retyped. Open the ticket in FixMi and comment there instead.", tone: "bad" });
    if (!writePass)
      return html(500, { title: "Not set up yet", line: "FIXMI_WRITE_PASSWORD is missing on the server, so your answer can't be saved.", tone: "bad" });

    const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
    const r = await readMaster(masterUrl);
    if (!r.ok) return html(502, { title: "Couldn't reach FixMi", line: "Please try again in a minute.", tone: "bad" });
    const master = await r.json();
    const ticket = (master[DEFAULTS.ticketsNode] || {})[ticketId];
    if (!ticket) return html(404, { title: "That ticket is gone", line: "It may have been closed and archived since the summary was sent.", tone: "warn" });

    const url = `${appUrl.replace(/#.*$/, "")}#t/${encodeURIComponent(ticket.shortId || ticketId)}${ticket.shareToken ? "/" + ticket.shareToken : ""}`;
    const spec = ANSWERS[answer];
    const text = spec.text(stampNow());

    /* Who is answering. The address was signed into the link, so this is the
       person the summary was addressed to, not whoever forwarded it. */
    const store = (master.restaurants || {})[ticket.storeId] || {};
    let by = store.storeManager || store.storeName || email, role = "manager";
    [["admins", "admin"], ["directors", "director"], ["areaCoaches", "coach"], ["repairTechnicians", "tech"]].forEach(([g, rl]) => {
      Object.values(master[g] || {}).forEach(o => { if (o && lc(o.email) === email) { by = o.name || by; role = rl; } });
    });

    const comments = arr(ticket.comments).slice();
    const key = `${ticketId}|${answer}|${email}|${when}`;
    const already = comments.find(c => c && c.answerKey === key);
    if (already) {
      return html(200, {
        title: `Already noted — ${answer}`,
        line: `Your answer was recorded on ${ticket.shortId || "this ticket"} and everyone on it has been told. Nothing more to do.`,
        link: url,
      });
    }

    const prevStatus = ticket.status;
    comments.push({
      id: uid(), by, role, email, text,
      ts: Date.now(),
      viaEmail: true,
      answer,                                    // so the app can show it as an answer, not just a comment
      answerKey: key,
    });
    const updated = { ...ticket, comments, updatedAt: Date.now() };

    /* A District Manager's "Resolved" moves it to Finished, with a line on the
       ticket's own timeline so the move has an author rather than appearing
       from nowhere. Already finished or closed is left alone — nothing to move,
       and re-opening a closed ticket from an email would be a nasty surprise. */
    const moved = !!MAY_MOVE[linkRole] && spec.status && prevStatus !== spec.status && prevStatus !== "closed";
    if (moved) {
      updated.status = spec.status;
      updated.activity = [...arr(ticket.activity), {
        ts: Date.now(), by, role, action: "status", toStatus: spec.status,
        note: "Marked resolved from the weekly summary email",
      }];
    }

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
      /* One email, not two. A move to Finished goes out as the status change it
         is, carrying the comment with it; an "unresolved" answer is only a
         comment, so that is what it goes out as. */
      await notify({ method: "POST", query: {}, headers: {}, body: {
        secret, event: moved ? "status" : "comment", ticketId, ticket: updated,
        prevStatus,
        comment: { by, text, ts: Date.now() },
        thread: comments.slice(-25).map(c => ({ by: c.by, role: c.role, email: c.email, text: c.text, ts: c.ts })),
        actorEmail: email, actorName: by, _master: master,
      } }, { status() { return this; }, setHeader() {}, json() { return this; }, end() { return this; } });
    } catch (e) {
      console.error("[fixmi-answer] saved, but the notification failed", e && e.message);
    }

    console.log("[fixmi-answer]", ticket.shortId || ticketId, answer, "from", email, `(${linkRole})`, moved ? "→ finished" : "comment only");
    const shortId = ticket.shortId || "this ticket";
    return html(200, { title: spec.title, line: (moved && spec.movedLine ? spec.movedLine : spec.line)(shortId), link: url });
  } catch (e) {
    console.error("[fixmi-answer] crashed", e);
    return html(500, { title: "Something went wrong", line: "Please open the ticket in FixMi and leave a comment there instead.", tone: "bad" });
  }
};

module.exports.sign = sign;
