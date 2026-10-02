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
const SubscriptionEvent = require("../models/SubscriptionEvent");
const opsCounters = require("./opsCounters");
const { funnelOf, limitHitsOf } = require("./paywall");
const { pricesConfig } = require("./appConfig");
const { localParts, shiftDateKey, weekKey } = require("./localTime");
const { LIFECYCLE_TYPES } = require("./notify");
const { talksOf } = require("./stats");
const { SOURCES: ACQUISITION_SOURCES } = require("./acquisition");

const ZONE = "Europe/Berlin";
const BACKFILL_DAYS = 60;
// What a snapshot's `version` means: raise it when computeDay gains a column
// or changes a definition, and runSnapshots recomputes the last
// RECOMPUTE_DAYS days (RECOMPUTE_PER_RUN per run, so the job stays short).
// Only within the raw data's life: columns whose rows have expired keep
// their stored value (RAW_TTL_DAYS, saveDay).
// 2: plus.* and the density histogram (plan 2.4)
// 3: costs.* (plan 2.5)
// 4: lifecycle.* (plan 2.3)
// 5: plus.giftDaysGranted and plus.giftToStore (plan 2.12)
// 6: plus.funnel and plus.limitHits (plan 2.6a)
// 7: growth.bySource, growth.byCampaign, growth.androidFriendsAvg (plan 2.10)
const METRICS_VERSION = 7;
const RECOMPUTE_DAYS = 30;
const RECOMPUTE_PER_RUN = 5;
// Snapshot columns whose raw rows expire (the TTL indexes in models/), in
// days. When a stored day is counted again and is at least TTL - 1 days
// old, these columns keep what the snapshot has: the rows may be gone (the
// TTL monitor deletes from the row's own timestamp, an hour earlier than
// the local day at the autumn switch), and a zero would overwrite a real
// number for good. Everything else here lives 60 days or longer.
const RAW_TTL_DAYS = {
  push: 3, // PushDecision
  // PushDecision too; activeNextDay judges the decisions of T-1
  lifecycle: 3,
  // talk48h judges those of T-2, gone during T+1: kept from age 1, but only
  // from a final snapshot (FINAL_ONLY), the one taken after midnight
  "lifecycle.talk48h": 2,
  "rituals.nudges": 7, // Nudge
  calls: 30, // Call
  "circles.rooms": 30, // Room
  "circles.ritualRooms": 30,
  // Talks live a year, but whether a 1:1 talk was video comes from its Call
  "costs.agoraAudioMinutes": 30,
  "costs.agoraVideoMinutes": 30,
};

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
    plus,
    agoraGroups,
    prices,
    lifecycle,
    newcomers,
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
    plusDay(from, to, now),
    agoraSeconds(range),
    pricesConfig(),
    lifecycleDay(dateKey),
    // The day's sign-ups with their acquisition answer (plan 2.10)
    User.find({ _id: ids }, { acquisition: 1 }).lean(),
  ]);

  const byStatus = Object.fromEntries(callGroups.map((g) => [g._id, g.n]));
  const pushBy = Object.fromEntries(pushGroups.map((g) => [String(g._id), g.n]));
  const visitsBy = Object.fromEntries(inviteVisitGroups.map((g) => [g._id, g.n]));
  const waitlistBy = Object.fromEntries(waitlistGroups.map((g) => [g._id || "unknown", g.n]));
  const agoraBy = Object.fromEntries(agoraGroups.map((g) => [g._id ? "video" : "audio", g.seconds]));
  const opsCounts = { callsRejectedNotConnected: 0, matchSuspicious: 0, smsStarted: 0, smsChecked: 0, smsFailed: 0, ...ops };
  // The gift budget (plan 2.12): Plus days given that day by source, from
  // the day counters giftDays_<source> (lib/referral.js countGiftDays)
  plus.giftDaysGranted = { referral: opsCounts.giftDays_referral || 0, waitlist: opsCounts.giftDays_waitlist || 0, admin: opsCounts.giftDays_admin || 0 };
  // The paywall funnel and the plan limits people ran into (plan 2.6a,
  // lib/paywall.js), from the day counters as well
  plus.funnel = funnelOf(opsCounts);
  plus.limitHits = limitHitsOf(opsCounts);
  const doc = {
    day: dateKey,
    partial: to > now,
    version: METRICS_VERSION,
    users: {
      total: usersTotal,
      new: usersNew,
      dau,
      wau,
      mau,
      activation4w: act.pct,
      activationSample: act.measured,
      density: dens,
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
      ...acquisitionDay(newcomers),
    },
    waitlist: { byPlatform: { ios: waitlistBy.ios || 0, android: waitlistBy.android || 0, unknown: waitlistBy.unknown || 0 } },
    push: { sent: pushBy.true || 0, skipped: pushBy.false || 0, failed: pushFailed },
    reports: { new: reportsNew, open: reportsOpen },
    plus,
    costs: {
      smsStarted: opsCounts.smsStarted,
      smsChecked: opsCounts.smsChecked,
      agoraAudioMinutes: Math.round((agoraBy.audio || 0) / 60),
      agoraVideoMinutes: Math.round((agoraBy.video || 0) / 60),
      cloudinaryUploads: opsCounts.cloudinaryUploads || 0,
      pushSent: 0, // priceCosts copies push.sent
      voipSent: opsCounts.voipSent || 0,
    },
    lifecycle,
    ops: opsCounts,
    computedAt: now,
  };
  return priceCosts(doc, prices);
}

