const mongoose = require("mongoose");

// Operational counters of one day (lib/opsCounters.js): _id "ops:YYYY-MM-DD",
// counts raised with $inc, e.g. { callsRejectedNotConnected: 3 }. The hour
// rows of the few outage counters ("opsh:YYYY-MM-DDTHH", plan 2.15) carry
// expiresAt and go after two days; day rows have none and stay.
const opsTallySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date },
  },
  { minimize: false },
);

opsTallySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OpsTally", opsTallySchema);
