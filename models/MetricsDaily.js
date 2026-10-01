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
      // The five most common device languages of the day's sign-ups (User.locale)
      byLocale: { type: [{ _id: false, locale: String, users: Number }], default: undefined },
    },
    calls: { started: Number, answered: Number, missed: Number, declined: Number, busy: Number, cancelled: Number, audio: Number },
    talks: { count: Number, minutes: Number, people: Number },
    circles: { total: Number, new: Number, rooms: Number, ritualRooms: Number, roomMinutes: Number },
    rituals: { dailyJoined: Number, moments: Number, nudges: Number },
    // inviteVisits: the personal invite link opened (InviteVisit), by platform
    growth: { invites: Number, joinedViaInvite: Number, inviteVisits: { total: Number, ios: Number, android: Number, other: Number } },
    // Waitlist confirmations of the day by the platform they told us (WaitlistEntry.platform)
    waitlist: { byPlatform: { ios: Number, android: Number, unknown: Number } },
    push: { sent: Number, skipped: Number, failed: Number },
    reports: { new: Number, open: Number },
    // Day counters from lib/opsCounters.js, e.g. callsRejectedNotConnected, matchSuspicious, smsStarted
    ops: { type: mongoose.Schema.Types.Mixed, default: null },
    computedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("MetricsDaily", metricsDailySchema);