/**
 * Where the day's sign-ups came from (plan 2.10, User.acquisition):
 * bySource counts them by their answer (none: no answer, yet or ever: a
 * recount of the day picks up answers given later, until the snapshot is
 * final), byCampaign the ones with a campaign by slug, androidFriendsAvg
 * the mean of their androidFriends answers (null without any).
 */
function acquisitionDay(users) {
  const bySource = Object.fromEntries([...ACQUISITION_SOURCES, "none"].map((s) => [s, 0]));
  const byCampaign = {};
  const android = [];
  for (const u of users) {
    const a = u.acquisition || {};
    bySource[a.at && ACQUISITION_SOURCES.includes(a.source) ? a.source : "none"]++;
    if (a.at && a.campaign) byCampaign[a.campaign] = { new: (byCampaign[a.campaign]?.new || 0) + 1 };
    if (a.at && Number.isInteger(a.androidFriends)) android.push(a.androidFriends);
  }
  const androidFriendsAvg = android.length ? Math.round((android.reduce((x, n) => x + n, 0) / android.length) * 100) / 100 : null;
  return { bySource, byCampaign, androidFriendsAvg };
}

/**
 * Does a lifecycle push bring people back (plan 2.3)? Until there is an
 * event log, two stand-ins per type: an ActiveDay on the next day and a
 * talk within 48 hours. PushDecision lives three days, so day T counts the
 * pushes of T (sentByType), judges those of T-1 by T's ActiveDay
 * (activeNextDay) and those of T-2 by talks up to the end of T (talk48h).
 * Every column is final when T is, but only just: the decisions of T-2 are
 * gone during T+1, so a recount on that day would undercount talk48h.
 * RAW_TTL_DAYS keeps talk48h from the final snapshot from age 1 on, the
 * whole block from age 2 on.
 */
