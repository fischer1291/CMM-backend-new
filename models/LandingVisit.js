const mongoose = require("mongoose");

// Visits to the landing page, counted per day (Europe/Berlin), source and
// campaign. Only counters: no IP, no cookie, nothing about the visitor.
const landingVisitSchema = new mongoose.Schema({
  day: { type: String, required: true },
  // utm_source, else the platform the visitor came from, "empfehlung" or "direkt"
  source: { type: String, required: true },
  // utm_campaign, "" without one
  campaign: { type: String, default: "" },
  visits: { type: Number, default: 0 },
});

landingVisitSchema.index({ day: 1, source: 1, campaign: 1 }, { unique: true });

module.exports = mongoose.model("LandingVisit", landingVisitSchema);
