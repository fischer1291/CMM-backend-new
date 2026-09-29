/**
 * Today's numbers for the console's "Heute" card and the daily push
 * (lib/adminPush.js): today so far next to the same weekday last week,
 * plus what is waiting for a person. Days in Europe/Berlin.
 */
const metrics = require("./metrics");
const AdDraft = require("../models/AdDraft");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const LandingVisit = require("../models/LandingVisit");
const WaitlistEntry = require("../models/WaitlistEntry");
const { localParts, shiftDateKey } = require("./localTime");

const ZONE = "Europe/Berlin";
const DAY = 24 * 3600 * 1000;

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

async function todayNumbers(now = new Date()) {
  const day = localParts(now, ZONE).dateKey;
  const lastWeek = shiftDateKey(day, -7);
  const start = startOfDay(now);
  const [series, visitsToday, visitsThen, waitlistToday, waitlistThen, approvals, support, reports] = await Promise.all([
    metrics.series(8, now),
    visitsOn(day),
    visitsOn(lastWeek),
    waitlistBetween(start, new Date(now.getTime() + 1)),
    waitlistBetween(new Date(start.getTime() - 7 * DAY), new Date(start.getTime() - 6 * DAY)),
    AdDraft.countDocuments({ status: "pending" }),
    SupportTicket.countDocuments({ status: "open" }),
    Report.countDocuments({ status: "open" }),
  ]);
  const t = pick(series.find((d) => d.day === day));
  const w = pick(series.find((d) => d.day === lastWeek));
  return {
    day,
    lastWeek,
    today: { ...t, visits: visitsToday, waitlist: waitlistToday },
    // The whole day a week ago: today is still running
    lastWeekDay: { ...w, visits: visitsThen, waitlist: waitlistThen },
    todo: { approvals, support, reports },
  };
}

module.exports = { todayNumbers, startOfDay };
