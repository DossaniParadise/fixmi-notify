/**
 * The Monday page.
 *
 * The weekly summary used to put a pair of one-click buttons against every
 * ticket. That worked for one answer, but on a Monday morning it meant forty
 * managers each opening a tab per ticket and firing a write per tab — a pile
 * of browser tabs for them and a burst of conflicting writes for us.
 *
 * So the email now carries ONE link. It opens this page, which lists that
 * person's open tickets with a three-way switch against each: grey in the
 * middle until they say, red for still a problem, green for sorted. Flipping
 * one saves it there and then; they never leave the page and nothing opens a
 * new tab.
 *
 * Nothing here sends email. Hundreds of "a comment was added" notifications
 * landing on everyone at 9am is exactly what this is replacing.
 *
 * Signed, not logged in: the link has to work from a phone, a week later, with
 * one tap. The signature covers who it was sent to, what they are (a GM
 * answers for one store, a DM for their patch) and the week it went out, so a
 * link cannot be edited into somebody else's stores or replayed next week.
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

const OPEN_STATUSES = ["unassigned", "assigned", "dispatched", "waiting", "in_progress", "finished"];
const PRI_RANK = { emergency: 0, urgent: 1, normal: 2 };
const STATUS_LABEL = {
  unassigned: "Unassigned", assigned: "Assigned", dispatched: "Dispatched", waiting: "Waiting",
  in_progress: "In Progress", finished: "Finished", closed: "Closed",
};
const PRIORITY_LABEL = { normal: "Normal", urgent: "Urgent", emergency: "Emergency" };
/* The severity trio used across FixMi's emails — validated for colour-blind
   separation and contrast. Each one always carries its word too. */
const SEV = { emergency: "#c81e1e", urgent: "#c2740a", normal: "#1d76bb" };

/* Every comment and status change this page makes is stamped, so a week later
   it is obvious which answers came from the Monday round and which were
   somebody actually working the ticket. */
const TAG = "via Monday update";

/* ---- the link ------------------------------------------------------------
   Signed over the person, their role and the week. `role` matters: it decides
   both which stores they see and whether their "resolved" moves the ticket. */
