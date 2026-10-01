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
const { tickMomentsWaiting } = require("./lib/unlock");
const { asLeader, releaseLease, INSTANCE } = require("./lib/leader");
const { migratePrivateCircles, tickRituals, endStaleRooms } = require("./lib/circles");

const PORT = process.env.PORT || 3000;
// Background jobs run on one instance only (lib/leader.js)
const JOBS = "jobs";

// A rejected promise nobody awaits or an exception outside a request leaves
// the process in an unknown state: log it, hand the jobs over and exit; Render
// restarts the service and the uptime monitor sees /healthz fail meanwhile.
const crash = (kind) => (err) => {
  console.error(`💥 ${kind}:`, err);
  const exit = () => process.exit(1);
  setTimeout(exit, 1000);
  releaseLease(JOBS).then(exit, exit);
};
process.on("unhandledRejection", crash("unhandledRejection"));
process.on("uncaughtException", crash("uncaughtException"));

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
    // Everyone in a round that ended by time (free plan) or crash hears it
    for (const room of await endStaleRooms()) {
      const circle = await require("./models/Circle").findById(room.circleId, { members: 1 }).lean();
      const byTime = room.endsAt && room.endsAt <= new Date();
      if (circle) {
        io.to(circle.members.map((m) => `user:${m.phone}`)).emit("roomUpdated", {
          circleId: String(room.circleId),
          roomId: String(room._id),
          ended: true,
          reason: byTime ? "time_limit" : "stale",
        });
      }
    }
    await tickMomentsWaiting();
  };
  // The minute tick also renews the lease, so the leader keeps it while it's
  // alive; every finished job stamps lastRunAt on the lock for /healthz.
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

  // Launch mail to the waitlist, once started in the console: a batch every 15 s
  const { runLaunchBatch } = require("./lib/waitlist");
  setInterval(() => {
    asJobLeader("waitlist", runLaunchBatch)
      .then((result) => {
        if (result?.sent || result?.failed) console.log(`✉️  Launch mail: ${result.sent} sent, ${result.failed} failed`);
        if (result?.done) console.log("✉️  Launch mail: all sent");
        if (result?.purged !== undefined) console.log(`🗑️  Waitlist deleted 12 months after launch (${result.purged} entries)`);
      })
      .catch((err) => console.error("❌ launch mail:", err.message));
  }, 15 * 1000);

  // Approved ad videos: post what is due every 5 minutes; keep the Instagram and
  // TikTok tokens alive every hour (lib/socialPosting.js)
  const posting = require("./lib/socialPosting");
  setInterval(() => {
    asJobLeader("posting", () => posting.runDue())
      .then((results) => {
        for (const r of results || []) console.log(`📣 ${r.platform} ${r.campaign}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
      })
      .catch((err) => console.error("❌ posting:", err.message));
  }, 5 * 60 * 1000);
  setInterval(() => {
    asJobLeader("tokens", () => posting.refreshTokens())
      .then((done) => done?.length && console.log(`🔑 Tokens erneuert: ${done.join(", ")}`))
      .catch((err) => console.error("❌ token refresh:", err.message));
  }, 60 * 60 * 1000);

  // Confirmation mails that failed (mail provider down): send them now
  setInterval(() => {
    asJobLeader("waitlist-resend", () => require("./lib/waitlist").resendMissing())
      .then((r) => r?.sent && console.log(`✉️  ${r.sent} Bestätigungsmail(s) nachgeschickt`))
      .catch((err) => console.error("❌ waitlist resend:", err.message));
  }, 10 * 60 * 1000);

  // The day's numbers as a push to the console, at each admin's hour (lib/adminPush.js)
  const adminPush = require("./lib/adminPush");
  setInterval(() => {
    asJobLeader("admin-daily", () => adminPush.dailyDue())
      .then((sent) => sent && console.log(`📊 Tageszahlen an ${sent} Admin(s)`))
      .catch((err) => console.error("❌ admin daily push:", err.message));
  }, 5 * 60 * 1000);

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
