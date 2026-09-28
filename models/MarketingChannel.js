const mongoose = require("mongoose");

// A connected social account the backend posts to: _id "instagram" or
// "tiktok". Tokens are stored encrypted (lib/socialPosting.js) and never
// leave the backend; the console only sees the status.
const marketingChannelSchema = new mongoose.Schema({
  _id: { type: String, enum: ["instagram", "tiktok"] },
  // AES-256-GCM, key derived from JWT_SECRET
  accessToken: { type: String, default: null },
  refreshToken: { type: String, default: null },
  expiresAt: { type: Date, default: null },
  refreshExpiresAt: { type: Date, default: null },
  // Instagram: the IG user id; TikTok: the open_id
  accountId: { type: String, default: null },
  username: { type: String, default: null },
  // TikTok: "inbox" (draft in the TikTok app, works before the audit) or "direct"
  mode: { type: String, default: null },
  privacyLevel: { type: String, default: null },
  connectedBy: { type: String, default: null },
  connectedAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MarketingChannel", marketingChannelSchema);
