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
  // false: audio only
  video: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  // Ringing deadline (createdAt + RING_TIMEOUT_MS). The process timer ends the
  // ring in time; the leader's sweep (lib/calls.js sweepStaleCalls) reads this
  // after a deploy or crash, so no call rings forever. null: from before 2.2.
  ringUntil: { type: Date, default: null },
  acceptedAt: { type: Date },
  endedAt: { type: Date },
});

callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });
// The sweep (ringing past the deadline) and the startup replay of talks
// (ended since the last recorded talk)
callSchema.index({ status: 1, ringUntil: 1 });
callSchema.index({ status: 1, endedAt: 1 });

// Keep call records for 30 days
callSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("Call", callSchema);
