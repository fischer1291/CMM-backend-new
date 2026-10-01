const mongoose = require("mongoose");

// One snapshot of the key numbers per day (Europe/Berlin), written by
// lib/metrics.js. Raw data expires (calls after 30 days, push decisions after
// 3), the snapshots stay.
const metricsDailySchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true },
    // Still running: refreshed until the day is over
    partial: { type: Boolean, default: false },
    users: {
      total: Number,
      new: Number,
      dau: Number,
      wau: Number,
      mau: Number,
      // Rolling activation (lib/metrics.js activation4w): share in percent of
      // the sign-ups of the last four full weeks who talked within 7 days,
      // and how many of them were measured (window over). Under 100 the
      // console says "zu wenig Daten" instead of judging the number.
      activation4w: Number,
      activationSample: Number,
      // Address book density of people who signed up 7 to 35 days ago
      // (lib/metrics.js density): percent with at least three registered
      // contacts, percent with none, and how many were looked at
      density: { c3plus: Number, c0: Number, sample: Number },
    },
    calls: { started: Number, answered: Number, missed: Number, declined: Number, busy: Number, cancelled: Number, audio: Number },
    talks: { count: Number, minutes: Number, people: Number },
    circles: { total: Number, new: Number, rooms: Number, ritualRooms: Number, roomMinutes: Number },
    rituals: { dailyJoined: Number, moments: Number, nudges: Number },
    growth: { invites: Number, joinedViaInvite: Number },
    push: { sent: Number, skipped: Number, failed: Number },
    reports: { new: Number, open: Number },
    // Day counters from lib/opsCounters.js, e.g. callsRejectedNotConnected, matchSuspicious, smsStarted
    ops: { type: mongoose.Schema.Types.Mixed, default: null },
    computedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("MetricsDaily", metricsDailySchema);
