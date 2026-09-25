/**
 * Key numbers for the admin console. Everything is counted on the server from
 * data the app already has: no tracking SDK in the app. A snapshot per day
 * (Europe/Berlin) goes to MetricsDaily, because raw data expires (calls after
 * 30 days, push decisions after 3).
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const DailyMoment = require("../models/DailyMoment");
const CallMoment = require("../models/CallMoment");
const Nudge = require("../models/Nudge");
const Invite = require("../models/Invite");
const PushDecision = require("../models/PushDecision");
const Report = require("../models/Report");
const ActiveDay = require("../models/ActiveDay");
const MetricsDaily = require("../models/MetricsDaily");
const { localParts, shiftDateKey, weekKey } = require("./localTime");

const ZONE = "Europe/Berlin";
const BACKFILL_DAYS = 60;

const todayKey = (now = new Date()) => localParts(now, ZONE).dateKey;

/** UTC instant of local midnight at the start of `dateKey`. */
function dayStart(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  // Twice: the offset may change across a DST switch
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), ZONE);
    const [ly, lm, ld] = p.dateKey.split("-").map(Number);
    t -= Date.UTC(ly, lm - 1, ld) + p.minutes * 60_000 - target;
  }
  return new Date(t);
}

const dayRange = (dateKey) => [dayStart(dateKey), dayStart(shiftDateKey(dateKey, 1))];
// Users have no createdAt; their ObjectId carries the creation time
const idAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

// --- Activity ------------------------------------------------------------------

// Who was already recorded today (per process), so a request costs no write
let seenDay = null;
let seen = new Set();

/** Remember that `phone` used the app today. Fire and forget. */
function markActive(phone, now = new Date()) {
  if (!phone) return;
  const day = todayKey(now);
  if (day !== seenDay) {
    seenDay = day;
    seen = new Set();
  }
  if (seen.has(phone)) return;
  seen.add(phone);
  ActiveDay.updateOne({ day, who: User.hashPhone(phone) }, { $setOnInsert: { day, at: now } }, { upsert: true }).catch(
    (err) => {
      seen.delete(phone);
      if (err.code !== 11000) console.error("❌ markActive:", err.message);
    },
  );
}

const resetActivityCache = () => {
  seenDay = null;
  seen = new Set();
};

async function activeBetween(firstDay, lastDay) {
  return (await ActiveDay.distinct("who", { day: { $gte: firstDay, $lte: lastDay } })).length;
}

// --- One day ---------------------------------------------------------------------

