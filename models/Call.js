const mongoose = require("mongoose");

// One document per call request. Used to authorize Agora tokens (only the two
// participants may join the channel) and, later, for call state and history.
const callSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  channel: { type: String, required: true, unique: true },
  caller: { type: String, required: true },
  callee: { type: String, required: true },
  // ringing -> accepted -> ended
  // ringing -> declined (callee) | cancelled (caller) | missed (timeout)
  // busy: callee was already in a call, never rang
  status: {
    type: String,
    enum: ["ringing", "accepted", "ended", "declined", "cancelled", "missed", "busy"],
    default: "ringing",
  },
  createdAt: { type: Date, default: Date.now },
  acceptedAt: { type: Date },
  endedAt: { type: Date },
});

callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });

// Keep call records for 30 days
callSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("Call", callSchema);
