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
  // app: animated app screens; hero: realistic scenes made with Veo
  kind: { type: String, enum: ["app", "hero"], default: "app" },
  // Realistic AI people in it: must be marked on TikTok and Instagram
  ai: { type: Boolean, default: false },
  characters: { type: [String], default: [] },
  // Hero videos form a running story: what happened in this episode
  episode: { type: String, default: null },
  // What making it cost (Claude, Veo), in euros
  costEur: { type: Number, default: null },
  template: { type: String, required: true },
  // What the template shows (texts, screen), as the agent wrote it
  content: { type: mongoose.Schema.Types.Mixed, default: {} },
  seconds: { type: Number, default: null },
  captions: {
    instagram: { type: String, default: "" },
    tiktok: { type: String, default: "" },
  },
  hashtags: { type: [String], default: [] },
  // The music in the video (style of the agent's own music) and a sound that
  // is trending on TikTok, to add in the app when the video waits there
  music: {
    style: { type: String, default: null },
  },
  sound: {
    title: { type: String, default: null },
    artist: { type: String, default: null },
    // In TikTok's Commercial Music Library, i.e. allowed for a business account
    commercial: { type: Boolean, default: false },
    why: { type: String, default: null },
  },
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
  // Texts changed in the console before posting: who and when, and the
  // agent's original captions and hashtags (it learns from the difference)
  edited: {
    at: { type: Date, default: null },
    by: { type: String, default: null },
    captions: { instagram: String, tiktok: String },
    hashtags: { type: [String], default: undefined },
  },
  posted: {
    instagram: { type: Date, default: null },
    tiktok: { type: Date, default: null },
  },
  // Automatic posting (lib/socialPosting.js): the slot it goes out in, and per
  // platform where it stands. status: scheduled, posted, inbox (TikTok draft
  // waiting in the app), failed (retried up to 3 times)
  scheduledAt: { type: Date, default: null },
  publish: {
    instagram: {
      status: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      lastTryAt: { type: Date, default: null },
      id: { type: String, default: null },
      url: { type: String, default: null },
      error: { type: String, default: null },
    },
    tiktok: {
      status: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      lastTryAt: { type: Date, default: null },
      id: { type: String, default: null },
      url: { type: String, default: null },
      error: { type: String, default: null },
    },
  },
  createdAt: { type: Date, default: Date.now },
});

adDraftSchema.index({ status: 1, createdAt: -1 });
adDraftSchema.index({ scheduledAt: 1 });
adDraftSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdDraft", adDraftSchema);
