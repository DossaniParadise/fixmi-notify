/**
 * The weekly clock.
 *
 * Vercel runs this once a day. It does nothing at all unless the weekly
 * summaries are switched on in Settings → Email AND today is the chosen day in
 * Central time — which means the day can be changed from Settings without
 * touching vercel.json or redeploying anything.
 *
 * It also records the date it last ran, so a retry, a second cron region or a
 * manual poke can't send everybody two copies.
 */

const DEFAULTS = { masterUrl: "https://alignment-api-khaki.vercel.app/api/dpm-alignment" };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function centralNow() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = t => (f.find(p => p.type === t) || {}).value || "";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, day: String(get("weekday")).toLowerCase() };
}

module.exports = async (req, res) => {
  try {
    // Vercel's scheduler sends CRON_SECRET; a person poking it by hand uses ?key=.
    const secret = process.env.FIXMI_SHARED_SECRET || "";
    const cronSecret = process.env.CRON_SECRET || "";
    const auth = String(req.headers.authorization || "");
    const key = String((req.query || {}).key || "");
    const fromCron = cronSecret && auth === `Bearer ${cronSecret}`;
    if (!fromCron && (!secret || key !== secret)) return res.status(401).json({ error: "bad or missing ?key=" });

    const masterUrl = process.env.FIXMI_MASTER_URL || DEFAULTS.masterUrl;
    const writePass = process.env.FIXMI_WRITE_PASSWORD || "";
    const force = String((req.query || {}).force || "") === "1";

    const r = await fetch(masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: `could not read the master (HTTP ${r.status})` });
    const master = await r.json();

    const prefs = ((master.admins || {}).notifyPrefs || {});
    const wk = prefs.weekly || {};
    const now = centralNow();
    const notify = require("./notify.js");
    const callNotify = async (body) => {
      let out = null;
      await notify({ method: "POST", query: {}, headers: { host: req.headers.host }, body: { secret, ...body } },
        { status() { return this; }, setHeader() {}, json(o) { out = o; return this; }, end() { return this; } });
      return out;
    };

    /* ---- reminders --------------------------------------------------------
       These run EVERY day, not on the weekly day: a rule that says "seven days
       after it opens" means seven days, not "the following Monday". Each one
       is stamped onto its ticket so it doesn't go again tomorrow. */
    let reminders = null;
    try {
      // The sender stamps the tickets itself, so a reminder sent by hand from
      // Settings and one sent here behave identically.
      reminders = await callNotify({ event: "reminders", _master: master });
      if (reminders) {
        console.log("[fixmi-weekly] reminders", JSON.stringify({ due: (reminders.due || []).length, sent: reminders.sent, stamped: reminders.stamped }));
        if (reminders.stampError) console.error("[fixmi-weekly] reminders sent but not stamped:", reminders.stampError);
      }
    } catch (e) { console.error("[fixmi-weekly] reminder pass failed", e && e.message); }

    const withReminders = (o) => ({ ...o, reminders: reminders ? { due: (reminders.due || []).length, sent: reminders.sent || 0, stamped: reminders.stamped || 0 } : null });
    if (!force) {
      if (!wk.on) return res.status(200).json(withReminders({ skipped: true, reason: "weekly summaries are switched off in Settings → Email" }));
      const want = DAYS.includes(String(wk.day || "").toLowerCase()) ? String(wk.day).toLowerCase() : "monday";
      if (now.day !== want) return res.status(200).json(withReminders({ skipped: true, reason: `today is ${now.day}, summaries go out on ${want}` }));
      if (wk.lastSentYmd === now.ymd) return res.status(200).json(withReminders({ skipped: true, reason: `already sent today (${now.ymd})` }));
    }

    const kinds = Array.isArray(wk.kinds) && wk.kinds.length ? wk.kinds : ["gm", "dm", "do", "vp"];
    const out = await callNotify({ event: "summary", mode: "run", kinds, _master: master });

    // Remember the day, so nothing goes out twice.
    if (writePass && !force) {
      try {
        await fetch(masterUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: writePass, updates: { "admins/notifyPrefs/weekly": { ...wk, lastSentYmd: now.ymd, lastSentAt: Date.now() } } }),
        });
      } catch (e) { console.error("[fixmi-weekly] could not record the send date", e && e.message); }
    }

    console.log("[fixmi-weekly]", now.ymd, JSON.stringify(out));
    return res.status(200).json(withReminders({ ran: true, on: now.ymd, kinds, ...(out || {}) }));
  } catch (e) {
    console.error("[fixmi-weekly] crashed", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
