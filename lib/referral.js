/**
 * Invite rewards: every STEP people who join through your invites and then
 * have their first talk (User.invitesActivated, raised by noteFirstTalk from
 * lib/calls.js recordTalk and circle rounds in lib/circles.js) give you
 * REWARD_DAYS of Wanna yap+, up to MAX_REWARDS times.
 * Joining alone (invitesJoined) earns nothing: three prepaid SIMs must not
 * buy a month of Plus. The days add up on top of a running gift. People with
 * a store subscription or a permanent admin grant have Plus already: their
 * rewards count as given, nothing changes.
 */
const User = require("../models/User");
const { isPlus } = require("./plan");
const { notifyMany } = require("./notify");

const STEP = 3;
const REWARD_DAYS = 30;
const MAX_REWARDS = 6;
const DAY = 24 * 3600 * 1000;

const rewardsFor = (activated) => Math.min(Math.floor((activated || 0) / STEP), MAX_REWARDS);

/** What the app shows: who joined, who counts already, progress towards the next reward. */
function referralOf(user) {
  const joined = user?.invitesJoined || 0;
  const activated = user?.invitesActivated || 0;
  const earned = rewardsFor(activated);
  return {
    step: STEP,
    rewardDays: REWARD_DAYS,
    maxRewards: MAX_REWARDS,
    joined,
    activated,
    earned,
    toNext: earned >= MAX_REWARDS ? null : STEP - (activated % STEP),
  };
}

// Plus that a reward shouldn't touch: a store subscription or an admin grant without end
function hasOwnPlus(user, now) {
  if (!isPlus(user, now)) return false;
  return user.plus.source === "store" || (user.plus.source === "admin" && !user.plus.until);
}

/**
 * Give the rewards that are due to these inviters (after invitesActivated
 * went up). Returns the phones that got Plus days.
 */
async function grantRewards(phones, io, now = new Date()) {
  if (!phones.length) return [];
  const users = await User.find({ phone: { $in: phones } }, { phone: 1, invitesActivated: 1, referralRewards: 1, plus: 1 }).lean();
  const rewarded = [];
  for (const user of users) {
    const given = user.referralRewards || 0;
    const due = rewardsFor(user.invitesActivated) - given;
    if (due <= 0) continue;
    const update = { referralRewards: given + due };
    if (!hasOwnPlus(user, now)) {
      const from = isPlus(user, now) && user.plus.until ? new Date(user.plus.until) : now;
      update.plus = {
        ...(user.plus || {}),
        active: true,
        until: new Date(from.getTime() + due * REWARD_DAYS * DAY),
        since: isPlus(user, now) ? user.plus.since || now : now,
        source: "referral",
        productId: null,
      };
    }
    // Only if nobody else granted in the meantime (two invitees joining at once)
    const res = await User.updateOne({ phone: user.phone, referralRewards: given || { $in: [0, null] } }, { $set: update });
    if (res.modifiedCount && update.plus) rewarded.push(user.phone);
  }
  for (const phone of rewarded) io?.to(`user:${phone}`).emit("planChanged", {});
  if (rewarded.length) await notifyMany(rewarded, "referral_reward", { days: REWARD_DAYS });
  return rewarded;
}

/**
 * The first talk of a user is a milestone (User.milestones.firstTalkAt);
 * if they came in through invites, it is the moment their inviters' invite
 * counts for a reward. The conditional update makes sure a talk recorded
 * twice credits the inviters once.
 */
async function noteFirstTalk(phones, at, io) {
  const fresh = await User.find({ phone: { $in: phones }, "milestones.firstTalkAt": null }, { phone: 1, invitedBy: 1 }).lean();
  for (const user of fresh) {
    const res = await User.updateOne({ phone: user.phone, "milestones.firstTalkAt": null }, { $set: { "milestones.firstTalkAt": at } });
    const inviters = user.invitedBy || [];
    if (!res.modifiedCount || !inviters.length) continue;
    await User.updateMany({ phone: { $in: inviters } }, { $inc: { invitesActivated: 1 } });
    await grantRewards(inviters, io);
  }
}

module.exports = { STEP, REWARD_DAYS, MAX_REWARDS, rewardsFor, referralOf, grantRewards, noteFirstTalk };
