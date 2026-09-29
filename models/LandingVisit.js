const mongoose = require("mongoose");

// Visits to the landing page and the steps towards a sign-up, counted per day
// (Europe/Berlin), source and campaign. Only counters: no IP, no cookie,
// nothing about the visitor.
const landingVisitSchema = new mongoose.Schema({
  day: { type: String, required: true },
  // utm_source, else the platform the visitor came from, "empfehlung" or "direkt"
  source: { type: String, required: true },
  // utm_campaign, "" without one
  campaign: { type: String, default: "" },
  visits: { type: Number, default: 0 },
  // The way to a sign-up, as counters too: stayed and read (15 s or scrolled
  // down), started typing an address, sent the form. Confirmed sign-ups are
  // the waitlist entries themselves.
  engaged: { type: Number, default: 0 },
  formStarted: { type: Number, default: 0 },
  submitted: { type: Number, default: 0 },
});

landingVisitSchema.index({ day: 1, source: 1, campaign: 1 }, { unique: true });

module.exports = mongoose.model("LandingVisit", landingVisitSchema);
