const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  isAvailable: { type: Boolean, default: false },

  // Regular push token (for Expo push)
  pushToken: { type: String },
  pushTokenMetadata: {
    deviceId: String,
    platform: String,
    registeredAt: Date,
    lastValidated: Date,
  },

  // VoIP push token (for iOS CallKit in background)
  voipToken: { type: String },
  voipTokenMetadata: {
    deviceId: String,
    platform: String,
    registeredAt: Date,
  },

  name: String,
  avatarUrl: String,
  lastOnline: { type: Date, default: null },
  momentActiveUntil: { type: Date, default: null },
  mood: { type: String, default: null },
  lastMomentInvite: { type: Date },
});

module.exports = mongoose.model("User", userSchema);
