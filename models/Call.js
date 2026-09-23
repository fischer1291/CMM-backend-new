const mongoose = require("mongoose");

// One document per call request. Used to authorize Agora tokens (only the two
// participants may join the channel) and, later, for call state and history.
const callSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  channel: { type: String, required: true, unique: true },
  caller: { type: String, required: true },
  callee: { type: String, required: true },
  status: {
    type: String,
    enum: ["ringing", "accepted", "ended"],
    default: "ringing",
  },
  createdAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
});

// Keep call records for 30 days
callSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("Call", callSchema);
