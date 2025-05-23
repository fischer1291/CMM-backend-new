const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  isAvailable: { type: Boolean, default: true },
});

module.exports = mongoose.model("User", UserSchema);
