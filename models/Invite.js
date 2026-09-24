const mongoose = require("mongoose");

// "I invited this person": only the SHA-256 of their number, so they can be
// connected with the inviter when they sign up. Expires after 60 days.
const inviteSchema = new mongoose.Schema({
  from: { type: String, required: true },
  toHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

inviteSchema.index({ from: 1, toHash: 1 }, { unique: true });
inviteSchema.index({ toHash: 1 });
inviteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model("Invite", inviteSchema);
