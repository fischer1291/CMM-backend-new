require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");
const Call = require("./models/Call");
const Talk = require("./models/Talk");
const Admin = require("./models/Admin");
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
const { runRules } = require("./lib/alerts");
const { tickMomentsWaiting } = require("./lib/unlock");
const { asLeader, releaseLease, INSTANCE } = require("./lib/leader");
const { migratePrivateCircles, tickRituals, endStaleRooms } = require("./lib/circles");
const { backfillPhoneHmac, rekeyActiveDays } = require("./lib/pseudonyms");

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

  // Keyed pseudonyms (plan 2.8, lib/pseudonyms.js): phoneHmac for every
  // account, then ActiveDay re-keyed from SHA-256 to the HMAC, once. Both
  // query ActiveDay by `who`; the index must exist before they run (this
  // happens before server.listen, so a collection scan would hold /healthz)
  await require("./models/ActiveDay").createIndexes();
  const { added: addedHmac, rekeyed: rekeyedUsers } = await backfillPhoneHmac();
  if (addedHmac) console.log(`🔧 Added phoneHmac to ${addedHmac} users`);
  if (rekeyedUsers) console.log(`🔧 Re-keyed phoneHmac and the ActiveDay rows of ${rekeyedUsers} users`);
  const rekeyed = await rekeyActiveDays();
  if (rekeyed !== null) console.log(`🔧 Re-keyed ${rekeyed} ActiveDay row(s) to phoneHmac`);

  // Private circle lists became shared circles (lib/circles.js)
  const migrated = await migratePrivateCircles();
  if (migrated) console.log(`🔧 Moved private circles of ${migrated} users to shared circles`);

  // Nudges: the unique (from, to) index and the 20 h TTL were replaced by a
  // history with cooldowns; syncIndexes drops/recreates what changed
  await require("./models/Nudge").syncIndexes();

  // The daily numbers became a morning push (plan 1.12): admins still on the
  // old default hour 20 move to 8, once; the marker keeps a later, deliberate
  // 20 alone
  const AppConfig = require("./models/AppConfig");
  const applied = await AppConfig.findOne({ key: "app" }, { migrations: 1 }).lean();
  if (!applied?.migrations?.morningPush) {
    const moved = await Admin.updateMany({ "notify.dailyHour": 20 }, { "notify.dailyHour": 8 });
    // An older document may carry migrations: null (the schema default); the
    // dotted $set needs an object there. setDefaultsOnInsert: false keeps a
    // fresh database free of null subtrees (ops, goals, limits)
    await AppConfig.updateOne({ key: "app", migrations: null }, { $set: { migrations: {} } });
    await AppConfig.updateOne({ key: "app" }, { $set: { "migrations.morningPush": new Date() } }, { upsert: true, setDefaultsOnInsert: false });
    if (moved.modifiedCount) console.log(`🔧 Moved the daily push of ${moved.modifiedCount} admin(s) to 8:00`);
  }

  // Admins from before plan 1.8 have no `active` flag: they are all active
  const activated = await Admin.updateMany({ active: { $exists: false } }, { active: true });
  if (activated.modifiedCount) console.log(`🔧 Marked ${activated.modifiedCount} admin(s) as active`);
}

async function main() {
  initializeVoipPush();

  if (!process.env.JWT_SECRET) {
    console.warn("⚠️ JWT_SECRET not set: no auth tokens are issued (legacy mode)");
  }
  if (!User.phonePepperConfigured()) {
    console.warn("⚠️ PHONE_HASH_PEPPER not set: phone pseudonyms are keyed from JWT_SECRET; set it once before this version is deployed and never change it (README \"Pseudonymous data\")");
  }
  if (agoraCredentials().usingLegacyCertificate) {
    console.error("❌ AGORA_APP_CERTIFICATE not set: calls will fail (no RTC tokens)");
  }
  if (process.env.AUTH_REQUIRED !== "true") {
    console.error("❌ AUTH_REQUIRED is not 'true': token-less requests may act as any phone number (legacy mode, see README)");
  }

  const { server, io, calls } = createApp();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ MongoDB verbunden");
  await migrate();
  // Rings the previous process left behind end now; the minute tick below
  // keeps doing this (lib/calls.js sweepStaleCalls)
  const stale = await calls.sweepStaleCalls();
  if (stale) console.log(`🔧 Ended ${stale} stale call(s) left by a previous process`);
  // Talk-time stats: a talk whose recordTalk the previous process didn't get
  // to is recorded now (idempotent). Only calls ended since the latest talk
  // on record, or the last 30 days on a fresh database, not the whole table
  const lastTalk = await Talk.findOne({}, { startedAt: 1 }).sort({ startedAt: -1 }).lean();
  const since = lastTalk?.startedAt || new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const answered = await Call.find({ status: "ended", endedAt: { $gt: since }, acceptedAt: { $ne: null } }).sort({ acceptedAt: 1 });
  for (const call of answered) await calls.recordTalk(call);

  // Every minute: end overdue rings, start scheduled availability, end
  // expired sessions
  const tick = async () => {
    const ended = await calls.sweepStaleCalls();
    if (ended) console.log(`🔧 Ended ${ended} stale call(s)`);
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
  // alive; every finished job stamps lastRunAt on the lock for /healthz, the
  // tick additionally tickAt for the alert tick_late (lib/alerts.js).
  let leading = false;
  const asJobLeader = async (name, fn) => {
    const result = await asLeader(JOBS, async () => {
      if (!leading) console.log(`👑 ${INSTANCE} runs the background jobs`);
      leading = true;
      return fn();
    }, { tick: name === "tick" });
    if (result === undefined && leading) {
      console.log(`👋 ${INSTANCE} lost the background jobs to another instance`);
      leading = false;
    }
    return result;
  };
  setInterval(() => {
    asJobLeader("tick", tick).catch((err) => console.error("❌ availability tick:", err.message));
  }, 60 * 1000);

  // Admin numbers: fill missing days now, then refresh every 30 minutes; the
  // alert rules (lib/alerts.js) run right after, on the fresh numbers
  const snapshots = () =>
    asJobLeader("snapshots", runSnapshots)
      .catch((err) => console.error("❌ metrics snapshots:", err.message))
      .then(() => asJobLeader("alerts", runRules))
      .then((fired) => fired?.length && console.log(`🚨 Alarme: ${fired.join(", ")}`))
      .catch((err) => console.error("❌ alerts:", err.message));
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

  // Dead-man rule: no owner acknowledged or signed in for 7 days (lib/adminPush.js);
  // checked hourly, sent at most once per 7 days
  setInterval(() => {
    asJobLeader("dead-man", () => adminPush.deadManCheck())
      .then((how) => how && console.log(`🚨 Dead-man rule: ${how === "mail" ? "emergency contact mailed" : "owners pushed"}`))
      .catch((err) => console.error("❌ dead-man check:", err.message));
  }, 60 * 60 * 1000);

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