function sign(email, role, week, preview) {
  return crypto.createHmac("sha256", process.env.FIXMI_SHARED_SECRET || "")
    .update(`monday|${lc(email)}|${lc(role)}|${week || ""}${preview ? "|p" : ""}`).digest("hex").slice(0, 32);
}
function sigOk(given, want) {
  const a = Buffer.from(String(given || ""), "utf8"), b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function mondayUrl(base, email, role, week, preview) {
  const q = new URLSearchParams({
    e: lc(email), r: lc(role), w: week || "",
    ...(preview ? { p: "1" } : {}),
    s: sign(email, role, week, preview),
  });
  return `${String(base).replace(/\/$/, "")}/api/monday?${q}`;
}

/* ---- reading the master --------------------------------------------------
   Two problems at once. The API is behind a CDN that can serve a copy a minute
   old, which would let one person's answer erase another's; and on a Monday
   one person flips a dozen switches in under a minute, which would mean a
   dozen downloads of a multi-megabyte document.

   So: always bypass the CDN, and keep the result on the warm function instance
   for a few seconds. A burst of flips from one person collapses onto a single
   download; a flip a minute later reads fresh. The cache is only ever used to
   READ surrounding data — every write re-reads the one ticket it is changing
   immediately beforehand. */
let _cache = { at: 0, master: null };
/* Deliberately short. It exists to collapse a burst — somebody going down the
   page flipping six switches in ten seconds — not to keep a working copy. The
   window is also the only period in which two people answering the SAME
   ticket could tread on each other, so it is kept to roughly one human pause.
   Every write updates the cached copy in place, so a run of flips from one
   person is always writing onto its own latest state. */
const CACHE_MS = 2500;

async function fetchMaster(url) {
  const opts = { headers: { accept: "application/json", "cache-control": "no-cache" }, cache: "no-store" };
  const bust = url + (url.includes("?") ? "&" : "?") + "_fresh=" + Date.now().toString(36);
  let r = await fetch(bust, opts).catch(() => null);
  if (!r || !r.ok) r = await fetch(url, opts);
  if (!r.ok) throw new Error(`master read failed (HTTP ${r.status})`);
  return r.json();
}
async function readMaster(url, fresh) {
  if (!fresh && _cache.master && (Date.now() - _cache.at) < CACHE_MS) return _cache.master;
  const master = await fetchMaster(url);
  _cache = { at: Date.now(), master };
  return master;
}

function storeCoachIds(store) {
  let ids = [];
  if (Array.isArray(store.assignedAreaCoachIds)) ids = store.assignedAreaCoachIds.slice();
  else if (store.assignedAreaCoachIds && typeof store.assignedAreaCoachIds === "object") ids = Object.values(store.assignedAreaCoachIds);
  else if (store.assignedAreaCoachId) ids = [store.assignedAreaCoachId];
  return [...new Set(ids.filter(Boolean))];
}
function storeLabel(store) {
  const name = String(store.storeName || "Store").trim();
  const num = String(store.storeNumber || "").replace(/^#+/, "").trim();
  return (!num || name.includes(num)) ? name : `${name} #${num}`;
}
function ageOf(ts) {
  const n = Number(ts); if (!n) return "";
  const d = Math.floor((Date.now() - n) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
}

/** Which stores this person answers for. A GM has one; a DM has their patch. */
function storesFor(master, email, role) {
  const stores = master.restaurants || {};
  const me = lc(email);
  if (role === "gm") return Object.keys(stores).filter(sid => lc(stores[sid].email) === me);
  if (role === "dm") {
    const mine = Object.entries(master.areaCoaches || {}).filter(([, c]) => c && lc(c.email) === me).map(([id]) => id);
    return Object.keys(stores).filter(sid => storeCoachIds(stores[sid]).some(id => mine.includes(id)));
  }
  return [];
}
function openTicketsFor(master, sid) {
  return Object.entries(master[DEFAULTS.ticketsNode] || {})
    .filter(([, t]) => t && t.storeId === sid && OPEN_STATUSES.includes(t.status))
    .map(([id, t]) => ({ ...t, _id: id }))
    .sort((a, b) => (PRI_RANK[a.priority] ?? 2) - (PRI_RANK[b.priority] ?? 2) || (a.createdAt || 0) - (b.createdAt || 0));
}

/* What this person already said this week, read back off the ticket so the
   page can come back later in the week with the switches where they left
   them. The comment carries the week it belongs to, so last week's answer
   does not pre-set this week's switch. */
function answeredBy(ticket, email, week) {
  const mine = arr(ticket.comments).filter(c => c && c.mondayKey &&
    c.mondayKey === `${lc(email)}|${week}`);
  return mine.length ? mine[mine.length - 1].answer : null;
}

/* ---- the page ------------------------------------------------------------ */
function shell(inner, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>
  :root{--bg:#f3f4f6;--card:#fff;--ink:#111827;--dim:#6b7280;--line:#e5e7eb;--brand:#1d76bb;
    --track:#d8dce3;--red:#c81e1e;--green:#047857}
  @media (prefers-color-scheme: dark){:root{--bg:#0b1220;--card:#1e293b;--ink:#e6eaf2;--dim:#a3b1c6;
    --line:#334155;--brand:#7cc0f5;--track:#3b4a61;--red:#f87171;--green:#4ade80}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:620px;margin:0 auto;padding:20px 14px 110px}
  .pv{background:#fef3c7;border:1px solid #d9a404;color:#5b4408;border-radius:10px;
    padding:12px 14px;font-size:13.5px;line-height:1.55;margin:0 0 14px}
  .pv b{display:block;margin-bottom:2px}
  /* After the light rule, not up with the other dark tokens — same specificity,
     so whichever comes last wins. */
  @media (prefers-color-scheme: dark){.pv{background:#3a2f0b;border-color:#8a6d0d;color:#fde68a}}
  .hd{padding:6px 4px 16px}
  .hd h1{font-size:23px;margin:0 0 6px;line-height:1.25}
  .hd p{margin:0;color:var(--dim);font-size:14.5px;line-height:1.5}
  .store{font-size:12px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;
    color:var(--dim);margin:22px 4px 9px}
  .t{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px 15px;margin-bottom:11px}
  .t.busy{opacity:.55}
  .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
  .pri{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#fff;
    border-radius:5px;padding:3px 8px}
  .meta{font-size:12px;color:var(--dim)}
  .desc{font-size:16.5px;line-height:1.4;font-weight:600;margin-bottom:13px}
  /* The switch. Three positions, and the word under it always says which one
     is chosen — colour alone would leave a colour-blind manager guessing. */
  .sw{display:flex;align-items:center;gap:10px}
  .track{position:relative;display:flex;background:var(--track);border-radius:999px;padding:3px;gap:3px;
    flex:1;max-width:280px}
  .track button{flex:1;border:0;background:none;border-radius:999px;padding:9px 6px;cursor:pointer;
    font-size:12.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#4b5563;
    -webkit-tap-highlight-color:transparent;transition:background .14s,color .14s}
  @media (prefers-color-scheme: dark){.track button{color:#cbd5e1}}
  .track button[aria-pressed="true"].no{background:var(--red);color:#fff}
  .track button[aria-pressed="true"].yes{background:var(--green);color:#fff}
  @media (prefers-color-scheme: dark){
    .track button[aria-pressed="true"].no,.track button[aria-pressed="true"].yes{color:#0b1220}}
  .state{font-size:12px;color:var(--dim);min-width:62px}
  .state.ok{color:var(--green);font-weight:700}
  .state.err{color:var(--red);font-weight:700}
  .done{text-align:center;color:var(--dim);font-size:14px;padding:30px 10px}
  .bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
    padding:13px 16px;font-size:13.5px;color:var(--dim);text-align:center}
  .bar b{color:var(--ink)}
  a{color:var(--brand)}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

function ticketCard(t, store, chosen) {
  const pri = lc(t.priority) || "normal";
  return `<div class="t" id="t_${esc(t._id)}">
    <div class="top">
      <span class="pri" style="background:${SEV[pri] || SEV.normal}">${esc(PRIORITY_LABEL[pri] || pri)}</span>
      <span class="meta">${esc(t.shortId || "")} &nbsp;·&nbsp; ${esc(STATUS_LABEL[t.status] || t.status)} &nbsp;·&nbsp; open ${esc(ageOf(t.createdAt))}</span>
    </div>
    <div class="desc">${esc(t.description || "No description")}</div>
    <div class="sw">
      <div class="track">
        <button type="button" class="no"  aria-pressed="${chosen === "unresolved"}" onclick="flip('${esc(t._id)}','unresolved')">Still broken</button>
        <button type="button" class="yes" aria-pressed="${chosen === "resolved"}"   onclick="flip('${esc(t._id)}','resolved')">Sorted</button>
      </div>
      <span class="state${chosen ? " ok" : ""}" id="s_${esc(t._id)}">${chosen ? "Saved" : ""}</span>
    </div>
  </div>`;
}

function buildPage({ master, email, role, week, selfUrl, q, preview }) {
  const sids = storesFor(master, email, role);
  const stores = master.restaurants || {};
  const blocks = sids.map(sid => ({ sid, label: storeLabel(stores[sid] || {}), tickets: openTicketsFor(master, sid) }))
    .filter(b => b.tickets.length)
    .sort((a, b) => b.tickets.length - a.tickets.length || a.label.localeCompare(b.label));
  const total = blocks.reduce((n, b) => n + b.tickets.length, 0);
  const answered = blocks.reduce((n, b) => n + b.tickets.filter(t => answeredBy(t, email, week)).length, 0);

  const whoName = nameFor(master, email, role);
  const who = preview ? (role === "dm" ? "these stores" : "this store")
                      : (role === "dm" ? "your stores" : "your store");
  /* A sample is somebody else's page. Say whose, at the top, before anything
     else — otherwise it reads as a live list of tickets you are responsible
     for, and the switches look like they did something. */
  const banner = preview
    ? `<div class="pv"><b>Sample — nothing here is saved.</b> This is the page ${esc(whoName)}
         (${esc(email)}) will get as ${role === "dm" ? "a District Manager" : "a General Manager"}.
         The switches move so you can see how it behaves; no comment is written and no ticket moves.</div>`
    : "";
  const head = `<div class="hd">
    <h1>${total ? `${total} open ticket${total === 1 ? "" : "s"} at ${who}` : `Nothing open at ${who}`}</h1>
    <p>${!total ? "Nothing needs an answer this week."
      : preview
        ? "Tap <b>Still broken</b> or <b>Sorted</b> against any of them — the switch flips and that is all that happens."
        : "Tap <b>Still broken</b> or <b>Sorted</b> against each one. Each tap saves on its own — there is no button at the end, and nothing here emails anybody."}</p>
  </div>`;

  const body = blocks.map(b => `<div class="store">${esc(b.label)} · ${b.tickets.length}</div>` +
    b.tickets.map(t => ticketCard(t, stores[b.sid] || {}, answeredBy(t, email, week))).join("")).join("");

  const bar = total
    ? `<div class="bar" id="bar"><b><span id="n">${answered}</span> of ${total}</b> answered — ${preview
        ? "this is a sample, so none of it is recorded."
        : "you can close this page at any time."}</div>`
    : "";

  const js = `<script>
    var POST=${JSON.stringify(`${selfUrl}/api/monday`)},Q=${JSON.stringify(q)},TOTAL=${total},PREVIEW=${preview ? "true" : "false"};
    var done={};${blocks.flatMap(b => b.tickets.filter(t => answeredBy(t, email, week))
      .map(t => `done[${JSON.stringify(t._id)}]=1;`)).join("")}
    /* One flip at a time, in the order they were tapped. A manager going down
       the page faster than the network would otherwise have several writes to
       the same store in flight at once. */
    var queue=[],busy=false;
    function flip(id,answer){
      var card=document.getElementById("t_"+id);
      var btns=card.querySelectorAll(".track button");
      for(var i=0;i<btns.length;i++)btns[i].setAttribute("aria-pressed",String(btns[i].className===(answer==="resolved"?"yes":"no")));
      say(id,PREVIEW?"Checking…":"Saving…","");
      queue=queue.filter(function(x){return x.id!==id});   // a change of mind replaces the pending one
      queue.push({id:id,answer:answer});
      pump();
    }
    function say(id,text,cls){var s=document.getElementById("s_"+id);if(s){s.textContent=text;s.className="state"+(cls?" "+cls:"")}}
    function pump(){
      if(busy||!queue.length)return;
      busy=true;
      var job=queue.shift(), card=document.getElementById("t_"+job.id);
      if(card)card.classList.add("busy");
      fetch(POST,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({q:Q,ticketId:job.id,answer:job.answer})})
        .then(function(r){return r.json().catch(function(){return {}})})
        .then(function(j){
          if(card)card.classList.remove("busy");
          if(j&&j.ok){say(job.id,j.preview?"Sample — not saved":"Saved",j.preview?"":"ok");if(!done[job.id]){done[job.id]=1;count()}}
          else say(job.id,(j&&j.error)||"Didn't save — tap again","err");
        })
        .catch(function(){if(card)card.classList.remove("busy");say(job.id,"No connection — tap again","err")})
        .then(function(){busy=false;pump()});
    }
    function count(){var n=document.getElementById("n");if(n)n.textContent=String(Object.keys(done).length)}
  <\/script>`;

  return shell(banner + head + (body || `<div class="done">Nothing to answer. Enjoy the quiet.</div>`) + bar + js,
    `FixMi — ${preview ? "sample, " : ""}${total} to answer`);
}

function errPage(title, line) {
  return shell(`<div class="hd"><h1>${esc(title)}</h1><p>${esc(line)}</p></div>`, title);
}

/* ---- recording one answer ------------------------------------------------ */
const ANSWER_TEXT = {
  unresolved: () => `This issue is still unresolved. (${TAG})`,
  resolved: () => `This issue has been resolved and the ticket can be closed. (${TAG})`,
};
/* A District Manager's "sorted" moves the ticket on; a General Manager's is a
   report from the floor, not a decision about where the ticket sits. Same rule
   as the one-click buttons had. */
const MAY_MOVE = { dm: true };

async function recordAnswer({ master, masterUrl, writePass, ticketId, answer, email, role, week, name }) {
  const ticket = (master[DEFAULTS.ticketsNode] || {})[ticketId];
  if (!ticket) return { ok: false, error: "That ticket is gone" };

  const key = `${lc(email)}|${week}`;
  const comments = arr(ticket.comments).slice();
  /* Answering again this week replaces the earlier answer rather than stacking
     a second comment on the thread — they changed their mind, they did not say
     two things. */
  const prev = comments.findIndex(c => c && c.mondayKey === key);
  const entry = {
    id: uid(), by: name || email, role: role === "dm" ? "coach" : "manager", email: lc(email),
    text: ANSWER_TEXT[answer](), ts: Date.now(), answer, monday: true, mondayKey: key,
  };
  if (prev >= 0) comments[prev] = entry; else comments.push(entry);

  const updated = { ...ticket, comments, updatedAt: Date.now() };
  const moved = !!MAY_MOVE[role] && answer === "resolved"
    && ticket.status !== "finished" && ticket.status !== "closed";
  if (moved) {
    updated.status = "finished";
    updated.activity = [...arr(ticket.activity), {
      ts: Date.now(), by: name || email, role: role === "dm" ? "coach" : "manager",
      action: "status", toStatus: "finished", note: `Marked resolved ${TAG}`,
    }];
  }

  const w = await fetch(masterUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: writePass, updates: { [`${DEFAULTS.ticketsNode}/${ticketId}`]: updated } }),
  });
  if (!w.ok) return { ok: false, error: "Couldn't save — tap again" };
  /* Keep the warm copy in step so the next flip in this burst does not need a
     download and cannot overwrite what this one just wrote. */
  if (_cache.master && _cache.master[DEFAULTS.ticketsNode]) _cache.master[DEFAULTS.ticketsNode][ticketId] = updated;
  return { ok: true, moved };
}

/* ---- handler ------------------------------------------------------------- */
module.exports = async (req, res) => {
  const html = (code, body) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.statusCode = code; res.end(body); };
  const json = (code, body) => { res.setHeader("Content-Type", "application/json"); res.statusCode = code; res.end(JSON.stringify(body)); };
  try {
    const secret = process.env.FIXMI_SHARED_SECRET || "";
    const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
    const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
    const selfUrl = (process.env.FIXMI_SELF_URL || `https://${req.headers.host || ""}`).replace(/\/$/, "");
    if (!secret) return html(500, errPage("Not set up yet", "FIXMI_SHARED_SECRET is missing on the server."));

    const post = req.method === "POST";
    const body = post ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {})) : {};
    const q = post ? (body.q || {}) : (req.query || {});
    const email = lc(q.e), role = lc(q.r), week = String(q.w || "").trim();
    /* A sample link, sent by the "Email it to me" button. It is signed over
       the flag as well, so nobody can add p=1 to a real link (or strip it off
       a sample one) to change what the page does. */
    const preview = String(q.p || "") === "1";

    if (!email || !["gm", "dm"].includes(role) || !sigOk(q.s, sign(email, role, week, preview)))
      return post ? json(403, { ok: false, error: "This link isn't valid" })
                  : html(403, errPage("That link isn't valid", "It may have been altered or retyped. Open FixMi and comment on the ticket instead."));

    if (post) {
      if (!writePass) return json(500, { ok: false, error: "Server can't save right now" });
      const answer = lc(body.answer);
      if (!["resolved", "unresolved"].includes(answer)) return json(400, { ok: false, error: "Unknown answer" });
      /* Before any read and any write. A sample has to be able to go nowhere
         near somebody's live tickets — the switch moves, the page says so,
         and the master is never touched. */
      if (preview) return json(200, { ok: true, preview: true });
      /* Within a couple of seconds of the last read, reuse it: that is one
         person still tapping, and their own writes are already folded into it.
         Any longer and read fresh, so two people answering the same ticket
         cannot erase one another. */
      const master = await readMaster(masterUrl, (Date.now() - _cache.at) > CACHE_MS);
      const name = nameFor(master, email, role);
      const out = await recordAnswer({ master, masterUrl, writePass, ticketId: String(body.ticketId || ""), answer, email, role, week, name });
      if (out.ok) console.log("[fixmi-monday]", body.ticketId, answer, "from", email, `(${role})`, out.moved ? "→ finished" : "");
      return json(out.ok ? 200 : 400, out);
    }

    /* A page load is rare — one per person per visit — so it always reads
       fresh. Anything raised since the email went out has to be on it. */
    const master = await readMaster(masterUrl, true);
    return html(200, buildPage({
      master, email, role, week, selfUrl, preview,
      q: { e: email, r: role, w: week, ...(preview ? { p: "1" } : {}), s: q.s },
    }));
  } catch (e) {
    console.error("[fixmi-monday] crashed", e);
    return req.method === "POST"
      ? json(500, { ok: false, error: "Something went wrong" })
      : html(500, errPage("Something went wrong", "Please open FixMi and comment on the ticket instead."));
  }
};

function nameFor(master, email, role) {
  const me = lc(email);
  if (role === "dm") {
    const c = Object.values(master.areaCoaches || {}).find(x => x && lc(x.email) === me);
    return c ? (c.name || email) : email;
  }
  const s = Object.values(master.restaurants || {}).find(x => x && lc(x.email) === me);
  return s ? (s.storeManager || storeLabel(s)) : email;
}

module.exports.mondayUrl = mondayUrl;
module.exports.sign = sign;
module.exports.TAG = TAG;
