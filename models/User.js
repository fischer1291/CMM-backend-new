const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  isAvailable: { type: Boolean, default: false },
  pushToken: { type: String }, // ✅ NEU
});

module.exports = mongoose.model("User", userSchema);