async function lifecycleDay(dateKey) {
  const sentOn = (key) => {
    const [from, to] = dayRange(key);
    return PushDecision.find({ at: { $gte: from, $lt: to }, type: { $in: LIFECYCLE_TYPES }, result: "sent" }, { to: 1, type: 1, at: 1 }).lean();
  };
  const [today, dayBefore, twoBefore] = await Promise.all([sentOn(dateKey), sentOn(shiftDateKey(dateKey, -1)), sentOn(shiftDateKey(dateKey, -2))]);

  const sentByType = {};
  for (const p of today) sentByType[p.type] = (sentByType[p.type] || 0) + 1;

  const activeNextDay = {};
  const active = new Set(await ActiveDay.distinct("who", { day: dateKey, who: { $in: dayBefore.map((p) => User.hmacPhone(p.to)) } }));
  for (const p of dayBefore) {
    const row = (activeNextDay[p.type] ??= { sent: 0, active: 0 });
    row.sent++;
    if (active.has(User.hmacPhone(p.to))) row.active++;
  }

  const talk48h = {};
  for (const p of twoBefore) {
    const row = (talk48h[p.type] ??= { sent: 0, talked: 0 });
    row.sent++;
    if (await Talk.exists({ ...talksOf(p.to), startedAt: { $gte: p.at, $lt: new Date(p.at.getTime() + 48 * 3600 * 1000) } })) row.talked++;
  }
  return { sentByType, activeNextDay, talk48h };
}

/**
 * Agora participant seconds of the talks that started in `range`, by mode:
 * [{ _id: true (video) | false (audio), seconds }]. A 1:1 talk counts its
 * seconds twice (two participants) and is video unless its Call says
 * video: false; a talk whose Call has expired counts as video, the mode
 * calls start in. A round (group: true) has one Talk per participant, so
 * every record counts once, and rounds are video (app/room.tsx enables the
 * camera). All video is Agora's HD tier: 640×360 and 720p are priced the
 * same, so the app reports no quality.
 */
function agoraSeconds(range) {
  return Talk.aggregate([
    { $match: { startedAt: range } },
    { $lookup: { from: Call.collection.name, localField: "callId", foreignField: "callId", as: "call" } },
    {
      $project: {
        seconds: { $multiply: ["$seconds", { $cond: [{ $eq: ["$group", true] }, 1, 2] }] },
        video: { $cond: [{ $eq: ["$group", true] }, true, { $ne: [{ $arrayElemAt: ["$call.video", 0] }, false] }] },
      },
    },
    { $group: { _id: "$video", seconds: { $sum: "$seconds" } } },
  ]);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Put prices on the day's cost quantities (AppConfig.prices, every default
 * an assumption): costs.variableEurCents and perMauEurCents (null without
 * MAU), both in euro cents with two decimals. pushSent is copied from
 * push.sent here, after saveDay may have kept an expired push column.
 * Agora's free minutes are a monthly pool; each day gets its share
 * (minutes per month / days of the month) and it offsets video first:
 * Agora deducts them from the month's total, and taking the expensive
 * minutes first gives the lower bound the invoice comes to. Check the
 * result against the invoice on the 5th of the month.
 */
function priceCosts(doc, prices) {
  const c = doc.costs;
  c.pushSent = doc.push?.sent || 0;
  const [y, m] = doc.day.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let free = (prices.agoraFreeMinutesPerMonth || 0) / daysInMonth;
  const video = Math.max(0, c.agoraVideoMinutes - free);
  free = Math.max(0, free - c.agoraVideoMinutes);
  const audio = Math.max(0, c.agoraAudioMinutes - free);
  const agoraUsd = (video * prices.agoraVideoUsdCentsPer1000Min + audio * prices.agoraAudioUsdCentsPer1000Min) / 1000;
  const variable =
    c.smsStarted * prices.smsEurCents +
    agoraUsd * prices.eurPerUsd +
    c.cloudinaryUploads * prices.cloudinaryEurCentsPerUpload +
    ((c.pushSent + c.voipSent) / 1000) * prices.pushEurCentsPer1000;
  c.variableEurCents = round2(variable);
  c.perMauEurCents = doc.users?.mau ? round2(variable / doc.users.mau) : null;
  return doc;
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
};

/** Days from `dateKey` to `today` (both "YYYY-MM-DD", Europe/Berlin). */
const ageDays = (dateKey, today) => Math.round((dayStart(today) - dayStart(dateKey)) / 86_400_000);

/**
 * Carry the columns of RAW_TTL_DAYS over from `stored` into the freshly
 * counted `doc` when the day is too old for their raw rows to be complete.
 */
