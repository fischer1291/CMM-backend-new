const mongoose = require("mongoose");

// One document (key "app"): what every app start reads from /app-config.
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "app", unique: true },
    // Older versions see a blocking "Bitte aktualisieren" screen
    minVersion: { type: String, default: null }, // e.g. "1.0.0"
    minBuild: { type: Number, default: null }, // e.g. 21
    updateUrl: { type: String, default: null }, // App Store / TestFlight link
    // A notice at the top of the app
    banner: {
      enabled: { type: Boolean, default: false },
      text: { type: String, default: "" },
      level: { type: String, enum: ["info", "warning"], default: "info" },
      until: { type: Date, default: null },
    },
    // Switch features on and off without a new build
    flags: { type: Map, of: Boolean, default: {} },
    // Plan limits (lib/plan.js), e.g. { free: { circles: 3 }, plus: {...} }
    limits: { type: mongoose.Schema.Types.Mixed, default: null },
    // Cost brakes for sign-up SMS (lib/appConfig.js DEFAULT_OPS): { smsPerDay, smsPaused, smsRegions }
    ops: { type: mongoose.Schema.Types.Mixed, default: null },
    // Launch mail to the waitlist (lib/waitlist.js): { startedAt, by, finishedAt, sent, failed }
    waitlistLaunch: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("AppConfig", appConfigSchema);
