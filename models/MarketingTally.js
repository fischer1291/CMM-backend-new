const mongoose = require("mongoose");

// Running totals per budget period in euro cents: _id "day:YYYY-MM-DD" or
// "week:YYYY-MM-DD" (the Monday). Reservations raise them with a conditional
// $inc, so a limit holds even if two reservations race. The caps live in
// _id "caps". _id "runs" keeps how the agent's runs went (plan 2.14,
// POST /marketing/notify): when it last reported, last succeeded, last
// failed and in which step, with the GitHub run link and its duration, and
// when the post numbers were last read (lastStatsAt).
const marketingTallySchema = new mongoose.Schema({
  _id: { type: String, required: true },
  cents: { type: Number, default: 0 },
  // Only on "caps"
  dailyCents: { type: Number, default: null },
  weeklyCents: { type: Number, default: null },
  updatedBy: { type: String, default: null },
  // Only on "runs"
  lastRunAt: { type: Date, default: null },
  lastOkAt: { type: Date, default: null },
  lastFailedAt: { type: Date, default: null },
  lastStep: { type: String, default: null },
  lastRunUrl: { type: String, default: null },
  lastDurationSec: { type: Number, default: null },
  // When the post numbers were last read (lib/socialPosting.js statsDue)
  lastStatsAt: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MarketingTally", marketingTallySchema);
