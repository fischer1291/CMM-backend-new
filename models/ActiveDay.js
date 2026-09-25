const mongoose = require("mongoose");

// Days on which a user used the app (any authenticated request or socket
// connection), for active-user counts and retention. Only a hash of the
// number is stored. Kept 400 days.
const activeDaySchema = new mongoose.Schema({
  day: { type: String, required: true }, // "YYYY-MM-DD", Europe/Berlin
  who: { type: String, required: true }, // SHA-256 of the phone number
  at: { type: Date, default: Date.now },
});

activeDaySchema.index({ day: 1, who: 1 }, { unique: true });
activeDaySchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.model("ActiveDay", activeDaySchema);
