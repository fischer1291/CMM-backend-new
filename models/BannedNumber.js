const mongoose = require("mongoose");

// Numbers banned by moderation: they can't sign up again. Only the hash.
const bannedNumberSchema = new mongoose.Schema({
  hash: { type: String, required: true, unique: true },
  reason: { type: String, default: "" },
  by: { type: String, required: true }, // admin e-mail
  at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("BannedNumber", bannedNumberSchema);
