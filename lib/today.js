/**
 * Today's numbers for the console's "Heute" card: today so far next to the
 * same weekday last week, the north star (rolling activation and address
 * book density against the goals) and what is waiting for a person. The
 * morning push (lib/adminPush.js) takes yesterday instead, finished and
 * whole, plus the tickets nobody answered for a day. Days in Europe/Berlin.
 */
const metrics = require("./metrics");
const AdDraft = require("../models/AdDraft");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const LandingVisit = require("../models/LandingVisit");
const WaitlistEntry = require("../models/WaitlistEntry");
const { localParts, shiftDateKey } = require("./localTime");
const { opsConfig, goalsConfig } = require("./appConfig");

const ZONE = "Europe/Berlin";
const DAY = 24 * 3600 * 1000;
// Below this many measured sign-ups the activation number is shown, not judged
const MIN_SAMPLE = 100;

/** Midnight in Berlin of the day that contains `now`. */
function startOfDay(now) {
  const d = new Date(now.getTime() - localParts(now, ZONE).minutes * 60000);
  d.setUTCSeconds(0, 0);
  return d;
}

const visitsOn = async (day) => (await LandingVisit.aggregate([{ $match: { day } }, { $group: { _id: null, n: { $sum: "$visits" } } }]))[0]?.n || 0;
const waitlistBetween = (from, to) => WaitlistEntry.countDocuments({ status: "confirmed", confirmedAt: { $gte: from, $lt: to } });

function pick(d = {}) {
  return {
    newUsers: d.users?.new || 0,
    active: d.users?.dau || 0,
    talks: d.talks?.count || 0,
    talkMinutes: Math.round((d.talks?.minutes || 0) + (d.circles?.roomMinutes || 0)),
    calls: d.calls?.answered || 0,
  };
}

/**
 * The north star from a day's snapshot (lib/metrics.js activation4w and
 * density), judged against the goals: `ok` is null while there is nothing to
 * judge (no number yet, or fewer than MIN_SAMPLE measured).
 */
function northStar(snapshot, goals) {
  const u = snapshot?.users || {};
  const pct4w = u.activation4w ?? null;
  const sample = u.activationSample || 0;
  const enough = sample >= MIN_SAMPLE;
  return {
    activation: { pct4w, sample, enough, goalPct: goals.activationPct, ok: pct4w == null || !enough ? null : pct4w >= goals.activationPct },
    density: { c3plus: u.density?.c3plus ?? null, c0: u.density?.c0 ?? null, sample: u.density?.sample || 0, goalPct: goals.densityPct },
  };
}

async function todayNumbers(now = new Date()) {
  const day = localParts(now, ZONE).dateKey;
  const lastWeek = shiftDateKey(day, -7);
  const start = startOfDay(now);
  const [series, visitsToday, visitsThen, waitlistToday, waitlistThen, approvals, support, reports, ops, goals] = await Promise.all([
    metrics.series(8, now),
    visitsOn(day),
    visitsOn(lastWeek),
    waitlistBetween(start, new Date(now.getTime() + 1)),
    waitlistBetween(new Date(start.getTime() - 7 * DAY), new Date(start.getTime() - 6 * DAY)),
    AdDraft.countDocuments({ status: "pending" }),
    SupportTicket.countDocuments({ status: "open" }),
    Report.countDocuments({ status: "open" }),
    opsConfig(),
    goalsConfig(),
  ]);
  const today = series.find((d) => d.day === day);
  const t = pick(today);
  const w = pick(series.find((d) => d.day === lastWeek));
  return {
    day,
    lastWeek,
    today: { ...t, visits: visitsToday, waitlist: waitlistToday },
    // Sign-up SMS against the day's cap (routes/verify.js)
    sms: { started: today?.ops?.smsStarted || 0, cap: ops.smsPerDay, paused: ops.smsPaused },
    // The whole day a week ago: today is still running
    lastWeekDay: { ...w, visits: visitsThen, waitlist: waitlistThen },
    todo: { approvals, support, reports },
    ...northStar(today, goals),
  };
}

/**
 * Yesterday, whole, for the morning push: its numbers, the north star as of
 * this morning, and what waits (videos for approval, tickets whose last
 * message is from the user and older than a day).
 */
async function yesterdayNumbers(now = new Date()) {
  const today = localParts(now, ZONE).dateKey;
  const day = shiftDateKey(today, -1);
  const [from, to] = metrics.dayRange(day);
  const [series, visits, waitlist, approvals, overdueTickets, ops, goals] = await Promise.all([
    metrics.series(2, now),
    visitsOn(day),
    waitlistBetween(from, to),
    AdDraft.countDocuments({ status: "pending" }),
    SupportTicket.countDocuments({ status: "open", updatedAt: { $lt: new Date(now.getTime() - DAY) } }),
    opsConfig(),
    goalsConfig(),
  ]);
  // Finished days are final; count yesterday now if the snapshot job hasn't yet
  let y = series.find((d) => d.day === day);
  if (!y || y.partial) y = await metrics.saveDay(day, now);
  return {
    day,
    yesterday: { ...pick(y), visits, waitlist },
    sms: { started: y.ops?.smsStarted || 0, cap: ops.smsPerDay, paused: ops.smsPaused },
    todo: { approvals, overdueTickets },
    ...northStar(series.find((d) => d.day === today), goals),
  };
}

module.exports = { todayNumbers, yesterdayNumbers, northStar, startOfDay, MIN_SAMPLE };
