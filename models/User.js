const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  isAvailable: { type: Boolean, default: false },
  pushToken: { type: String },
  name: String,
  avatarUrl: String,
  lastOnline: { type: Date, default: null },
  momentActiveUntil: { type: Date, default: null },
  mood: { type: String, default: null },
  lastMomentInvite: { type: Date },
});

module.exports = mongoose.model("User", userSchema);
