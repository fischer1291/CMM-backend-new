const mongoose = require("mongoose");

// A WebAuthn challenge (lib/adminPasskeys.js): usable once, for 5 minutes.
const adminChallengeSchema = new mongoose.Schema({
  _id: { type: String }, // the challenge, base64url
  purpose: { type: String, enum: ["register", "login"], required: true },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  createdAt: { type: Date, default: Date.now, expires: 300 },
});

module.exports = mongoose.model("AdminChallenge", adminChallengeSchema);
