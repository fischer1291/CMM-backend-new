const mongoose = require("mongoose");

// Re-match (plan 2.13, lib/rematch.js): with the owner's opt-in
// (User.rematch.optIn), the address book entries of a contact sync that are
// not users yet, so the owner hears when one of them joins. One document per
// owner, replaced by every sync. Never the SHA-256 the app sends: each entry
// is HMAC-SHA256(pepper, that SHA-256 hex) (User.hmacPhone over the hash), so
// the stored list cannot be reversed over the number space without the
// server's pepper. At most 5,000 entries (the contact sync's own limit).
// Goes with the opt-out, the account deletion (lib/account.js) and 90 days
// after the last sync (TTL on expiresAt). COMPLIANCE.md.
const addressBookHashSchema = new mongoose.Schema({
  owner: { type: String, required: true }, // E.164 of the person who synced
  hashes: { type: [String], default: [] },
  updatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

addressBookHashSchema.index({ owner: 1 }, { unique: true });
// Multikey: who has the new user's number (lib/rematch.js notifyJoined)
addressBookHashSchema.index({ hashes: 1 });
addressBookHashSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AddressBookHash", addressBookHashSchema);
