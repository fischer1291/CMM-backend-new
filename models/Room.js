const mongoose = require("mongoose");

// "Offene Runde": a group call of one circle that members drop into.
const roomSchema = new mongoose.Schema({
  circleId: { type: mongoose.Schema.Types.ObjectId, required: true },
  channel: { type: String, required: true, unique: true },
  // A member's phone, or "ritual" when the circle's ritual opened it
  startedBy: { type: String, required: true },
  participants: {
    type: [{ _id: false, phone: String, joinedAt: Date, leftAt: { type: Date, default: null } }],
    default: [],
  },
  active: { type: Boolean, default: true },
  // Free circles: rounds end after the plan's minutes (lib/plan.js); null: no limit
  endsAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
});

roomSchema.index({ circleId: 1, active: 1 });
roomSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("Room", roomSchema);
