const mongoose = require("mongoose");

// One paid call of the marketing agent (Claude, Veo, image model), or paid
// reach ("media", plan 2.7: only once the launch checklist is complete):
// reserved before the call against the daily and weekly budget, settled with
// the real cost afterwards, or released when nothing was spent. See
// lib/marketingBudget.js.
const marketingSpendSchema = new mongoose.Schema({
  // Europe/Berlin calendar day and the Monday of its week
  day: { type: String, required: true },
  week: { type: String, required: true },
  provider: { type: String, enum: ["anthropic", "google", "media"], required: true },
  // plan, review, reference-image, video-clip …
  purpose: { type: String, required: true },
  campaign: { type: String, default: null },
  note: { type: String, default: null },
  estimateEur: { type: Number, required: true },
  costEur: { type: Number, default: null },
  // reserved: counts with its estimate (also if the agent died mid-call)
  status: { type: String, enum: ["reserved", "settled", "released"], default: "reserved" },
  createdAt: { type: Date, default: Date.now },
  settledAt: { type: Date, default: null },
});

marketingSpendSchema.index({ createdAt: -1 });
marketingSpendSchema.index({ week: 1, status: 1 });

module.exports = mongoose.model("MarketingSpend", marketingSpendSchema);
