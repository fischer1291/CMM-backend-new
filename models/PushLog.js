const mongoose = require("mongoose");

// Sent social pushes, for throttling ("Anna is available" at most every few
// hours per recipient) and a daily cap. Each entry expires at `expiresAt`.
const pushLogSchema = new mongoose.Schema({
  to: { type: String, required: true },
  key: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

pushLogSchema.index({ to: 1, key: 1 }, { unique: true });
pushLogSchema.index({ to: 1, sentAt: -1 });
pushLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PushLog", pushLogSchema);
