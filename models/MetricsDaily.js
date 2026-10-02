const mongoose = require("mongoose");

// One snapshot of the key numbers per day (Europe/Berlin), written by
// lib/metrics.js. Raw data expires (calls after 30 days, push decisions after
// 3), the snapshots stay. `version` is the METRICS_VERSION the snapshot was
// computed with; runSnapshots recomputes recent days with an older version,
// so a new column reaches the last 30 days instead of starting empty.
const metricsDailySchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true },
    // Still running: refreshed until the day is over
    partial: { type: Boolean, default: false },
    version: { type: Number, default: null },
    users: {
      total: Number,
      new: Number,
      dau: Number,
      wau: Number,
      mau: Number,
      // Rolling activation (lib/metrics.js activation4w): share in percent of
      // the sign-ups of the last four full weeks who talked within 7 days,
      // and how many of them were measured (window over). Under 100 the
      // console says "zu wenig Daten" instead of judging the number.
      activation4w: Number,
      activationSample: Number,
      // Address book density of people who signed up 7 to 35 days ago
      // (lib/metrics.js density): percent with at least three registered
      // contacts, percent with none, how many were looked at, and the
      // histogram in percent (c0 · 1–2 · 3–5 · 6 and more)
      density: { c3plus: Number, c0: Number, sample: Number, c1_2: Number, c3_5: Number, c6plus: Number },
      // The five most common device languages of the day's sign-ups (User.locale)
      byLocale: { type: [{ _id: false, locale: String, users: Number }], default: undefined },
    },
    calls: { started: Number, answered: Number, missed: Number, declined: Number, busy: Number, cancelled: Number, audio: Number },
    talks: { count: Number, minutes: Number, people: Number },
    circles: { total: Number, new: Number, rooms: Number, ritualRooms: Number, roomMinutes: Number },
    rituals: { dailyJoined: Number, moments: Number, nudges: Number },
    // inviteVisits: the personal invite link opened (InviteVisit), by platform
    growth: { invites: Number, joinedViaInvite: Number, inviteVisits: { total: Number, ios: Number, android: Number, other: Number } },
    // Waitlist confirmations of the day by the platform they told us (WaitlistEntry.platform)
    waitlist: { byPlatform: { ios: Number, android: Number, unknown: Number } },
    push: { sent: Number, skipped: Number, failed: Number },
    reports: { new: Number, open: Number },
    // Wanna yap+ as a time series (plan 2.4, lib/metrics.js plusDay): the
    // day's SubscriptionEvents in PRODUCTION (sandbox never counts), the
    // active plans at the end of the day by source, and the MRR in cents as
    // the sum of the monthly normalised prices of the active store plans.
    // giftDaysGranted: Plus days given that day by source (plan 2.12, the
    // day counters giftDays_*); giftToStore: first store purchases of the
    // day by people whose Plus was a gift before (User.plus.previousSource).
    // funnel and limitHits: the paywall and the plan limits (plan 2.6a).
    plus: {
      activeStore: Number,
      activeGift: Number,
      activeSandbox: Number,
      newPaid: Number,
      renewed: Number,
      cancelled: Number,
      billingIssue: Number,
      expired: Number,
      refunds: Number,
      trialsStarted: Number,
      trialsConverted: Number,
      mrrCents: Number,
      giftDaysGranted: { referral: Number, waitlist: Number, admin: Number },
      giftToStore: Number,
      // Paywall funnel (plan 2.6a, lib/paywall.js funnelOf): the steps the
      // app reported that day (POST /me/plus/funnel), and per source
      // (/plus?from=...) the views and purchases: { settings: { view, success } }
      funnel: {
        paywallView: Number,
        purchaseStart: Number,
        purchaseSuccess: Number,
        purchaseCancel: Number,
        purchaseError: Number,
        restoreSuccess: Number,
        restoreError: Number,
        offeringEmpty: Number,
        bySource: { type: mongoose.Schema.Types.Mixed, default: undefined },
      },
      // Refusals by a plan limit that day, by limit (lib/paywall.js
      // limitHitsOf): { circles: 2, roomMinutes: 1, video: 4, ... }
      limitHits: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    // Variable costs of the day (plan 2.5, lib/metrics.js computeDay and
    // priceCosts): the quantities (SMS from the day counters, Agora
    // participant minutes by mode from Talk and Call, Cloudinary uploads,
    // pushes, VoIP pushes) and their price in euro cents (two decimals) at
    // AppConfig.prices when the day was counted; perMauEurCents =
    // variableEurCents / users.mau, null without MAU.
    costs: {
      smsStarted: Number,
      smsChecked: Number,
      agoraAudioMinutes: Number,
      agoraVideoMinutes: Number,
      cloudinaryUploads: Number,
      pushSent: Number,
      voipSent: Number,
      variableEurCents: Number,
      perMauEurCents: Number,
    },
    // Lifecycle pushes (plan 2.3, lib/metrics.js lifecycleDay), per type:
    // sentByType = sent on this day; activeNextDay = of the pushes sent the
    // day before, { sent, active } with an ActiveDay on this day; talk48h =
    // of the pushes sent two days before, { sent, talked } with a talk
    // within 48 hours of the push. Each column is known on this day, while
    // the push decisions (3 days) are still there. Sums only.
    lifecycle: {
      sentByType: { type: mongoose.Schema.Types.Mixed, default: undefined },
      activeNextDay: { type: mongoose.Schema.Types.Mixed, default: undefined },
      talk48h: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    // Day counters from lib/opsCounters.js, e.g. callsRejectedNotConnected, matchSuspicious, smsStarted
    ops: { type: mongoose.Schema.Types.Mixed, default: null },
    computedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

module.exports = mongoose.model("MetricsDaily", metricsDailySchema);
