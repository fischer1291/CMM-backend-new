/**
 * Small operational counters per day (Europe/Berlin): how often calls were
 * refused for strangers, suspicious address book matches, sign-up SMS
 * started, checked and failed. Each day is one OpsTally document
 * ("ops:YYYY-MM-DD") raised with $inc, so counting is one write and never
 * races; lib/metrics.js copies the day's counts into the MetricsDaily
 * snapshot (ops.*), where they survive the raw data. countUpTo() raises a
 * counter only while it stays under a cap, so a daily limit (the SMS cap)
 * is checked and booked in one step. The gift budget (plan 2.12) books its
 * Plus days here too: giftDays_referral, giftDays_waitlist, giftDays_admin.
 *
 * The few counters an outage banner hangs on (RECENT, plan 2.15) are also
 * kept per UTC hour ("opsh:YYYY-MM-DDTHH", expiresAt two days later, TTL),
 * so lib/alerts.js can tell an outage that is still going on from one that
 * happened this morning: countsOfRecent() sums this hour and the one before.
 */
const OpsTally = require("../models/OpsTally");
const { localParts } = require("./localTime");

const ZONE = "Europe/Berlin";
// Letters, digits and "_" (giftDays_referral, lib/referral.js countGiftDays)
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

const idFor = (now) => `ops:${localParts(now, ZONE).dateKey}`;

// Counters behind the userFacing alert rules (lib/alerts.js): also per hour
const RECENT = new Set(["smsStarted", "smsFailed", "pushCredentialErrors", "rtcTokenIssued", "rtcTokenFailed"]);
const HOUR = 3600 * 1000;
const hourIdFor = (now) => `opsh:${new Date(now).toISOString().slice(0, 13)}`;

async function countHour(name, now, by) {
  if (!RECENT.has(name)) return;
  const at = new Date(now);
  await OpsTally.updateOne(
    { _id: hourIdFor(at) },
    { $inc: { [`counts.${name}`]: by }, $setOnInsert: { expiresAt: new Date(at.getTime() + 2 * 24 * HOUR) } },
    { upsert: true },
  );
}

/** Raise `name` for the day of `now` by `by` (default 1). Fire and forget safe. */
async function count(name, now = new Date(), by = 1) {
  if (!NAME.test(name)) throw new Error(`opsCounters: invalid counter name "${name}"`);
  await Promise.all([OpsTally.updateOne({ _id: idFor(now) }, { $inc: { [`counts.${name}`]: by } }, { upsert: true }), countHour(name, now, by)]);
}

/**
 * Raise `name` by `by` only if the day's value stays within `cap`. The check
 * and the increment are one conditional update (as in lib/marketingBudget.js
 * raise), so two requests at the limit can't both get through. Returns
 * whether it was raised.
 */
async function countUpTo(name, cap, now = new Date(), by = 1) {
  if (!NAME.test(name)) throw new Error(`opsCounters: invalid counter name "${name}"`);
  const field = `counts.${name}`;
  await OpsTally.updateOne({ _id: idFor(now) }, { $setOnInsert: { counts: {} } }, { upsert: true });
  const res = await OpsTally.updateOne(
    { _id: idFor(now), $or: [{ [field]: { $exists: false } }, { [field]: { $lte: cap - by } }] },
    { $inc: { [field]: by } },
  );
  if (res.modifiedCount !== 1) return false;
  await countHour(name, now, by);
  return true;
}

/** The counts of one day ("YYYY-MM-DD"): { name: n, ... }, {} when nothing happened. */
async function countsOf(dateKey) {
  const doc = await OpsTally.findById(`ops:${dateKey}`).lean();
  return { ...(doc?.counts || {}) };
}

/**
 * The RECENT counters of this UTC hour and the one before (the last 60 to
 * 120 minutes): { name: n, ... }, {} when nothing happened.
 */
async function countsOfRecent(now = new Date()) {
  const at = new Date(now);
  const docs = await OpsTally.find({ _id: { $in: [hourIdFor(at), hourIdFor(at.getTime() - HOUR)] } }).lean();
  const sum = {};
  for (const d of docs) for (const [k, v] of Object.entries(d.counts || {})) sum[k] = (sum[k] || 0) + v;
  return sum;
}

module.exports = { count, countUpTo, countsOf, countsOfRecent, RECENT };
