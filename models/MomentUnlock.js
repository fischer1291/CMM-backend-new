const mongoose = require("mongoose");

// Days on which someone unlocked their friends' moments (a real conversation
// of a minute or more, or the Yap Moment), in their own time zone. Feeds the
// unlock streak and the badges.
const momentUnlockSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  day: { type: String, required: true }, // local "YYYY-MM-DD"
  via: { type: String, enum: ["talk", "daily"], required: true },
  at: { type: Date, default: Date.now },
});

momentUnlockSchema.index({ phone: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("MomentUnlock", momentUnlockSchema);
