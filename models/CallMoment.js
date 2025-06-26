const mongoose = require("mongoose");

const CallMomentSchema = new mongoose.Schema({
  userPhone: {
    type: String,
    required: true,
  },
  userName: {
    type: String,
    required: true,
  },
  targetPhone: {
    type: String,
    required: true,
  },
  targetName: {
    type: String,
    required: true,
  },
  screenshot: {
    type: String,
    required: true,
  },
  note: {
    type: String,
    default: "",
  },
  mood: {
    type: String,
    required: true,
  },
  callDuration: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  isPrivate: {
    type: Boolean,
    default: false,
  },
});

module.exports = mongoose.model("CallMoment", CallMomentSchema);
