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

const PORT = process.env.PORT || 3000;

/** One-off data fixes that are safe to run on every start. */
async function migrate() {
  const missingHash = await User.find({ phoneHash: { $exists: false } }, "phone");
  for (const user of missingHash) {
    await User.updateOne({ _id: user._id }, { phoneHash: User.hashPhone(user.phone) });
  }
  if (missingHash.length) console.log(`🔧 Added phoneHash to ${missingHash.length} users`);

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
  };
  setInterval(() => {
    tick().catch((err) => console.error("❌ availability tick:", err.message));
  }, 60 * 1000);

  // Every 15 minutes: delivery receipts of sent pushes
  setInterval(() => {
    checkReceipts()
      .then(({ errors, removedTokens }) => {
        if (errors) console.log(`📬 Push receipts: ${errors} errors, ${removedTokens} tokens removed`);
      })
      .catch((err) => console.error("❌ checkReceipts:", err.message));
  }, 15 * 60 * 1000);

  server.listen(PORT, () => console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`));
}

main().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
