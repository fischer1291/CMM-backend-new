const mongoose = require("mongoose");

// Running totals per budget period in euro cents: _id "day:YYYY-MM-DD" or
// "week:YYYY-MM-DD" (the Monday). Reservations raise them with a conditional
// $inc, so a limit holds even if two reservations race. The caps live in
// _id "caps".
const marketingTallySchema = new mongoose.Schema({
  _id: { type: String, required: true },
  cents: { type: Number, default: 0 },
  // Only on "caps"
  dailyCents: { type: Number, default: null },
  weeklyCents: { type: Number, default: null },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MarketingTally", marketingTallySchema);