// Columns of RAW_TTL_DAYS kept only from a stored snapshot that is final:
// a partial one counted before the column's day was over
const FINAL_ONLY = new Set(["lifecycle.talk48h"]);

function keepExpired(doc, stored, age) {
  if (!stored) return doc;
  for (const [path, ttl] of Object.entries(RAW_TTL_DAYS)) {
    if (age < ttl - 1) continue;
    if (FINAL_ONLY.has(path) && stored.partial !== false) continue;
    const kept = getPath(stored, path);
    if (kept !== undefined) setPath(doc, path, kept);
  }
  return doc;
}

/**
 * Count `dateKey` and store it. A day that is already stored and older than
 * a column's raw data (RAW_TTL_DAYS) keeps that column's stored value, so a
 * recomputation (METRICS_VERSION) never turns a real number into a zero.
 */
async function saveDay(dateKey, now = new Date()) {
  const age = ageDays(dateKey, todayKey(now));
  const [doc, stored] = await Promise.all([
    computeDay(dateKey, now),
    age >= Math.min(...Object.values(RAW_TTL_DAYS)) - 1 ? MetricsDaily.findOne({ day: dateKey }, { _id: 0 }).lean() : null,
  ]);
  // Kept columns change the quantities: price them again
  if (stored) priceCosts(keepExpired(doc, stored, age), await pricesConfig());
  await MetricsDaily.updateOne({ day: dateKey }, { $set: doc }, { upsert: true });
  return doc;
}

/**
 * Keep snapshots current: today (partial) every run, finished days once.
 * The first run fills the last BACKFILL_DAYS days, as far as data allows.
 * Finished days of the last RECOMPUTE_DAYS days whose `version` is older
 * than METRICS_VERSION are counted again, newest first, at most
 * RECOMPUTE_PER_RUN per run; columns whose raw rows have expired keep
 * their stored value (saveDay).
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
  const outdated = await MetricsDaily.find(
    { day: { $gte: shiftDateKey(today, -RECOMPUTE_DAYS), $lt: today }, $or: [{ version: null }, { version: { $lt: METRICS_VERSION } }] },
    { day: 1 },
  )
    .sort({ day: -1 })
    .limit(RECOMPUTE_PER_RUN)
    .lean();
  for (const { day } of outdated) {
    await saveDay(day, now);
    written++;
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
 * in `contacts` and the share with none, plus the histogram (none · 1–2 ·
 * 3–5 · 6 and more, percent each). A thin address book is the usual reason
 * somebody never has a first talk.
 */
async function density(now = new Date()) {
  const ago = (days) => new Date(now.getTime() - days * 24 * 3600 * 1000);
  const ids = { $gte: idAt(ago(DENSITY_MAX_DAYS)), $lt: idAt(ago(DENSITY_MIN_DAYS)) };
  const [sample, c3plus, c0, c1_2, c6plus] = await Promise.all([
    User.countDocuments({ _id: ids }),
    User.countDocuments({ _id: ids, "contacts.2": { $exists: true } }),
    User.countDocuments({ _id: ids, $or: [{ contacts: { $size: 0 } }, { contacts: { $exists: false } }] }),
    User.countDocuments({ _id: ids, "contacts.0": { $exists: true }, "contacts.2": { $exists: false } }),
    User.countDocuments({ _id: ids, "contacts.5": { $exists: true } }),
  ]);
  const pct = (n) => (sample ? Math.round((n / sample) * 100) : null);
  return { c3plus: pct(c3plus), c0: pct(c0), sample, c1_2: pct(c1_2), c3_5: pct(c3plus - c6plus), c6plus: pct(c6plus) };
}

// --- Wanna yap+ --------------------------------------------------------------------

// Events that carry a price and start or continue a paid period
const PAID_EVENTS = ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION"];
// Plus that was given, not bought
const GIFT_SOURCES = ["admin", "referral", "waitlist", "gift"];

/** A product's price per month in cents: yearly plans are spread over twelve months. */
function monthlyCents(event) {
  const price = event.priceInPurchasedCurrencyCents ?? event.priceCents;
  if (price == null) return 0;
  return /year|annual|jahr/i.test(event.productId || "") ? Math.round(price / 12) : price;
}

