const mongoose = require("mongoose");

// Days on which a user used the app (any authenticated request or socket
// connection), for active-user counts and retention. Only a keyed hash of
// the number is stored (User.hmacPhone, plan 2.8; rows from before were
// SHA-256 and were re-keyed once by index.js migrate()). Kept 400 days;
// deleteAccount removes the rows of the account (lib/account.js). The index
// on `who` alone serves the per-person queries: re-keying, deletion, export.
const activeDaySchema = new mongoose.Schema({
  day: { type: String, required: true }, // "YYYY-MM-DD", Europe/Berlin
  who: { type: String, required: true }, // User.hmacPhone of the phone number
  at: { type: Date, default: Date.now },
});

activeDaySchema.index({ day: 1, who: 1 }, { unique: true });
activeDaySchema.index({ who: 1 });
activeDaySchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.model("ActiveDay", activeDaySchema);
