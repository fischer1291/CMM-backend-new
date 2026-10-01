const crypto = require("crypto");
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  isAvailable: { type: Boolean, default: false },

  // Regular push token (for Expo push)
  pushToken: { type: String },
  pushTokenMetadata: {
    deviceId: String,
    platform: String,
    registeredAt: Date,
    lastValidated: Date,
  },

  // VoIP push token (for iOS CallKit in background)
  voipToken: { type: String },
  voipTokenMetadata: {
    deviceId: String,
    platform: String,
    registeredAt: Date,
    // "production" | "sandbox"; learned on the first successful VoIP push
    environment: String,
  },

  name: String,
  avatarUrl: String,
  lastOnline: { type: Date, default: null },
  momentActiveUntil: { type: Date, default: null },
  mood: { type: String, default: null },

  // SHA-256 of the E.164 phone number, for privacy-preserving contact matching
  phoneHash: { type: String, index: true },
  // Registered users found in this user's address book (E.164). Used to limit
  // status updates and the CallMoments feed to people who know each other.
  contacts: { type: [String], default: [], index: true },
  // People connected through an invite (lib/invites.js), E.164. Kept apart
  // from the address book matches so an address book sync never drops them:
  // /contacts/match merges them back into `contacts` every time.
  connections: { type: [String], default: [] },

  // How the current availability started: manual | session | schedule
  availableSource: { type: String, default: null },

  // Weekly availability plan, applied in the user's time zone (lib/schedule.js)
  schedule: {
    enabled: { type: Boolean, default: false },
    timezone: { type: String, default: null },
    slots: {
      type: [{ _id: false, day: Number, start: Number, end: Number }],
      default: [],
    },
  },
  lastScheduleSlotKey: { type: String, default: null },

  // IANA time zone of the user's device, for quiet hours and local times
  timezone: { type: String, default: null },

  // Which pushes the user wants (lib/notify.js). Quiet hours in local minutes.
  notificationPrefs: {
    available: { type: Boolean, default: true },
    nudges: { type: Boolean, default: true },
    moments: { type: Boolean, default: true },
    dailyMoment: { type: Boolean, default: true },
    quietHours: {
      enabled: { type: Boolean, default: true },
      start: { type: Number, default: 22 * 60 },
      end: { type: Number, default: 8 * 60 },
    },
  },

  // Badges: people who joined via this user's invites ("Brückenbauer"),
  // the badge tiers already celebrated, and up to 3 badges on show
  invitesJoined: { type: Number, default: 0 },
  // Of those, how many had their first talk since: what invite rewards count
  // (lib/referral.js)
  invitesActivated: { type: Number, default: 0 },
  // Came in through someone's invite (admin growth numbers), and by whom
  // (E.164; they get the reward once this user had the first talk)
  joinedViaInvite: { type: Boolean, default: false },
  invitedBy: { type: [String], default: [] },
  // First invite sent (activation funnel) and invite rewards already given
  // (lib/referral.js)
  firstInviteAt: { type: Date, default: null },
  // Waitlist code redeemed (lib/waitlist.js): badge "Von Anfang an"
  waitlist: {
    code: { type: String, default: null },
    at: { type: Date, default: null },
    referrals: { type: Number, default: 0 },
  },
  referralRewards: { type: Number, default: 0 },
  // Onboarding milestones (activation funnel): each is set once, by a
  // conditional update on the empty field, and never overwritten.
  // verifiedAt: routes/verify.js · contactsSyncedAt, firstRegisteredContactAt
  // (a match with at least one hit): routes/contacts.js · pushGrantedAt:
  // app.js /user/push-token · firstCallAt: lib/calls.js startCall ·
  // firstTalkAt: lib/referral.js noteFirstTalk. firstInviteAt is above.
  milestones: {
    verifiedAt: { type: Date, default: null },
    contactsSyncedAt: { type: Date, default: null },
    firstRegisteredContactAt: { type: Date, default: null },
    pushGrantedAt: { type: Date, default: null },
    firstCallAt: { type: Date, default: null },
    firstTalkAt: { type: Date, default: null },
  },
  // User research (README "User research"): after the second talk the app
  // invites to a 15-minute call with the founder (invitedAt, lib/calls.js
  // recordTalk, never for an admin Plus grant). The person books or
  // dismisses once (routes/me.js); doneAt is set by support in the console
  // when the talk took place; the thank-you is the usual Plus grant.
  research: {
    invitedAt: { type: Date, default: null },
    bookedAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },
  },
  // Consent given in onboarding (Art. 7 and 8 GDPR, COMPLIANCE.md): when the
  // person confirmed to be at least 16, and which wording of the terms and
  // the privacy policy they saw (CMM content/legal.ts TERMS_VERSION and
  // PRIVACY_UPDATED). Written by routes/verify.js /check when the app sends
  // it, again when a version changes; apps from before plan 1.6 send nothing
  // and keep null.
  consent: {
    ageConfirmedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null },
    privacyVersion: { type: String, default: null },
  },

  // Moderation (admin console): no sign-in until then; tokens issued before
  // tokensValidAfter are rejected (lib/accessGate.js)
  suspendedUntil: { type: Date, default: null },
  suspendReason: { type: String, default: null },
  tokensValidAfter: { type: Date, default: null },
  // Missed calls up to here were seen in the call list
  callsSeenAt: { type: Date, default: null },

  // Wanna yap+ (lib/plan.js). source: store (RevenueCat) | sandbox (store, test account) | admin | gift | referral | waitlist
  plus: {
    active: { type: Boolean, default: false },
    until: { type: Date, default: null },
    since: { type: Date, default: null },
    source: { type: String, default: null },
    productId: { type: String, default: null },
    // RevenueCat's last event, to ignore older ones arriving late
    eventAt: { type: Date, default: null },
    // What the store last said (routes/plus.js); null for admin, gift, referral
    status: { type: String, enum: ["active", "trial", "cancelled", "billing_issue", "paused", "expired"], default: null },
  },
  // "Interesse zeigen" before purchases are live: when, and what for
  plusInterest: {
    at: { type: Date, default: null },
    features: { type: [String], default: [] },
  },

  // App version last seen (request headers), for support and min versions
  app: {
    version: { type: String, default: null },
    build: { type: String, default: null },
    platform: { type: String, default: null },
    os: { type: String, default: null },
    seenAt: { type: Date, default: null },
  },
  badgeSeen: { type: mongoose.Schema.Types.Mixed, default: null },
  showcase: { type: [String], default: [] },

  // Inviters to tell "X ist jetzt dabei" once this new user set a name
  pendingJoinAnnouncement: { type: [String], default: [] },

  // Personal groups ("Familie", "Enge Freunde"): members are contacts
  circles: {
    type: [
      {
        _id: false,
        id: String,
        name: String,
        emoji: String,
        members: [String],
      },
    ],
    default: [],
  },
  // Who sees when this user is available: all contacts or some circles
  availabilityAudience: {
    mode: { type: String, enum: ["all", "circles"], default: "all" },
    circles: { type: [String], default: [] },
  },

  // Who may see this user's talk-time stats. Private unless the user opts in.
  statsSharing: {
    visibility: { type: String, enum: ["private", "contacts", "selected"], default: "private" },
    sharedWith: { type: [String], default: [] },
  },
});

userSchema.statics.hashPhone = (phone) =>
  crypto.createHash("sha256").update(phone).digest("hex");

module.exports = mongoose.model("User", userSchema);
