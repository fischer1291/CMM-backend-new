const mongoose = require("mongoose");

/**
 * A shared circle ("Familie Fischer", "Crew"): members joined on purpose,
 * via an invite or the circle's code. Invites to people without the app
 * carry only the hash of their number until they sign up.
 */
const circleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  emoji: { type: String, default: "💛" },
  createdBy: { type: String, required: true },
  members: {
    type: [{ _id: false, phone: String, joinedAt: { type: Date, default: Date.now } }],
    default: [],
  },
  invites: {
    type: [
      {
        _id: false,
        phone: { type: String, default: null },
        hash: { type: String, default: null },
        invitedBy: String,
        at: { type: Date, default: Date.now },
        // draft: taken over from an old private list, not sent yet
        status: { type: String, enum: ["draft", "pending"], default: "pending" },
      },
    ],
    default: [],
  },
  // For invite links: /kreis?code=...
  code: { type: String, required: true, unique: true },
  // Recurring get-together, e.g. Sundays 18:00: opens a room for everyone
  ritual: {
    enabled: { type: Boolean, default: false },
    day: { type: Number, default: 0 },
    start: { type: Number, default: 18 * 60 },
    timezone: { type: String, default: null },
    lastKey: { type: String, default: null },
    label: { type: String, default: null },
  },
  // Further rituals (Wanna yap+: up to 3 in total, lib/plan.js). Kept apart
  // from `ritual` so older app versions still see and edit the first one.
  moreRituals: {
    type: [
      {
        label: { type: String, default: null },
        enabled: { type: Boolean, default: true },
        day: { type: Number, required: true },
        start: { type: Number, required: true },
        timezone: { type: String, default: null },
        lastKey: { type: String, default: null },
      },
    ],
    default: [],
  },
  // Weeks (Monday "YYYY-MM-DD") in which everyone talked: circle badges
  goalWeeks: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

circleSchema.index({ "members.phone": 1 });
circleSchema.index({ "invites.phone": 1 });
circleSchema.index({ "invites.hash": 1 });

module.exports = mongoose.model("Circle", circleSchema);
