/**
 * Rules for shared moments:
 * - a moment is a picture from a real call, so it needs an answered call
 *   between the two within the last day
 * - it's shared only after the other person agreed (pending until then,
 *   deleted after a day without an answer)
 * - others see it for 24 hours, then it's a memory of the two
 * - friends' moments show only after your own first real conversation
 *   of the day ("erst sprechen, dann sehen")
 */
const cloudinary = require("cloudinary").v2;
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const CallMoment = require("../models/CallMoment");
const { localParts } = require("./localTime");
const { publicIdOf } = require("./account");

const DAY_MS = 24 * 3600 * 1000;
const VISIBLE_MS = DAY_MS;
const PENDING_MS = DAY_MS;

/** Did a and b have an answered call since `since`? */
async function talkedWith(a, b, since) {
  return !!(await Call.exists({
    $or: [
      { caller: a, callee: b },
      { caller: b, callee: a },
    ],
    acceptedAt: { $gt: since },
  }));
}

/** Local midnight (as a Date) of `now` in `timeZone`. */
function startOfLocalDay(now, timeZone) {
  const { minutes } = localParts(now, timeZone);
  const start = new Date(now.getTime() - minutes * 60 * 1000);
  start.setUTCSeconds(0, 0);
  return start;
}

/** Had `user` a real conversation today (their time zone)? */
async function talkedToday(user, now = new Date()) {
  const since = startOfLocalDay(now, user.timezone || user.schedule?.timezone);
  const [talk, call] = await Promise.all([
    Talk.exists({ participants: user.phone, startedAt: { $gte: since } }),
    // A call going on right now counts too
    Call.exists({ $or: [{ caller: user.phone }, { callee: user.phone }], acceptedAt: { $gte: since } }),
  ]);
  return !!(talk || call);
}

async function deleteMoment(moment) {
  await CallMoment.deleteOne({ _id: moment._id });
  const id = publicIdOf(moment.screenshot);
  if (id && process.env.CLOUDINARY_API_SECRET) {
    await cloudinary.uploader.destroy(id).catch(() => {});
  }
}

/** Pending moments nobody answered within a day are removed. */
async function expirePendingMoments(now = new Date()) {
  const stale = await CallMoment.find({ status: "pending", timestamp: { $lt: new Date(now - PENDING_MS) } }, "screenshot");
  for (const m of stale) await deleteMoment(m);
  return stale.length;
}

module.exports = { talkedWith, talkedToday, startOfLocalDay, deleteMoment, expirePendingMoments, VISIBLE_MS, DAY_MS };
