require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");
const { createApp } = require("./app");
const { initializeVoipPush } = require("./lib/push");
const { agoraCredentials } = require("./lib/agora");
const { expireMoments } = require("./routes/moment");

const PORT = process.env.PORT || 3000;

/** One-off data fixes that are safe to run on every start. */
async function migrate() {
  const missingHash = await User.find({ phoneHash: { $exists: false } }, "phone");
  for (const user of missingHash) {
    await User.updateOne({ _id: user._id }, { phoneHash: User.hashPhone(user.phone) });
  }
  if (missingHash.length) console.log(`🔧 Added phoneHash to ${missingHash.length} users`);
}

async function main() {
  initializeVoipPush();

  if (!process.env.JWT_SECRET) {
    console.warn("⚠️ JWT_SECRET not set: no auth tokens are issued (legacy mode)");
  }
  if (agoraCredentials().usingLegacyCertificate) {
    console.warn("⚠️ AGORA_APP_CERTIFICATE not set: using the leaked legacy certificate");
  }

  const { server, io, calls } = createApp();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ MongoDB verbunden");
  await migrate();
  const stale = await calls.sweepStaleCalls();
  if (stale) console.log(`🔧 Marked ${stale} stale ringing calls as missed`);

  // End expired Call Me Moments every minute
  setInterval(() => {
    expireMoments(io).catch((err) => console.error("❌ expireMoments:", err.message));
  }, 60 * 1000);

  server.listen(PORT, () => console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`));
}

main().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
