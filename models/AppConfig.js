const mongoose = require("mongoose");

// One document (key "app"): what every app start reads from /app-config.
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "app", unique: true },
    // Older versions see a blocking "Bitte aktualisieren" screen
    minVersion: { type: String, default: null }, // e.g. "1.0.0"
    minBuild: { type: Number, default: null }, // e.g. 21
    updateUrl: { type: String, default: null }, // App Store / TestFlight link
    // A notice at the top of the app. source: null when set by hand in the
    // console, "alert:<tag>" when an alert rule with userFacing switched it
    // on (lib/statusBanner.js, plan 2.15); only such a banner is switched
    // off again automatically. muted: the "alert:<tag>" sources the owner
    // silenced by taking an automatic banner over or switching it off, so
    // the rules don't bring it back during the same outage (each dropped
    // once no rule of its text fires any more)
    banner: {
      enabled: { type: Boolean, default: false },
      text: { type: String, default: "" },
      level: { type: String, enum: ["info", "warning"], default: "info" },
      until: { type: Date, default: null },
      source: { type: String, default: null },
      muted: { type: [String], default: [] },
    },
    // Switch features on and off without a new build
    flags: { type: Map, of: Boolean, default: {} },
    // Plan limits (lib/plan.js), e.g. { free: { circles: 3 }, plus: {...} }
    limits: { type: mongoose.Schema.Types.Mixed, default: null },
    // Cost brakes for sign-up SMS (lib/appConfig.js DEFAULT_OPS): { smsPerDay, smsPaused, smsRegions };
    // also the weekly report's markers (lib/weeklyReport.js): weeklyReportFor
    // (ISO week last sent), weeklyReportAt, weeklyReportFirstAt
    ops: { type: mongoose.Schema.Types.Mixed, default: null },
    // Goals the numbers are judged against (lib/appConfig.js DEFAULT_GOALS): { activationPct, densityPct }
    goals: { type: mongoose.Schema.Types.Mixed, default: null },
    // Unit prices for the cost columns, assumptions until checked against the
    // invoices (lib/appConfig.js DEFAULT_PRICES, plan 2.5): { smsEurCents,
    // agoraAudioUsdCentsPer1000Min, agoraVideoUsdCentsPer1000Min, agoraFreeMinutesPerMonth, ... }
    prices: { type: mongoose.Schema.Types.Mixed, default: null },
    // Monthly fixed costs, credits as negative entries with an end date:
    // [{ service, monthlyEurCents, note, until }] (lib/economics.js)
    fixedCosts: { type: mongoose.Schema.Types.Mixed, default: null },
    // Hints from the Monday review for the marketing agent (plan 2.11): free
    // text up to 1000 characters, e.g. the hook topic of the week; the agent
    // gets it as `notes` from GET /marketing/context (lib/marketing.js)
    marketingNotes: { type: String, default: null },
    // One-off data fixes already applied (index.js migrate), e.g. { morningPush: Date }
    migrations: { type: mongoose.Schema.Types.Mixed, default: null },
    // Launch mail to the waitlist (lib/waitlist.js): { startedAt, by, finishedAt, sent, failed }
    waitlistLaunch: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("AppConfig", appConfigSchema);
