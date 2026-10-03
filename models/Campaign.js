const mongoose = require("mongoose");

// A marketing campaign the owner registered in the console (plan 2.10,
// routes/adminCampaigns.js): the slug is the one name its links carry
// (/k/<slug> to the App Store as Apple's "ct", utm_campaign=<slug> on the
// landing page), so the console can put visits, waitlist sign-ups, new
// users who answered the acquisition question and marketing spend next to
// it. No user data: createdBy is the admin's e-mail.
const SLUG = /^[a-z0-9-]{2,40}$/;
const CHANNELS = ["tiktok", "instagram", "flyer", "campus", "creator", "press", "other"];
const STATUSES = ["planned", "running", "ended"];

const campaignSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, match: SLUG },
    channel: { type: String, enum: CHANNELS, required: true },
    title: { type: String, default: "", maxlength: 80 },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    // What the campaign may cost in total (media, print, creator fee), whole
    // euro cents; null when no budget was set. The AI spend of the
    // marketing agent comes from MarketingSpend on top.
    budgetEurCents: { type: Number, default: null, min: 0 },
    // Creator, print shop, university group … (a name, not a contact)
    partner: { type: String, default: "", maxlength: 80 },
    status: { type: String, enum: STATUSES, default: "planned" },
    notes: { type: String, default: "", maxlength: 1000 },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Campaign", campaignSchema);
module.exports.SLUG = SLUG;
module.exports.CHANNELS = CHANNELS;
module.exports.STATUSES = STATUSES;
