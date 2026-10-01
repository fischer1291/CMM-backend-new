const mongoose = require("mongoose");

// One document per alert tag (lib/alerts.js): when it last went out, with
// what text and how often in all. The debounce lives here, not in memory,
// so a new leader after a deploy doesn't send the same alarm again.
const alertStateSchema = new mongoose.Schema({
  tag: { type: String, required: true, unique: true },
  level: { type: String, enum: ["warn", "error"], default: "warn" },
  lastAt: { type: Date, required: true },
  lastText: { type: String, default: "" },
  count: { type: Number, default: 0 },
});

module.exports = mongoose.model("AlertState", alertStateSchema);
