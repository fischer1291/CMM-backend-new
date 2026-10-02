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
const InviteVisit = require("../models/InviteVisit");
const WaitlistEntry = require("../models/WaitlistEntry");
const PushDecision = require("../models/PushDecision");
const Report = require("../models/Report");
const ActiveDay = require("../models/ActiveDay");
const MetricsDaily = require("../models/MetricsDaily");
const opsCounters = require("./opsCounters");
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

/**
 * Remember that `phone` used the app today, under its keyed hash
 * (User.hmacPhone, plan 2.8). Fire and forget.
 */
function markActive(phone, now = new Date()) {
  if (!phone) return;
  const day = todayKey(now);
  if (day !== seenDay) {
    seenDay = day;
    seen = new Set();
  }
  if (seen.has(phone)) return;
  seen.add(phone);
  ActiveDay.updateOne({ day, who: User.hmacPhone(phone) }, { $setOnInsert: { day, at: now } }, { upsert: true }).catch(
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
    inviteVisitGroups,
    waitlistGroups,
    localeGroups,
    pushGroups,
    pushFailed,
    reportsNew,
    reportsOpen,
    ops,
    act,
    dens,
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
    InviteVisit.aggregate([{ $match: { day: dateKey } }, { $group: { _id: "$platform", n: { $sum: "$visits" } } }]),
    WaitlistEntry.aggregate([{ $match: { status: "confirmed", confirmedAt: range } }, { $group: { _id: "$platform", n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { _id: ids, locale: { $nin: [null, ""] } } }, { $group: { _id: "$locale", n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 5 }]),
    PushDecision.aggregate([{ $match: { at: range } }, { $group: { _id: { $eq: ["$result", "sent"] }, n: { $sum: 1 } } }]),
    PushDecision.countDocuments({ at: range, delivery: { $exists: true, $nin: [null, "delivered"] } }),
    Report.countDocuments({ createdAt: range }),
    Report.countDocuments({ status: "open" }),
    opsCounters.countsOf(dateKey),
    // Rolling numbers as of the end of that day (or now, while it runs)
    activation4w(to > now ? now : to),
    density(to > now ? now : to),
  ]);

  const byStatus = Object.fromEntries(callGroups.map((g) => [g._id, g.n]));
  const pushBy = Object.fromEntries(pushGroups.map((g) => [String(g._id), g.n]));
  const visitsBy = Object.fromEntries(inviteVisitGroups.map((g) => [g._id, g.n]));
  const waitlistBy = Object.fromEntries(waitlistGroups.map((g) => [g._id || "unknown", g.n]));
  return {
    day: dateKey,
    partial: to > now,
    users: {
      total: usersTotal,
      new: usersNew,
      dau,
      wau,
      mau,
      activation4w: act.pct,
      activationSample: act.measured,
      density: { c3plus: dens.c3plus, c0: dens.c0, sample: dens.sample },
      byLocale: localeGroups.map((g) => ({ locale: g._id, users: g.n })),
    },
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
    growth: {
      invites,
      joinedViaInvite,
      inviteVisits: { total: (visitsBy.ios || 0) + (visitsBy.android || 0) + (visitsBy.other || 0), ios: visitsBy.ios || 0, android: visitsBy.android || 0, other: visitsBy.other || 0 },
    },
    waitlist: { byPlatform: { ios: waitlistBy.ios || 0, android: waitlistBy.android || 0, unknown: waitlistBy.unknown || 0 } },
    push: { sent: pushBy.true || 0, skipped: pushBy.false || 0, failed: pushFailed },
    reports: { new: reportsNew, open: reportsOpen },
    ops: { callsRejectedNotConnected: 0, matchSuspicious: 0, smsStarted: 0, smsChecked: 0, smsFailed: 0, ...ops },
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

const ACTIVATION_DAYS = 7;

/**
 * Activation of one cohort: who had a real conversation within
 * ACTIVATION_DAYS of signing up (the launch metric), who invited someone,
 * who came in through an invite, and how many people the cohort brought in
 * so far per member (k). `activated` only counts people whose window is over.
 */
async function activation(users, now = new Date()) {
  if (!users.length) return { activated: null, measured: 0, inviters: null, viaInvite: null, k: null };
  const window = ACTIVATION_DAYS * 24 * 3600 * 1000;
  const signup = new Map(users.map((u) => [u.phone, u._id.getTimestamp().getTime()]));
  const phones = [...signup.keys()];
  const first = Math.min(...signup.values());
  const talks = await Talk.find(
    {
      startedAt: { $gte: new Date(first), $lt: new Date(Math.max(...signup.values()) + window) },
      $or: [{ group: { $ne: true }, participants: { $in: phones } }, { group: true, owner: { $in: phones } }],
    },
    { participants: 1, owner: 1, group: 1, startedAt: 1 },
  ).lean();
  const talked = new Set();
  for (const t of talks) {
    for (const phone of t.group ? [t.owner] : t.participants) {
      const at = signup.get(phone);
      if (at != null && t.startedAt.getTime() - at < window) talked.add(phone);
    }
  }
  const measured = users.filter((u) => now.getTime() - signup.get(u.phone) >= window);
  const share = (n, of) => (of ? Math.round((n / of) * 100) / 100 : null);
  return {
    activated: share(measured.filter((u) => talked.has(u.phone)).length, measured.length),
    measured: measured.length,
    inviters: share(users.filter((u) => u.firstInviteAt).length, users.length),
    viaInvite: share(users.filter((u) => u.joinedViaInvite).length, users.length),
    k: share(users.reduce((sum, u) => sum + (u.invitesJoined || 0), 0), users.length),
  };
}

/**
 * The north star as one number: activation of everyone who signed up in the
 * last four full weeks (Monday to Sunday, Europe/Berlin) taken together, in
 * percent, plus how many of them could be measured (their 7-day window is
 * over). Four cohorts together make a usable sample sooner than one week
 * alone; the console treats a sample under 100 as "zu wenig Daten".
 */
async function activation4w(now = new Date()) {
  const thisWeek = weekKey(now, ZONE);
  const from = shiftDateKey(thisWeek, -28);
  const users = await User.find(
    { _id: { $gte: idAt(dayStart(from)), $lt: idAt(dayStart(thisWeek)) } },
    { phone: 1, firstInviteAt: 1, joinedViaInvite: 1, invitesJoined: 1 },
  ).lean();
  const a = await activation(users, now);
  return {
    pct: a.activated == null ? null : Math.round(a.activated * 100),
    measured: a.measured,
    size: users.length,
    from,
    to: shiftDateKey(thisWeek, -1),
  };
}

// Address book density is judged once people had a week to sync and invite
const DENSITY_MIN_DAYS = 7;
const DENSITY_MAX_DAYS = 35;

/**
 * How many registered contacts new people have: of everyone who signed up
 * between 7 and 35 days ago, the share (percent) with at least three entries
 * in `contacts` and the share with none. A thin address book is the usual
 * reason somebody never has a first talk.
 */
async function density(now = new Date()) {
  const ago = (days) => new Date(now.getTime() - days * 24 * 3600 * 1000);
  const ids = { $gte: idAt(ago(DENSITY_MAX_DAYS)), $lt: idAt(ago(DENSITY_MIN_DAYS)) };
  const [sample, c3plus, c0] = await Promise.all([
    User.countDocuments({ _id: ids }),
    User.countDocuments({ _id: ids, "contacts.2": { $exists: true } }),
    User.countDocuments({ _id: ids, $or: [{ contacts: { $size: 0 } }, { contacts: { $exists: false } }] }),
  ]);
  const pct = (n) => (sample ? Math.round((n / sample) * 100) : null);
  return { c3plus: pct(c3plus), c0: pct(c0), sample };
}

/**
 * Weekly cohorts (by sign-up week): share of each cohort that was active in
 * each following week (active = used the app or had a talk that week), plus
 * its activation (see above).
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
    activeByWeek.set(key, new Set([...hashes, ...talkers.map((p) => User.hmacPhone(p))]));
  }

  const cohorts = [];
  for (const [index, key] of keys.entries()) {
    const [from] = dayRange(key);
    const [, to] = dayRange(shiftDateKey(key, 6));
    const users = await User.find(
      { _id: { $gte: idAt(from), $lt: idAt(to) } },
      { phone: 1, firstInviteAt: 1, joinedViaInvite: 1, invitesJoined: 1 },
    ).lean();
    const hashes = users.map((u) => User.hmacPhone(u.phone));
    const share = keys.slice(index + 1).map((later) => {
      if (!hashes.length) return null;
      const active = activeByWeek.get(later);
      return Math.round((hashes.filter((h) => active.has(h)).length / hashes.length) * 100) / 100;
    });
    cohorts.push({ week: key, size: users.length, weeks: share, ...(await activation(users, now)) });
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
  activation,
  activation4w,
  density,
  ACTIVATION_DAYS,
};