/**
 * Wanna yap+ for one day (plan 2.4), from the SubscriptionEvents of the day
 * in PRODUCTION (sandbox purchases never count) and from User.plus as of
 * the end of the day, or now while it runs. User.plus has no history: a day
 * recomputed later (METRICS_VERSION) gets the active counts of today, the
 * event counts stay exact.
 *
 * - newPaid: INITIAL_PURCHASE outside a trial · trialsStarted: with TRIAL
 * - trialsConverted: a RENEWAL whose user's latest earlier paid event was a
 *   TRIAL (the first renewal after a trial is the conversion)
 * - renewed, cancelled, billingIssue, expired: the event types
 * - refunds: CANCELLATION with cancel_reason CUSTOMER_SUPPORT (Apple refund)
 * - mrrCents: for every active store plan the last paid event's price
 *   (purchase currency, else USD), yearly divided by twelve. Assumption:
 *   everyone pays in EUR (the app sells in Germany), so the sum is shown
 *   as euros; a purchase in another currency would be added at face value
 *
 * - giftToStore (plan 2.12): INITIAL_PURCHASE of the day (a trial start
 *   included) by people whose Plus was a gift before the store
 *   (User.plus.previousSource, set when the source switches to the store,
 *   lib/plusReconcile.js previousSourceFor); counted per person.
 *   giftDaysGranted is filled by computeDay from the day counters.
 *
 * The numbers steer decisions only from about 30 active store plans on
 * (assumption, plan 2.4); below that they are read, not judged.
 */
async function plusDay(from, to, now = new Date()) {
  const at = to > now ? now : to;
  const activeAt = { "plus.active": true, $or: [{ "plus.until": null }, { "plus.until": { $gt: at } }] };
  const [events, activeStore, activeGift, activeSandbox, storeUsers] = await Promise.all([
    SubscriptionEvent.find({ environment: "PRODUCTION", eventAt: { $gte: from, $lt: to } }, { type: 1, periodType: 1, cancelReason: 1, userId: 1, eventAt: 1 }).lean(),
    User.countDocuments({ ...activeAt, "plus.source": "store" }),
    User.countDocuments({ ...activeAt, "plus.source": { $in: GIFT_SOURCES } }),
    User.countDocuments({ ...activeAt, "plus.source": "sandbox" }),
    User.find({ ...activeAt, "plus.source": "store" }, { _id: 1 }).lean(),
  ]);
  const count = (fn) => events.filter(fn).length;
  const initial = (e) => e.type === "INITIAL_PURCHASE";
  let trialsConverted = 0;
  for (const e of events.filter((e) => e.type === "RENEWAL" && e.userId)) {
    const before = await SubscriptionEvent.findOne(
      { userId: e.userId, environment: "PRODUCTION", type: { $in: PAID_EVENTS }, eventAt: { $lt: e.eventAt } },
      { periodType: 1 },
    )
      .sort({ eventAt: -1 })
      .lean();
    if (before?.periodType === "TRIAL") trialsConverted++;
  }
  const buyers = [...new Set(events.filter((e) => initial(e) && e.userId).map((e) => String(e.userId)))];
  const giftToStore = buyers.length ? await User.countDocuments({ _id: { $in: buyers }, "plus.previousSource": { $in: GIFT_SOURCES } }) : 0;
  let mrrCents = 0;
  if (storeUsers.length) {
    const last = await SubscriptionEvent.aggregate([
      { $match: { userId: { $in: storeUsers.map((u) => u._id) }, environment: "PRODUCTION", type: { $in: PAID_EVENTS }, eventAt: { $lt: to } } },
      { $sort: { eventAt: -1 } },
      { $group: { _id: "$userId", productId: { $first: "$productId" }, priceCents: { $first: "$priceCents" }, priceInPurchasedCurrencyCents: { $first: "$priceInPurchasedCurrencyCents" } } },
    ]);
    mrrCents = last.reduce((sum, e) => sum + monthlyCents(e), 0);
  }
  return {
    activeStore,
    activeGift,
    activeSandbox,
    newPaid: count((e) => initial(e) && e.periodType !== "TRIAL"),
    renewed: count((e) => e.type === "RENEWAL"),
    cancelled: count((e) => e.type === "CANCELLATION"),
    billingIssue: count((e) => e.type === "BILLING_ISSUE"),
    expired: count((e) => e.type === "EXPIRATION"),
    refunds: count((e) => e.type === "CANCELLATION" && e.cancelReason === "CUSTOMER_SUPPORT"),
    trialsStarted: count((e) => initial(e) && e.periodType === "TRIAL"),
    trialsConverted,
    mrrCents,
    // computeDay fills it from the day counters (plan 2.12)
    giftDaysGranted: { referral: 0, waitlist: 0, admin: 0 },
    giftToStore,
  };
}

