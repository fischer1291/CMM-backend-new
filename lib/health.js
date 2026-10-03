/**
 * What GET /healthz answers (app.js). Render and an external monitor poll it
 * every minute, so it only reads: is the database connected, and did the
 * leader finish a job recently (lib/leader.js writes lastRunAt)? A fresh
 * process gets a grace period, because the first minute tick is still ahead.
 */
const mongoose = require("mongoose");
const { lastRunAt } = require("./leader");

const JOBS = "jobs";
// The minute tick is the slowest job under the lock; three misses mean trouble
const MAX_TICK_AGE_MS = 3 * 60 * 1000;
// Startup: connecting, migrating and the first tick take well under this
const STARTUP_GRACE_SEC = 5 * 60;

/** { ok, ...body } for /healthz; `now` and `uptimeSec` are injectable for tests. */
async function healthStatus({ now = new Date(), uptimeSec = process.uptime() } = {}) {
  const version = (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7);
  if (mongoose.connection.readyState !== 1) return { ok: false, reason: "db" };
  let last;
  try {
    last = await lastRunAt(JOBS);
  } catch {
    return { ok: false, reason: "db" };
  }
  if (!last) {
    return uptimeSec < STARTUP_GRACE_SEC ? { ok: true, db: "connected", lastTickAgeSec: null, version } : { ok: false, reason: "no_tick" };
  }
  const lastTickAgeSec = Math.max(0, Math.round((now.getTime() - last.getTime()) / 1000));
  if (lastTickAgeSec * 1000 > MAX_TICK_AGE_MS) return { ok: false, reason: "tick_stale", lastTickAgeSec };
  return { ok: true, db: "connected", lastTickAgeSec, version };
}

module.exports = { healthStatus, MAX_TICK_AGE_MS, STARTUP_GRACE_SEC };
