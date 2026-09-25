/**
 * The daily Yap Moment: once a day, at a random time between 10:00 and
 * 21:00 in each time zone, everyone gets "you all have 10 minutes now".
 * Whoever joins is available until the window ends, so friends are
 * reachable at the same time, which is what usually never happens.
 */
const User = require("../models/User");
const DailyMoment = require("../models/DailyMoment");
const { localParts, DEFAULT_TIMEZONE } = require("./localTime");
const { notifyMany } = require("./notify");

const WINDOW_MS = 10 * 60 * 1000;
const EARLIEST = 10 * 60; // local minutes
const LATEST = 21 * 60;

const zoneOf = (user) => user.timezone || user.schedule?.timezone || DEFAULT_TIMEZONE;

/** Today's moment for a zone, created with a random time if missing. */
async function momentFor(zone, now = new Date(), random = Math.random) {
  const { dateKey, minutes } = localParts(now, zone);
  const existing = await DailyMoment.findOne({ day: dateKey, zone });
  if (existing) return existing;

  // Created late in the day (first user of a zone, or a restart): the rest of today
  const from = Math.max(EARLIEST, minutes + 5);
  const target = from >= LATEST ? null : from + Math.floor(random() * (LATEST - from));
  const at = target === null ? new Date(now.getTime() + 24 * 3600 * 1000) : new Date(now.getTime() + (target - minutes) * 60 * 1000);
  try {
    return await DailyMoment.create({ day: dateKey, zone, at, endsAt: new Date(at.getTime() + WINDOW_MS), sentAt: target === null ? now : null });
  } catch (err) {
    if (err.code === 11000) return DailyMoment.findOne({ day: dateKey, zone });
    throw err;
  }
}

/** Every minute: start due moments (push + socket to everyone in the zone). */
async function tickDailyMoments(io, now = new Date()) {
  const zones = new Set([DEFAULT_TIMEZONE, ...(await User.distinct("timezone")).filter(Boolean)]);
  let started = 0;
  for (const zone of zones) {
    const moment = await momentFor(zone, now);
    if (moment.sentAt || moment.at > now) continue;
    // Only one process may start it
    const claimed = await DailyMoment.findOneAndUpdate({ _id: moment._id, sentAt: null }, { sentAt: now }, { new: true });
    if (!claimed) continue;
    started++;

    const inZone = await User.find(
      zone === DEFAULT_TIMEZONE ? { $or: [{ timezone: zone }, { timezone: null }] } : { timezone: zone },
      "phone pushToken notificationPrefs timezone schedule.timezone",
    );
    const users = inZone.filter((u) => u.notificationPrefs?.dailyMoment !== false);
    for (const u of users) {
      io?.to(`user:${u.phone}`).emit("dailyMoment", { endsAt: claimed.endsAt });
    }
    await notifyMany(users, "daily_moment", { endsAt: claimed.endsAt });
  }
  return started;
}

/** The moment that is running now for this user, or null. */
async function activeMomentFor(user, now = new Date()) {
  const { dateKey } = localParts(now, zoneOf(user));
  const moment = await DailyMoment.findOne({ day: dateKey, zone: zoneOf(user) });
  if (!moment?.sentAt || moment.at > now || moment.endsAt <= now) return null;
  return moment;
}

module.exports = { momentFor, tickDailyMoments, activeMomentFor, zoneOf, WINDOW_MS };
