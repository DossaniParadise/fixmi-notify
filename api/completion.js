/**
 * The Sunday-night clock for the technician completion report.
 *
 * Vercel runs this once a week, at 02:00 UTC on Monday — which is Sunday
 * evening in Texas: 8pm while the clocks are back (winter), 9pm once they go
 * forward (summer). Hobby plans fire a cron "some time within the hour", so
 * expect it between the hour and the hour after.
 *
 * It is its own file rather than a branch inside weekly.js on purpose: that
 * one runs the reminders and the Monday summaries every morning, and nothing
 * here should be able to disturb it.
 *
 * It does nothing unless the report is switched on in Settings → Email. WHO
 * gets each technician's report is read from the saved settings by notify.js
 * at send time — this file never handles an address.
 *
 * It records the date it last ran in its own small node (not inside the
 * settings record, so saving Settings and this write can never overwrite one
 * another), and refuses to send twice on the same day.
 */

const DEFAULTS = { masterUrl: "https://alignment-api-khaki.vercel.app/api/dpm-alignment" };
const STATE_NODE = "admins/completionReportState";

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

    const notify = require("./notify.js");
    const r = notify.readMaster ? await notify.readMaster(masterUrl)
      : await fetch(masterUrl, { headers: { accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: `could not read the master (HTTP ${r.status})` });
    const master = await r.json();

    const comp = (((master.admins || {}).notifyPrefs || {}).completion) || {};
    const state = (master.admins || {}).completionReportState || {};
    const now = centralNow();

    if (!force) {
      if (!comp.on) return res.status(200).json({ skipped: true, reason: "the technician completion report is switched off in Settings → Email" });
      if (now.day !== "sunday") return res.status(200).json({ skipped: true, reason: `today is ${now.day} in Central time; this report goes out on Sunday night` });
      if (state.lastSentYmd === now.ymd) return res.status(200).json({ skipped: true, reason: `already sent today (${now.ymd})` });
    }

    let out = null;
    await notify({ method: "POST", query: {}, headers: { host: req.headers.host },
        body: { secret, event: "completion", mode: "run", _master: master } },
      { status() { return this; }, setHeader() {}, json(o) { out = o; return this; }, end() { return this; } });

    // Remember the day only when something really went out, so a failed run
    // can be retried by hand the same evening.
    if (writePass && !force && out && out.sent) {
      try {
        await fetch(masterUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: writePass, updates: {
            [STATE_NODE]: { lastSentYmd: now.ymd, lastSentAt: Date.now(), sent: out.sent, reports: out.reports || 0 } } }),
        });
      } catch (e) { console.error("[fixmi-completion] could not record the send date", e && e.message); }
    }

    console.log("[fixmi-completion]", now.ymd, JSON.stringify({ sent: out && out.sent, reports: out && out.reports, reason: out && out.reason }));
    return res.status(200).json({ ran: true, on: now.ymd, ...(out || {}) });
  } catch (e) {
    console.error("[fixmi-completion] crashed", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