async function computeDay(dateKey, now = new Date()) {
  const [from, to] = dayRange(dateKey);
  const range = { $gte: from, $lt: to };
  const ids = { $gte: idAt(from), $lt: idAt(to) };

  const [
    usersTotal,
    usersNew,
    joinedViaInvite,
    dau,
    wau,
    mau,
    callGroups,
    callsAnswered,
    callsAudio,
    talkAgg,
    talkPeople,
    roomTalkAgg,
    circlesTotal,
    circlesNew,
    rooms,
    ritualRooms,
    dailyAgg,
    moments,
    nudges,
    invites,
    pushGroups,
    pushFailed,
    reportsNew,
    reportsOpen,
  ] = await Promise.all([
    User.countDocuments({ _id: { $lt: idAt(to) } }),
    User.countDocuments({ _id: ids }),
    User.countDocuments({ _id: ids, joinedViaInvite: true }),
    ActiveDay.countDocuments({ day: dateKey }),
    activeBetween(shiftDateKey(dateKey, -6), dateKey),
    activeBetween(shiftDateKey(dateKey, -27), dateKey),
    Call.aggregate([{ $match: { createdAt: range } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Call.countDocuments({ createdAt: range, acceptedAt: { $ne: null } }),
    Call.countDocuments({ createdAt: range, video: false }),
    Talk.aggregate([
      { $match: { startedAt: range, group: { $ne: true } } },
      { $group: { _id: null, count: { $sum: 1 }, seconds: { $sum: "$seconds" } } },
    ]),
    Talk.distinct("participants", { startedAt: range, group: { $ne: true } }),
    Talk.aggregate([{ $match: { startedAt: range, group: true } }, { $group: { _id: null, seconds: { $sum: "$seconds" } } }]),
    Circle.countDocuments({ createdAt: { $lt: to } }),
    Circle.countDocuments({ createdAt: range }),
    Room.countDocuments({ createdAt: range }),
    Room.countDocuments({ createdAt: range, startedBy: "ritual" }),
    DailyMoment.aggregate([{ $match: { day: dateKey } }, { $group: { _id: null, n: { $sum: { $size: "$joined" } } } }]),
    CallMoment.countDocuments({ timestamp: range }),
    Nudge.countDocuments({ createdAt: range }),
    Invite.countDocuments({ createdAt: range }),
    PushDecision.aggregate([{ $match: { at: range } }, { $group: { _id: { $eq: ["$result", "sent"] }, n: { $sum: 1 } } }]),
    PushDecision.countDocuments({ at: range, delivery: { $exists: true, $nin: [null, "delivered"] } }),
    Report.countDocuments({ createdAt: range }),
    Report.countDocuments({ status: "open" }),
  ]);

  const byStatus = Object.fromEntries(callGroups.map((g) => [g._id, g.n]));
  const pushBy = Object.fromEntries(pushGroups.map((g) => [String(g._id), g.n]));
  return {
    day: dateKey,
    partial: to > now,
    users: { total: usersTotal, new: usersNew, dau, wau, mau },
    calls: {
      started: callGroups.reduce((sum, g) => sum + g.n, 0),
      answered: callsAnswered,
      missed: byStatus.missed || 0,
      declined: byStatus.declined || 0,
      busy: byStatus.busy || 0,
      cancelled: byStatus.cancelled || 0,
      audio: callsAudio,
    },
    talks: {
      count: talkAgg[0]?.count || 0,
      minutes: Math.round((talkAgg[0]?.seconds || 0) / 60),
      people: talkPeople.length,
    },
    circles: {
      total: circlesTotal,
      new: circlesNew,
      rooms,
      ritualRooms,
      roomMinutes: Math.round((roomTalkAgg[0]?.seconds || 0) / 60),
    },
    rituals: { dailyJoined: dailyAgg[0]?.n || 0, moments, nudges },
    growth: { invites, joinedViaInvite },
    push: { sent: pushBy.true || 0, skipped: pushBy.false || 0, failed: pushFailed },
    reports: { new: reportsNew, open: reportsOpen },
    computedAt: now,
  };
}

async function saveDay(dateKey, now = new Date()) {
  const doc = await computeDay(dateKey, now);
  await MetricsDaily.updateOne({ day: dateKey }, { $set: doc }, { upsert: true });
  return doc;
}

/**
 * Keep snapshots current: today (partial) every run, finished days once.
 * The first run fills the last BACKFILL_DAYS days, as far as data allows.
 */
async function runSnapshots(now = new Date()) {
  const today = todayKey(now);
  const first = shiftDateKey(today, -BACKFILL_DAYS);
  const existing = await MetricsDaily.find({ day: { $gte: first } }, { day: 1, partial: 1 }).lean();
  const final = new Set(existing.filter((d) => !d.partial).map((d) => d.day));
  let written = 0;
  for (let day = first; day < today; day = shiftDateKey(day, 1)) {
    if (!final.has(day)) {
      await saveDay(day, now);
      written++;
    }
  }
  await saveDay(today, now);
  return written + 1;
}

/** Snapshots for the last `days` days, oldest first; today freshly counted. */
async function series(days, now = new Date()) {
  const today = todayKey(now);
  const first = shiftDateKey(today, -(days - 1));
  await saveDay(today, now);
  return MetricsDaily.find({ day: { $gte: first, $lte: today } }, { _id: 0, __v: 0 }).sort({ day: 1 }).lean();
}

// --- Retention -------------------------------------------------------------------

/**
 * Weekly cohorts (by sign-up week): share of each cohort that was active in
 * each following week. Active = used the app or had a talk that week.
 */
async function retention(weeks = 8, now = new Date()) {
  const thisWeek = weekKey(now, ZONE);
  const keys = [];
  for (let i = weeks - 1; i >= 0; i--) keys.push(shiftDateKey(thisWeek, -7 * i));

  const activeByWeek = new Map();
  for (const key of keys) {
    const [from] = dayRange(key);
    const [, to] = dayRange(shiftDateKey(key, 6));
    const [hashes, talkers] = await Promise.all([
      ActiveDay.distinct("who", { day: { $gte: key, $lte: shiftDateKey(key, 6) } }),
      Talk.distinct("participants", { startedAt: { $gte: from, $lt: to } }),
    ]);
    activeByWeek.set(key, new Set([...hashes, ...talkers.map((p) => User.hashPhone(p))]));
  }

  const cohorts = [];
  for (const [index, key] of keys.entries()) {
    const [from] = dayRange(key);
    const [, to] = dayRange(shiftDateKey(key, 6));
    const users = await User.find({ _id: { $gte: idAt(from), $lt: idAt(to) } }, { phone: 1 }).lean();
    const hashes = users.map((u) => User.hashPhone(u.phone));
    const share = keys.slice(index + 1).map((later) => {
      if (!hashes.length) return null;
      const active = activeByWeek.get(later);
      return Math.round((hashes.filter((h) => active.has(h)).length / hashes.length) * 100) / 100;
    });
    cohorts.push({ week: key, size: users.length, weeks: share });
  }
  return cohorts;
}

module.exports = {
  ZONE,
  todayKey,
  dayStart,
  dayRange,
  markActive,
  resetActivityCache,
  computeDay,
  saveDay,
  runSnapshots,
  series,
  retention,
};
