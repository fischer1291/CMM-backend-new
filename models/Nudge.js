const mongoose = require("mongoose");

// "Anna would like to talk": at most one per pair per NUDGE_TTL.
const NUDGE_TTL_SECONDS = 20 * 3600;

const nudgeSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

nudgeSchema.index({ from: 1, to: 1 }, { unique: true });
nudgeSchema.index({ to: 1, createdAt: -1 });
nudgeSchema.index({ createdAt: 1 }, { expireAfterSeconds: NUDGE_TTL_SECONDS });

module.exports = mongoose.model("Nudge", nudgeSchema);
module.exports.NUDGE_TTL_SECONDS = NUDGE_TTL_SECONDS;
