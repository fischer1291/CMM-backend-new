/**
 * "Erst sprechen, dann sehen": friends' moments of the day stay blurred until
 * you've had a real conversation (a minute or more) or joined the Yap Moment
 * today. Each unlocked day is recorded for the streak and the badges.
 */
const Talk = require("../models/Talk");
const Call = require("../models/Call");
const DailyMoment = require("../models/DailyMoment");
const MomentUnlock = require("../models/MomentUnlock");
const { localParts, shiftDateKey } = require("./localTime");
const { startOfLocalDay } = require("./moments");

const MIN_SECONDS = 60;
const zoneOf = (user) => user.timezone || user.schedule?.timezone;

/** Why `user` has unlocked today ("talk" / "daily"), or null. */
async function unlockReason(user, now = new Date()) {
  const zone = zoneOf(user);
  const since = startOfLocalDay(now, zone);
  const phone = user.phone;
  const [talk, call, daily] = await Promise.all([
    Talk.exists({
      startedAt: { $gte: since },
      seconds: { $gte: MIN_SECONDS },
      $or: [{ group: { $ne: true }, participants: phone }, { group: true, owner: phone }],
    }),
    // A call going on for a minute, or one that just ended (before its talk
    // record is written)
    Call.exists({
      $and: [
        { $or: [{ caller: phone }, { callee: phone }] },
        { acceptedAt: { $gte: since } },
        {
          $or: [
            { status: "accepted", acceptedAt: { $lte: new Date(now.getTime() - MIN_SECONDS * 1000) } },
            { status: "ended", $expr: { $gte: [{ $subtract: ["$endedAt", "$acceptedAt"] }, MIN_SECONDS * 1000] } },
          ],
        },
      ],
    }),
    DailyMoment.exists({ day: localParts(now, zone).dateKey, joined: phone }),
  ]);
  if (talk || call) return "talk";
  if (daily) return "daily";
  return null;
}

/** Record today's unlock (idempotent). */
async function noteUnlock(user, via, now = new Date()) {
  const day = localParts(now, zoneOf(user)).dateKey;
  await MomentUnlock.updateOne({ phone: user.phone, day }, { $setOnInsert: { via, at: now } }, { upsert: true }).catch((err) => {
    if (err.code !== 11000) throw err;
  });
}

/**
 * Today's state for the feed: { unlocked, via, streak, best, total }.
 * The streak counts days in a row up to today, or up to yesterday while
 * today is still open (so it doesn't look broken in the morning).
 */
async function unlockState(user, now = new Date()) {
  const via = await unlockReason(user, now);
  if (via) await noteUnlock(user, via, now);
  const today = localParts(now, zoneOf(user)).dateKey;
  const days = (await MomentUnlock.find({ phone: user.phone }, { day: 1 }).sort({ day: -1 }).limit(400).lean()).map((d) => d.day);
  const set = new Set(days);

  let streak = 0;
  for (let d = set.has(today) ? today : shiftDateKey(today, -1); set.has(d); d = shiftDateKey(d, -1)) streak++;

  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort()) {
    run = prev && shiftDateKey(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { unlocked: !!via, via, streak, best, total: await MomentUnlock.countDocuments({ phone: user.phone }) };
}

/** A talk or the Yap Moment happened: record the unlock for these people. */
async function noteUnlockFor(phones, via, now = new Date()) {
  const User = require("../models/User");
  const users = await User.find({ phone: { $in: phones } }, { phone: 1, timezone: 1, schedule: 1 }).lean();
  await Promise.all(users.map((u) => noteUnlock(u, via, now)));
}

module.exports = { MIN_SECONDS, unlockReason, noteUnlock, noteUnlockFor, unlockState };

// --- Evening reminder ------------------------------------------------------------

const EVENING_START = 19 * 60;
const EVENING_WINDOW = 15; // minutes; the throttle makes it once a day

/**
 * Around 19:00 local time: people who haven't unlocked today and have moments
 * of friends waiting get one gentle push (moments_waiting, respects prefs,
 * quiet hours and the daily cap).
 */
async function tickMomentsWaiting(now = new Date()) {
  const User = require("../models/User");
  const CallMoment = require("../models/CallMoment");
  const { notify } = require("./notify");
  const { blockedWith } = require("./relations");
  const { DEFAULT_TIMEZONE } = require("./localTime");

  const zones = (await User.distinct("timezone")).map((z) => z || null);
  const due = [...new Set(zones)].filter((z) => {
    const { minutes } = localParts(now, z || DEFAULT_TIMEZONE);
    return minutes >= EVENING_START && minutes < EVENING_START + EVENING_WINDOW;
  });
  if (!due.length) return 0;

  const users = await User.find({
    timezone: { $in: due },
    pushToken: { $exists: true, $ne: null },
    "notificationPrefs.moments": { $ne: false },
  });
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  let sent = 0;
  for (const user of users) {
    if (!user.contacts?.length) continue;
    if (await unlockReason(user, now)) continue;
    const blocked = [...(await blockedWith(user.phone))];
    const count = await CallMoment.countDocuments({
      userPhone: { $in: user.contacts.filter((c) => !blocked.includes(c)) },
      targetPhone: { $ne: user.phone },
      status: { $ne: "pending" },
      hidden: { $ne: true },
      $or: [{ sharedAt: { $gt: since } }, { sharedAt: null, timestamp: { $gt: since } }],
    });
    if (!count) continue;
    const result = await notify(user, "moments_waiting", { count }, { now });
    if (result?.sent) sent++;
  }
  return sent;
}

module.exports.tickMomentsWaiting = tickMomentsWaiting;
