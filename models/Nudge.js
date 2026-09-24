const mongoose = require("mongoose");

// "Anna would like to talk". Kept a week so the cooldown between nudges
// can look at the history (see lib/nudges.js).
const NUDGE_HISTORY_SECONDS = 7 * 24 * 3600;

const nudgeSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  // open -> answered (they talked / recipient became available) | dismissed
  status: { type: String, enum: ["open", "answered", "dismissed"], default: "open" },
  resolvedAt: { type: Date, default: null },
});

nudgeSchema.index({ from: 1, to: 1, createdAt: -1 });
nudgeSchema.index({ to: 1, status: 1, createdAt: -1 });
nudgeSchema.index({ createdAt: 1 }, { expireAfterSeconds: NUDGE_HISTORY_SECONDS });

module.exports = mongoose.model("Nudge", nudgeSchema);
