const mongoose = require("mongoose");

// Visits to the personal invite link (/einladung?von=CODE), counted per day
// (Europe/Berlin), inviter code and platform of the visitor's device. Only
// counters: no IP, no cookie, nothing about the visitor. The code is the
// inviter's User.inviteCode, so the rows say nothing once that user is gone.
const inviteVisitSchema = new mongoose.Schema({
  day: { type: String, required: true },
  code: { type: String, required: true },
  // Which store the visitor would need: ios | android | other
  platform: { type: String, enum: ["ios", "android", "other"], required: true },
  visits: { type: Number, default: 0 },
  // First visit of the row, for the TTL
  at: { type: Date, default: Date.now },
});

inviteVisitSchema.index({ day: 1, code: 1, platform: 1 }, { unique: true });
inviteVisitSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.model("InviteVisit", inviteVisitSchema);
