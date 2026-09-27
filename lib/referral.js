/**
 * Invite rewards: every STEP people who join through your invites give you
 * REWARD_DAYS of Wanna yap+, up to MAX_REWARDS times. The days add up on top
 * of a running gift. People with a store subscription or a permanent admin
 * grant have Plus already: their rewards count as given, nothing changes.
 */
const User = require("../models/User");
const { isPlus } = require("./plan");
const { notifyMany } = require("./notify");

const STEP = 3;
const REWARD_DAYS = 30;
const MAX_REWARDS = 6;
const DAY = 24 * 3600 * 1000;

const rewardsFor = (joined) => Math.min(Math.floor((joined || 0) / STEP), MAX_REWARDS);

/** What the app shows: progress towards the next reward. */
function referralOf(user) {
  const joined = user?.invitesJoined || 0;
  const earned = rewardsFor(joined);
  return {
    step: STEP,
    rewardDays: REWARD_DAYS,
    maxRewards: MAX_REWARDS,
    joined,
    earned,
    toNext: earned >= MAX_REWARDS ? null : STEP - (joined % STEP),
  };
}

// Plus that a reward shouldn't touch: a store subscription or an admin grant without end
function hasOwnPlus(user, now) {
  if (!isPlus(user, now)) return false;
  return user.plus.source === "store" || (user.plus.source === "admin" && !user.plus.until);
}

/**
 * Give the rewards that are due to these inviters (after invitesJoined went
 * up). Returns the phones that got Plus days.
 */
async function grantRewards(phones, io, now = new Date()) {
  if (!phones.length) return [];
  const users = await User.find({ phone: { $in: phones } }, { phone: 1, invitesJoined: 1, referralRewards: 1, plus: 1 }).lean();
  const rewarded = [];
  for (const user of users) {
    const given = user.referralRewards || 0;
    const due = rewardsFor(user.invitesJoined) - given;
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

module.exports = { STEP, REWARD_DAYS, MAX_REWARDS, rewardsFor, referralOf, grantRewards };
