require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");
const Call = require("./models/Call");
const { createApp } = require("./app");
const { initializeVoipPush } = require("./lib/push");
const { agoraCredentials } = require("./lib/agora");
const { expireMoments } = require("./routes/moment");
const { broadcastStatus } = require("./routes/status");
const { applySchedules } = require("./lib/schedule");
const { checkReceipts } = require("./lib/receipts");
const { tickDailyMoments } = require("./lib/dailyMoment");
const { expirePendingMoments } = require("./lib/moments");
const { runSnapshots } = require("./lib/metrics");
const { asLeader, releaseLease, INSTANCE } = require("./lib/leader");
const { migratePrivateCircles, tickRituals, endStaleRooms } = require("./lib/circles");

const PORT = process.env.PORT || 3000;

/** One-off data fixes that are safe to run on every start. */
async function migrate() {
  const missingHash = await User.find({ phoneHash: { $exists: false } }, "phone");
  for (const user of missingHash) {
    await User.updateOne({ _id: user._id }, { phoneHash: User.hashPhone(user.phone) });
  }
  if (missingHash.length) console.log(`🔧 Added phoneHash to ${missingHash.length} users`);

  // Private circle lists became shared circles (lib/circles.js)
  const migrated = await migratePrivateCircles();
  if (migrated) console.log(`🔧 Moved private circles of ${migrated} users to shared circles`);

  // Nudges: the unique (from, to) index and the 20 h TTL were replaced by a
  // history with cooldowns; syncIndexes drops/recreates what changed
  await require("./models/Nudge").syncIndexes();
}

async function main() {
  initializeVoipPush();

  if (!process.env.JWT_SECRET) {
    console.warn("⚠️ JWT_SECRET not set: no auth tokens are issued (legacy mode)");
  }
  if (agoraCredentials().usingLegacyCertificate) {
    console.error("❌ AGORA_APP_CERTIFICATE not set: calls will fail (no RTC tokens)");
  }

  const { server, io, calls } = createApp();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ MongoDB verbunden");
  await migrate();
  const stale = await calls.sweepStaleCalls();
  if (stale) console.log(`🔧 Marked ${stale} stale ringing calls as missed`);
  // Talk-time stats start with the calls still on record (idempotent)
  const answered = await Call.find({ status: "ended", acceptedAt: { $ne: null }, endedAt: { $ne: null } });
  for (const call of answered) await calls.recordTalk(call);

  // Every minute: start scheduled availability, end expired sessions
  const tick = async () => {
    await applySchedules((user) => broadcastStatus(io, user, { becameAvailable: true }));
    await expireMoments(io);
    await tickDailyMoments(io);
    await expirePendingMoments();
    await tickRituals(io);
    await endStaleRooms();
  };
  // Background jobs run on one instance only (lib/leader.js). The minute tick
  // also renews the lease, so the leader keeps it while it's alive.
  const JOBS = "jobs";
  let leading = false;
  const asJobLeader = async (name, fn) => {
    const result = await asLeader(JOBS, async () => {
      if (!leading) console.log(`👑 ${INSTANCE} runs the background jobs`);
      leading = true;
      return fn();
    });
    if (result === undefined && leading) {
      console.log(`👋 ${INSTANCE} lost the background jobs to another instance`);
      leading = false;
    }
    return result;
  };
  setInterval(() => {
    asJobLeader("tick", tick).catch((err) => console.error("❌ availability tick:", err.message));
  }, 60 * 1000);

  // Admin numbers: fill missing days now, then refresh every 30 minutes
  const snapshots = () =>
    asJobLeader("snapshots", runSnapshots).catch((err) => console.error("❌ metrics snapshots:", err.message));
  snapshots();
  setInterval(snapshots, 30 * 60 * 1000);

  // Every 15 minutes: delivery receipts of sent pushes
  setInterval(() => {
    asJobLeader("receipts", checkReceipts)
      .then((result) => {
        if (result?.errors) console.log(`📬 Push receipts: ${result.errors} errors, ${result.removedTokens} tokens removed`);
      })
      .catch((err) => console.error("❌ checkReceipts:", err.message));
  }, 15 * 60 * 1000);

  server.listen(PORT, () => console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`));

  // Render stops the old instance with SIGTERM after a deploy: hand the jobs
  // over right away instead of waiting for the lease to run out
  const shutdown = async (signal) => {
    console.log(`🛑 ${signal}: shutting down`);
    await releaseLease(JOBS);
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
