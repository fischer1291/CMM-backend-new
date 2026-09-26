/**
 * Only one instance runs the background jobs (schedules, rituals, the daily
 * moment, receipts, metrics). During a Render deploy two instances overlap for
 * a moment, and with more instances later all would push the same ritual. The
 * leader holds a lease in MongoDB and renews it; if it dies, another instance
 * takes over once the lease runs out.
 */
const crypto = require("crypto");
const Lock = require("../models/Lock");

const INSTANCE = `${process.env.RENDER_INSTANCE_ID || require("os").hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
const LEASE_MS = 90 * 1000;

/** Take or renew the lease for `key`. True while this instance holds it. */
async function holdLease(key, { owner = INSTANCE, now = new Date(), leaseMs = LEASE_MS } = {}) {
  const expiresAt = new Date(now.getTime() + leaseMs);
  try {
    const lock = await Lock.findOneAndUpdate(
      { key, $or: [{ owner }, { expiresAt: { $lt: now } }] },
      { $set: { owner, expiresAt } },
      { upsert: true, new: true },
    );
    return lock.owner === owner;
  } catch (err) {
    // Someone else holds it: the upsert ran into the unique key
    if (err.code === 11000) return false;
    throw err;
  }
}

/** Give the lease back (e.g. on shutdown), so the next instance starts at once. */
async function releaseLease(key, { owner = INSTANCE } = {}) {
  await Lock.deleteOne({ key, owner }).catch(() => {});
}

/** Run `fn` only if this instance is the leader for `key`. */
async function asLeader(key, fn) {
  if (!(await holdLease(key))) return undefined;
  return fn();
}

module.exports = { INSTANCE, LEASE_MS, holdLease, releaseLease, asLeader };
