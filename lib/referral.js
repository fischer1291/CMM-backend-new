/**
 * Invite rewards: every STEP people who join through your invites and then
 * have their first talk (User.invitesActivated, raised by noteFirstTalk from
 * lib/calls.js recordTalk and circle rounds in lib/circles.js) give you
 * REWARD_DAYS of Wanna yap+, up to MAX_REWARDS times.
 * Joining alone (invitesJoined) earns nothing: three prepaid SIMs must not
 * buy a month of Plus. The days add up on top of a running gift. People with
 * a store subscription or a permanent admin grant have Plus already: their
 * rewards count as given, nothing changes.
 *
 * Plan 2.12: every gift day given anywhere (here, lib/waitlist.js, the
 * console's Plus grant) is booked as a day counter giftDays_<source>
 * (countGiftDays), which lib/metrics.js copies into
 * MetricsDaily.plus.giftDaysGranted and the alert gift_days holds against
 * AppConfig.goals.giftDaysPerWeek. The two-sided experiment (flag
 * referral_two_sided, off by default): after the first talk of an invitee
 * with their inviter both get PAIR_DAYS of Plus, once per pair
 * (rewardPair, marker User.referralPairRewards on the invitee).
 */
const User = require("../models/User");
const Talk = require("../models/Talk");
const { isPlus } = require("./plan");
const { notify, notifyMany } = require("./notify");
const { flag } = require("./appConfig");
const opsCounters = require("./opsCounters");
const { MIN_SECONDS: PAIR_MIN_SECONDS } = require("./unlock");

const STEP = 3;
const REWARD_DAYS = 30;
const MAX_REWARDS = 6;
const DAY = 24 * 3600 * 1000;
// Two-sided experiment: days for each of the pair, and the flag that turns it on
const PAIR_DAYS = 7;
const TWO_SIDED_FLAG = "referral_two_sided";
// Where gift days come from (the day counters giftDays_<source>)
const GIFT_DAY_SOURCES = ["referral", "waitlist", "admin"];
// Plus from the store, in production or from a test account
const STORE_SOURCES = ["store", "sandbox"];

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

// Plus that a gift shouldn't touch: a store subscription (also a test
// account's) or an admin grant without end. lib/waitlist.js uses it too.
function hasOwnPlus(user, now) {
  if (!isPlus(user, now)) return false;
  return STORE_SOURCES.includes(user.plus.source) || (user.plus.source === "admin" && !user.plus.until);
}

/** User.plus after `days` more of a gift from `source`, on top of a running gift. */
function giftedPlus(user, days, source, now) {
  const running = isPlus(user, now);
  const from = running && user.plus.until ? new Date(user.plus.until) : now;
  return {
    ...(user.plus?.toObject?.() || user.plus || {}),
    active: true,
    until: new Date(from.getTime() + days * DAY),
    since: running ? user.plus.since || now : now,
    source,
    productId: null,
  };
}

/**
 * Book `days` gift days of `source` (referral | waitlist | admin) on the day
 * of `now`: the gift budget (plan 2.12). Never throws: a lost count must not
 * cost anyone their Plus.
 */
async function countGiftDays(source, days, now = new Date()) {
  if (!GIFT_DAY_SOURCES.includes(source) || !(days > 0)) return;
  await opsCounters.count(`giftDays_${source}`, now, days).catch((err) => console.error("❌ giftDays:", err.message));
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
    if (!hasOwnPlus(user, now)) update.plus = giftedPlus(user, due * REWARD_DAYS, "referral", now);
    // Only if nobody else granted in the meantime (two invitees joining at once)
    const res = await User.updateOne({ phone: user.phone, referralRewards: given || { $in: [0, null] } }, { $set: update });
    if (res.modifiedCount && update.plus) {
      rewarded.push(user.phone);
      await countGiftDays("referral", due * REWARD_DAYS, now);
    }
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

/** Is the two-sided experiment on (flag referral_two_sided, cached 30 s)? */
const twoSidedOn = () => flag(TWO_SIDED_FLAG, false);

/**
 * Two-sided experiment: `a` and `b` just had a 1:1 talk (lib/calls.js
 * recordTalk). If one of them came in through the other's invite and this
 * is their first talk of at least PAIR_MIN_SECONDS (an earlier one, also
 * from before the flag went on, means it was not the first), both get
 * PAIR_DAYS of Plus as referral, on top of a running gift; someone with a
 * store plan or an open admin grant keeps it and gets nothing. Once per
 * pair: the inviter's number goes into the invitee's
 * User.referralPairRewards by a conditional update, so a talk recorded
 * twice rewards once. Returns the phones that got days.
 */
async function rewardPair(a, b, seconds, io, now = new Date()) {
  if (!a || !b || a === b || !(seconds >= PAIR_MIN_SECONDS)) return [];
  if (!(await twoSidedOn())) return [];
  const users = await User.find({ phone: { $in: [a, b] } }, { phone: 1, invitedBy: 1, referralPairRewards: 1, plus: 1, name: 1 }).lean();
  if (users.length !== 2) return [];
  const invitee = users.find((u) => (u.invitedBy || []).includes(users.find((o) => o.phone !== u.phone).phone));
  if (!invitee) return [];
  const inviter = users.find((u) => u.phone !== invitee.phone);
  if ((invitee.referralPairRewards || []).includes(inviter.phone) || (inviter.referralPairRewards || []).includes(invitee.phone)) return [];
  const earlier = await Talk.countDocuments({ participants: { $all: [a, b] }, group: { $ne: true }, seconds: { $gte: PAIR_MIN_SECONDS } });
  if (earlier > 1) return [];
  const claimed = await User.updateOne({ phone: invitee.phone, referralPairRewards: { $ne: inviter.phone } }, { $addToSet: { referralPairRewards: inviter.phone } });
  if (!claimed.modifiedCount) return [];
  const rewarded = [];
  for (const user of [invitee, inviter]) {
    if (hasOwnPlus(user, now)) continue;
    await User.updateOne({ phone: user.phone }, { $set: { plus: giftedPlus(user, PAIR_DAYS, "referral", now) } });
    await countGiftDays("referral", PAIR_DAYS, now);
    rewarded.push(user);
  }
  for (const user of rewarded) {
    io?.to(`user:${user.phone}`).emit("planChanged", {});
    const other = user === invitee ? inviter : invitee;
    await notify(user.phone, "referral_pair_reward", { days: PAIR_DAYS, name: other.name, phone: other.phone }, { now }).catch((err) => console.error("❌ referral_pair_reward:", err.message));
  }
  return rewarded.map((u) => u.phone);
}

module.exports = { STEP, REWARD_DAYS, MAX_REWARDS, PAIR_DAYS, PAIR_MIN_SECONDS, TWO_SIDED_FLAG, GIFT_DAY_SOURCES, rewardsFor, referralOf, hasOwnPlus, giftedPlus, countGiftDays, twoSidedOn, grantRewards, noteFirstTalk, rewardPair };
