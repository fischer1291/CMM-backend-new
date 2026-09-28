const mongoose = require("mongoose");

// An ad video the marketing agent (CMM repo, marketing/agent) proposed. It
// waits in the console (tab Freigabe) until a person approves or rejects it;
// in stage 1 the approved video is posted by hand.
// rendering: text is there, the video is still being uploaded
const adDraftSchema = new mongoose.Schema({
  // utm_campaign of its links, unique: the console's visit numbers per campaign belong to it
  campaign: { type: String, required: true, unique: true },
  status: { type: String, enum: ["rendering", "pending", "approved", "rejected", "posted"], default: "rendering" },
  title: { type: String, required: true },
  // Why the agent thinks this one is worth trying
  idea: { type: String, default: "" },
  template: { type: String, required: true },
  // What the template shows (texts, screen), as the agent wrote it
  content: { type: mongoose.Schema.Types.Mixed, default: {} },
  seconds: { type: Number, default: null },
  captions: {
    instagram: { type: String, default: "" },
    tiktok: { type: String, default: "" },
  },
  hashtags: { type: [String], default: [] },
  model: { type: String, default: null },
  video: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
    bytes: { type: Number, default: null },
  },
  // The person's decision; the reason goes back to the agent the next day
  decidedBy: { type: String, default: null },
  decidedAt: { type: Date, default: null },
  feedback: { type: String, default: null },
  posted: {
    instagram: { type: Date, default: null },
    tiktok: { type: Date, default: null },
  },
  createdAt: { type: Date, default: Date.now },
});

adDraftSchema.index({ status: 1, createdAt: -1 });
adDraftSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdDraft", adDraftSchema);
