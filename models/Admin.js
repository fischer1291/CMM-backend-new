const mongoose = require("mongoose");

// People who can sign in to the admin console (/console). Separate from app
// users: e-mail, password (scrypt) and a mandatory TOTP second factor.
const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // Base32; set up during onboarding, required once `totpEnabled`
  totpSecret: { type: String, required: true },
  totpEnabled: { type: Boolean, default: false },
  // Last accepted TOTP time step: a code works only once
  totpLastStep: { type: Number, default: 0 },
  // owner: everything · support: users and reports · viewer: numbers only
  role: { type: String, enum: ["owner", "support", "viewer"], default: "owner" },
  // Bumped to sign out every session
  sessionVersion: { type: Number, default: 0 },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Admin", adminSchema);
