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
  // Deactivated by an owner (plan 1.8): no sign-in, no pushes, no alert mails;
  // the record stays for the audit trail and can be invited again
  active: { type: Boolean, default: true },
  // Invitation (POST /admin/admins) or TOTP reset (scripts/reset-admin-totp.js):
  // the SHA-256 of a one-time setup token, valid until inviteExpiresAt. The
  // setup routes accept the token instead of ADMIN_API_KEY; confirming clears it
  inviteTokenHash: { type: String, default: null },
  inviteExpiresAt: { type: Date, default: null },
  invitedBy: { type: String, default: null },
  // When they last confirmed the daily push (POST /admin/daily/ack). No owner
  // acknowledging or signing in for 7 days wakes the dead-man rule (lib/adminPush.js)
  lastAckAt: { type: Date, default: null },
  // Bumped to sign out every session
  sessionVersion: { type: Number, default: 0 },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  // Push to the console on their phone (lib/adminPush.js): what they want to hear
  // about, and the hour (Europe/Berlin) of the daily numbers. A morning push
  // since plan 1.12: yesterday's numbers and whether the north star is green
  notify: {
    approvals: { type: Boolean, default: true },
    posting: { type: Boolean, default: true },
    support: { type: Boolean, default: true },
    reports: { type: Boolean, default: true },
    daily: { type: Boolean, default: true },
    alerts: { type: Boolean, default: true },
    // The weekly report, Monday 08:00 (plan 2.11, lib/weeklyReport.js)
    weekly: { type: Boolean, default: true },
    dailyHour: { type: Number, default: 8, min: 0, max: 23 },
  },
  // Passkeys (Face ID / Touch ID) for signing in without password and code
  // (lib/adminPasskeys.js). Each one is a key pair on a device; only the
  // public key is here.
  passkeys: [
    {
      credentialId: { type: String, required: true },
      publicKey: { type: String, required: true }, // COSE, base64url
      counter: { type: Number, default: 0 },
      transports: { type: [String], default: [] },
      name: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date, default: null },
    },
  ],
  // Day (Europe/Berlin) of the last daily numbers push
  dailyPushFor: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

adminSchema.index({ "passkeys.credentialId": 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Admin", adminSchema);
