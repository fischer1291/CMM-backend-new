/**
 * Small operational counters per day (Europe/Berlin): how often calls were
 * refused for strangers, suspicious address book matches, later SMS sent and
 * refused (plan 1.4). Each day is one OpsTally document ("ops:YYYY-MM-DD")
 * raised with $inc, so counting is one write and never races; lib/metrics.js
 * copies the day's counts into the MetricsDaily snapshot (ops.*), where they
 * survive the raw data.
 */
const OpsTally = require("../models/OpsTally");
const { localParts } = require("./localTime");

const ZONE = "Europe/Berlin";
const NAME = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

const idFor = (now) => `ops:${localParts(now, ZONE).dateKey}`;

/** Raise `name` for the day of `now` by `by` (default 1). Fire and forget safe. */
async function count(name, now = new Date(), by = 1) {
  if (!NAME.test(name)) throw new Error(`opsCounters: invalid counter name "${name}"`);
  await OpsTally.updateOne({ _id: idFor(now) }, { $inc: { [`counts.${name}`]: by } }, { upsert: true });
}

/** The counts of one day ("YYYY-MM-DD"): { name: n, ... }, {} when nothing happened. */
async function countsOf(dateKey) {
  const doc = await OpsTally.findById(`ops:${dateKey}`).lean();
  return { ...(doc?.counts || {}) };
}

module.exports = { count, countsOf };
