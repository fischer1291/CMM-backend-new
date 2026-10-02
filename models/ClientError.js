const mongoose = require("mongoose");

// A JavaScript error in the app, grouped by message and top of the stack.
// No user reference: only how often, since when, on which versions and
// with which JavaScript (`updates`: the EAS update ids or "embedded" for the
// bundle shipped with the build, so an OTA can be judged on its own,
// CMM docs/RELEASE.md). Gone 30 days after it was last seen.
const clientErrorSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  message: { type: String, required: true },
  stack: { type: String, default: "" },
  fatal: { type: Boolean, default: false },
  platform: { type: String, default: null },
  versions: { type: [String], default: [] },
  updates: { type: [String], default: [] },
  count: { type: Number, default: 0 },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
});

clientErrorSchema.index({ lastAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("ClientError", clientErrorSchema);
