const mongoose = require("mongoose");

// Today's Call Me Moment for one time zone: a random time between 10:00 and
// 21:00 local, the same for everyone in that zone (lib/dailyMoment.js).
const dailyMomentSchema = new mongoose.Schema({
  day: { type: String, required: true }, // local "YYYY-MM-DD"
  zone: { type: String, required: true },
  at: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  sentAt: { type: Date, default: null },
  joined: { type: [String], default: [] },
  // Joined within the first minute ("Blitzstart" badge)
  fast: { type: [String], default: [] },
});

dailyMomentSchema.index({ day: 1, zone: 1 }, { unique: true });
dailyMomentSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model("DailyMoment", dailyMomentSchema);
