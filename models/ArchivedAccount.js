const mongoose = require("mongoose");

// An account set aside before a recycled number got a fresh one (plan 2.9):
// when the new holder of the number answers "Nicht mein Konto" at sign-in
// (POST /verify/account-check), the old account's export (lib/account.js
// exportAccount) is kept here for 30 days and the account is deleted. Only
// for support, when someone chose that answer by mistake and wants the old
// account back; nothing reads it automatically. Images (avatar, moments)
// and the RevenueCat subscriber are gone with the deletion: support
// rebuilds the data, a store subscription returns through "Käufe
// wiederherstellen", other Plus sources by hand. The TTL on archivedAt
// removes it, never deleteAccount of the new holder (it is someone else's
// data). phoneHmac is User.hmacPhone of the number, for finding it.
const archivedAccountSchema = new mongoose.Schema({
  phoneHmac: { type: String, required: true, index: true },
  export: { type: mongoose.Schema.Types.Mixed, default: null },
  archivedAt: { type: Date, default: Date.now },
});

archivedAccountSchema.index({ archivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("ArchivedAccount", archivedAccountSchema);
