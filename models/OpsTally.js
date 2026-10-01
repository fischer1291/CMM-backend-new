const mongoose = require("mongoose");

// Operational counters of one day (lib/opsCounters.js): _id "ops:YYYY-MM-DD",
// counts raised with $inc, e.g. { callsRejectedNotConnected: 3 }.
const opsTallySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { minimize: false },
);

module.exports = mongoose.model("OpsTally", opsTallySchema);
