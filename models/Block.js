const mongoose = require("mongoose");

// `blocker` blocked `blocked`: they no longer see each other, can't call,
// nudge or react to each other (lib/relations.js).
const blockSchema = new mongoose.Schema({
  blocker: { type: String, required: true },
  blocked: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });

module.exports = mongoose.model("Block", blockSchema);