/** Were there any subscription events in this day's plus block? */
const plusMoved = (p) => !!p && ["newPaid", "renewed", "cancelled", "billingIssue", "expired", "trialsStarted", "trialsConverted"].some((k) => p[k] > 0);

const PAID_WINDOW_DAYS = 30;

/**
 * Of `users`, the share (0..1) with a production INITIAL_PURCHASE within 30
 * days of signing up; null while the window of the youngest member is still
 * open, so a cohort is never judged early.
 */
async function paidWithin30(users, now = new Date()) {
  if (!users.length) return null;
  const window = PAID_WINDOW_DAYS * 24 * 3600 * 1000;
  const signup = new Map(users.map((u) => [String(u._id), u._id.getTimestamp().getTime()]));
  if (Math.max(...signup.values()) + window > now.getTime()) return null;
  const events = await SubscriptionEvent.find(
    { userId: { $in: users.map((u) => u._id) }, type: "INITIAL_PURCHASE", environment: "PRODUCTION" },
    { userId: 1, eventAt: 1 },
  ).lean();
  const paid = new Set();
  for (const e of events) {
    const at = signup.get(String(e.userId));
    if (at != null && e.eventAt && e.eventAt.getTime() - at < window) paid.add(String(e.userId));
  }
  return Math.round((paid.size / users.length) * 100) / 100;
}

/**
 * Weekly cohorts (by sign-up week): share of each cohort that was active in
 * each following week (active = used the app or had a talk that week), plus
 * its activation (see above) and paid30, the share that bought Plus within
 * 30 days of signing up (null until the cohort's 30 days are over).
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
    cohorts.push({ week: key, size: users.length, weeks: share, ...(await activation(users, now)), paid30: await paidWithin30(users, now) });
  }
  return cohorts;
}

// --- Acquisition (plan 2.10) ----------------------------------------------------------

// Under this many measured people a source's activation is shown, not judged
// (Leitprinzip 6: cohort ≥ 50)
const ACQUISITION_MIN_SAMPLE = 50;

/**
 * Activation per acquisition source: of everyone who signed up in the last
 * `weeks` full weeks (Monday to Sunday, Europe/Berlin, like activation4w),
 * per answer (none: no answer) the size, how many could be measured (their
 * 7-day window is over), how many had their first talk within 7 days
 * (User.milestones.firstTalkAt) and that share in percent (null without a
 * measured person).
 */
async function activationBySource(weeks = 4, now = new Date()) {
  const thisWeek = weekKey(now, ZONE);
  const from = shiftDateKey(thisWeek, -7 * weeks);
  const users = await User.find({ _id: { $gte: idAt(dayStart(from)), $lt: idAt(dayStart(thisWeek)) } }, { acquisition: 1, "milestones.firstTalkAt": 1 }).lean();
  const window = ACTIVATION_DAYS * 24 * 3600 * 1000;
  const bySource = Object.fromEntries([...ACQUISITION_SOURCES, "none"].map((s) => [s, { size: 0, measured: 0, activated: 0, pct: null }]));
  for (const u of users) {
    const a = u.acquisition || {};
    const row = bySource[a.at && ACQUISITION_SOURCES.includes(a.source) ? a.source : "none"];
    row.size++;
    const at = u._id.getTimestamp().getTime();
    if (now.getTime() - at < window) continue;
    row.measured++;
    const talk = u.milestones?.firstTalkAt;
    if (talk && talk.getTime() - at < window) row.activated++;
  }
  for (const row of Object.values(bySource)) row.pct = row.measured ? Math.round((row.activated / row.measured) * 100) : null;
  return { weeks, from, to: shiftDateKey(thisWeek, -1), minSample: ACQUISITION_MIN_SAMPLE, bySource };
}

