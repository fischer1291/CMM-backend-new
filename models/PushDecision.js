const mongoose = require("mongoose");

// What happened to each catalog push (sent or why it was skipped), so the
// user can see it in the app and problems are traceable. Kept 3 days.
const pushDecisionSchema = new mongoose.Schema({
  to: { type: String, required: true },
  type: { type: String, required: true },
  about: { type: String },
  result: { type: String, required: true }, // "sent" or a skip reason
  // State of the recipient's app when deciding: foreground | background | closed
  app: { type: String },
  // Filled from the Expo receipt: "delivered" or the error code
  ticketId: { type: String, index: true, sparse: true },
  delivery: { type: String },
  at: { type: Date, default: Date.now },
});

pushDecisionSchema.index({ to: 1, at: -1 });
pushDecisionSchema.index({ at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });

module.exports = mongoose.model("PushDecision", pushDecisionSchema);
