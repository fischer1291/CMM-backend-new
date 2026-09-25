const mongoose = require("mongoose");

// One answered-and-ended call, kept for personal talk-time stats. Separate
// from Call (30 days) so stats cover a year without keeping missed calls.
const talkSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  participants: { type: [String], required: true },
  startedAt: { type: Date, required: true },
  seconds: { type: Number, required: true },
  // Group call (room): one record per participant, counted for its owner
  group: { type: Boolean, default: false },
  owner: { type: String, default: null },
  circleId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

talkSchema.index({ participants: 1, startedAt: -1 });
talkSchema.index({ owner: 1, startedAt: -1 });
talkSchema.index({ startedAt: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.model("Talk", talkSchema);