/**
 * The last 30 days of sign-ups by answer: how many, how many answered (the
 * plan's goal: over 70 %), per source, and the mean androidFriends with the
 * number of answers it rests on.
 */
async function acquisitionLast30(now = new Date()) {
  const users = await User.find({ _id: { $gte: idAt(new Date(now.getTime() - 30 * 24 * 3600 * 1000)), $lt: idAt(now) } }, { acquisition: 1 }).lean();
  const day = acquisitionDay(users);
  const androidAnswers = users.filter((u) => u.acquisition?.at && Number.isInteger(u.acquisition.androidFriends)).length;
  return { total: users.length, answered: users.length - day.bySource.none, bySource: day.bySource, androidFriendsAvg: day.androidFriendsAvg, androidFriendsAnswers: androidAnswers };
}

// --- Onboarding funnel -------------------------------------------------------------

// The steps in order, each the User field that marks it (lib/milestones in
// models/User.js). verified is the base: everyone in the cohort signed up.
const FUNNEL_STEPS = [
  ["verified", () => true],
  ["contactsSynced", (u) => !!u.milestones?.contactsSyncedAt],
  ["firstRegisteredContact", (u) => !!u.milestones?.firstRegisteredContactAt],
  ["pushGranted", (u) => !!u.milestones?.pushGrantedAt],
  ["firstInvite", (u) => !!(u.firstInviteAt || u.milestones?.firstInviteAt)],
  ["firstCall", (u) => !!u.milestones?.firstCallAt],
  ["firstTalk", (u) => !!u.milestones?.firstTalkAt],
];

/**
 * Onboarding by sign-up week (Monday to Sunday, Europe/Berlin), the last
 * `weeks` weeks including the current one, oldest first: the cohort's size
 * and, per step, the share in percent that reached it (null for an empty
 * week). The steps come from User.milestones (plan 1.12).
 */
async function funnel(weeks = 8, now = new Date()) {
  const thisWeek = weekKey(now, ZONE);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const key = shiftDateKey(thisWeek, -7 * i);
    const [from] = dayRange(key);
    const [, to] = dayRange(shiftDateKey(key, 6));
    const users = await User.find({ _id: { $gte: idAt(from), $lt: idAt(to) } }, { milestones: 1, firstInviteAt: 1 }).lean();
    const pct = (fn) => (users.length ? Math.round((users.filter(fn).length / users.length) * 100) : null);
    out.push({ week: key, size: users.length, steps: Object.fromEntries(FUNNEL_STEPS.map(([name, fn]) => [name, pct(fn)])) });
  }
  return out;
}

module.exports = {
  ZONE,
  todayKey,
  dayStart,
  dayRange,
  markActive,
  resetActivityCache,
  computeDay,
  lifecycleDay,
  saveDay,
  runSnapshots,
  series,
  retention,
  activation,
  activation4w,
  density,
  plusDay,
  plusMoved,
  monthlyCents,
  priceCosts,
  PAID_EVENTS,
  funnel,
  FUNNEL_STEPS,
  acquisitionDay,
  activationBySource,
  acquisitionLast30,
  ACQUISITION_MIN_SAMPLE,
  ACTIVATION_DAYS,
  METRICS_VERSION,
  RECOMPUTE_DAYS,
  RECOMPUTE_PER_RUN,
  RAW_TTL_DAYS,
};
