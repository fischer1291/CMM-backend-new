const mongoose = require("mongoose");

// A user reported another user or a moment. Reviewed via the admin API;
// a moment reported by several people is hidden right away.
const reportSchema = new mongoose.Schema({
  reporter: { type: String, required: true },
  reported: { type: String, required: true },
  momentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  reason: { type: String, enum: ["spam", "harassment", "inappropriate", "other"], required: true },
  note: { type: String, default: "" },
  status: { type: String, enum: ["open", "resolved"], default: "open" },
  createdAt: { type: Date, default: Date.now },
});

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ momentId: 1 });
// Kept half a year
reportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model("Report", reportSchema);
