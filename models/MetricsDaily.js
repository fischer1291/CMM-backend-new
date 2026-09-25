const mongoose = require("mongoose");

// One snapshot of the key numbers per day (Europe/Berlin), written by
// lib/metrics.js. Raw data expires (calls after 30 days, push decisions after
// 3), the snapshots stay.
const metricsDailySchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true },
    // Still running: refreshed until the day is over
    partial: { type: Boolean, default: false },
    users: { total: Number, new: Number, dau: Number, wau: Number, mau: Number },
    calls: { started: Number, answered: Number, missed: Number, declined: Number, busy: Number, cancelled: Number, audio: Number },
    talks: { count: Number, minutes: Number, people: Number },
    circles: { total: Number, new: Number, rooms: Number, ritualRooms: Number, roomMinutes: Number },
    rituals: { dailyJoined: Number, moments: Number, nudges: Number },
    growth: { invites: Number, joinedViaInvite: Number },
    push: { sent: Number, skipped: Number, failed: Number },
    reports: { new: Number, open: Number },
    computedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("MetricsDaily", metricsDailySchema);
