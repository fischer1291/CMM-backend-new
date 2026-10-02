const mongoose = require("mongoose");

// Someone who wants to hear when Wanna yap? starts (landing page).
// pending: signed up, not yet confirmed (double opt-in); gone after 7 days.
// Unsubscribing deletes the entry.
const waitlistEntrySchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  status: { type: String, enum: ["pending", "confirmed"], default: "pending" },
  // Public: referral link (?ref=) and the code to redeem in the app
  code: { type: String, required: true, unique: true },
  // Secret: confirm and unsubscribe links
  token: { type: String, required: true, unique: true },
  referredBy: { type: String, default: null },
  // Where they came from (utm_source / utm_campaign of the landing page)
  source: { type: String, default: null },
  campaign: { type: String, default: null },
  // Which phone they have, from the form or the browser's user agent (an
  // Android visitor of an invite link joins here instead of the store)
  platform: { type: String, enum: ["ios", "android"], default: null },
  // Proof of consent (double opt-in): when, from where, which wording
  consent: {
    at: { type: Date, default: null },
    ip: { type: String, default: null },
    text: { type: String, default: null },
    confirmedIp: { type: String, default: null },
  },
  createdAt: { type: Date, default: Date.now },
  confirmedAt: { type: Date, default: null },
  confirmMailAt: { type: Date, default: null },
  launchMailAt: { type: Date, default: null },
  // Redeemed in the app: by whom (User.hashPhone of the number; "deleted"
  // once that account is gone, lib/account.js, so the code stays used
  // without naming anyone), when
  claimedBy: { type: String, default: null },
  claimedAt: { type: Date, default: null },
});

waitlistEntrySchema.index({ referredBy: 1, status: 1 });
waitlistEntrySchema.index({ status: 1, confirmedAt: 1 });
waitlistEntrySchema.index({ status: 1, launchMailAt: 1 });
// Unconfirmed sign-ups disappear after 7 days
waitlistEntrySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: "pending" } });

module.exports = mongoose.model("WaitlistEntry", waitlistEntrySchema);
