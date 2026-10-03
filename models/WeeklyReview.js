const mongoose = require("mongoose");

// The Monday review of the weekly report (plan 2.11, lib/weeklyReport.js):
// one document per ISO week ("2026-W40") and admin who acknowledged it in
// the console (POST /admin/weekly/ack), with the hours spent on operations
// that week (alerts, support, approvals; 0–80, one decimal) and up to three
// decisions (also written by hand into CMM/docs/DECISIONS.md). Owners'
// acknowledgements feed the dead-man rule weekly_silent (lib/adminPush.js);
// the next report shows the hours. Admin data only, no app users.
const weeklyReviewSchema = new mongoose.Schema({
  week: { type: String, required: true },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  email: { type: String, default: null },
  hours: {
    alerts: { type: Number, required: true },
    support: { type: Number, required: true },
    approvals: { type: Number, required: true },
  },
  decisions: { type: [String], default: [] },
  ackAt: { type: Date, required: true },
});

weeklyReviewSchema.index({ week: 1, admin: 1 }, { unique: true });
weeklyReviewSchema.index({ ackAt: -1 });

module.exports = mongoose.model("WeeklyReview", weeklyReviewSchema);
