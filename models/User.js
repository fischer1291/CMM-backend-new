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
  // (the app computes the same hash, so it has no pepper)
  phoneHash: { type: String, index: true },
  // HMAC-SHA256 of the number with the server's pepper (hmacPhone below): the
  // key of the analytics rows (ActiveDay.who), never shared with the app.
  // Set on sign-up and, for older accounts, by index.js migrate()
  phoneHmac: { type: String, index: true },
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
    // Lifecycle pushes (lib/lifecycle.js): onboarding hints, "come back",
    // the weekly series, Plus ending and billing. The app calls the switch
    // "Erinnerungen und Tipps"
    lifecycle: { type: Boolean, default: true },
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
  // Personal invite code in the share link (/einladung?von=CODE), 8
  // characters from lib/waitlist.js newCode's alphabet; given on sign-up and
  // to older accounts on their next GET /me (lib/invites.js ensureInviteCode).
  // No default: the sparse unique index must skip accounts without one.
  inviteCode: { type: String, unique: true, sparse: true },
  // Device language from the Accept-Language header (e.g. "de-DE"), stored
  // by /verify/check and /me/update: only measured (users.byLocale in
  // lib/metrics.js), nothing is translated
  locale: { type: String, default: null },
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
  // Two-sided invite experiment (plan 2.12, lib/referral.js rewardPair): the
  // inviters (E.164) with whom this invitee's first talk already gave both
  // of them Plus days, once per pair. Removed from here when they delete
  // their account (lib/account.js)
  referralPairRewards: { type: [String], default: [] },
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
  // "Woher kennst du Wanna yap?" (plan 2.10, POST /me/acquisition, lib/
  // acquisition.js): the person's own, voluntary answer in onboarding.
  // source: friend | tiktok | instagram | flyer | press | other;
  // androidFriends: how many of their five closest friends have Android
  // (0–5, null when skipped). code and campaign come from the server, never
  // from the app: code is the invite code of the first inviter (invitedBy[0])
  // when the account joined through an invite, campaign a Campaign slug when
  // the account's way in names one (the redeemed waitlist entry, or the
  // running seed campaign, AppConfig.goals.seedCampaign). at is the first
  // answer; a second one within 24 hours replaces it, later ones get 409.
  acquisition: {
    source: { type: String, default: null },
    androidFriends: { type: Number, default: null },
    campaign: { type: String, default: null },
    code: { type: String, default: null },
    at: { type: Date, default: null },
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
    // For a store Plus: the source before it came from the store (a gift
    // source or null), set when the source switches to store/sandbox
    // (lib/plusReconcile.js previousSourceFor); counts gift -> store
    // conversions (plan 2.12, MetricsDaily.plus.giftToStore)
    previousSource: { type: String, default: null },
    // What the store last said (routes/plus.js); null for admin, gift, referral
    status: { type: String, enum: ["active", "trial", "cancelled", "billing_issue", "paused", "expired"], default: null },
  },
  // "Interesse zeigen" before purchases are live: when, and what for
  plusInterest: {
    at: { type: Date, default: null },
    features: { type: [String], default: [] },
  },

  // What the device last said about its permissions (POST /me/state, plan
  // 2.3): "granted" | "denied" | "undetermined" or null when never told.
  // Written when a value changes or `at` is older than two hours, so the
  // app may send it on every start. lib/lifecycle.js reads
  // contactsPermission for the text of invite_reminder.
  device: {
    notifications: { type: String, default: null },
    contactsPermission: { type: String, default: null },
    at: { type: Date, default: null },
  },
  // Lifecycle pushes already sent (lib/lifecycle.js): stage key (e.g.
  // "invite_reminder", "week_open:2026-09-28") -> when. Claimed by a
  // conditional update before the push, so each stage goes out once even
  // when two instances run the job. Falls with the account.
  lifecycle: {
    sent: { type: Map, of: Date, default: undefined },
  },

  // Devices signed in on this account (plan 2.9, lib/devices.js), at most
  // ten, the least recently seen fall out. id: X-Device-Id, the iOS
  // identifierForVendor or a UUID the app made once (no advertising id);
  // model: expo-device modelName. Written by /verify/check,
  // /verify/account-check, /user/push-token and, at most every six hours per
  // device, by authenticated requests; POST /me/logout-all keeps only the
  // calling one. A sign-in from an id not listed here counts as a new device
  // (new_device push, the recycled-number question in routes/verify.js).
  devices: {
    type: [
      {
        _id: false,
        id: String,
        model: { type: String, default: null },
        platform: { type: String, default: null },
        appVersion: { type: String, default: null },
        appBuild: { type: String, default: null },
        firstSeenAt: Date,
        lastSeenAt: Date,
      },
    ],
    default: [],
  },
  // Last successful SMS verification that issued a token (routes/verify.js)
  lastVerifiedAt: { type: Date, default: null },
  // The open "Ist das dein Konto?" question of a recycled number
  // (routes/verify.js): the nonce inside the checkToken and until when it
  // holds. Cleared when the token is redeemed, so it works once.
  accountCheck: {
    nonce: { type: String, default: null },
    until: { type: Date, default: null },
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

  // Re-match (plan 2.13, lib/rematch.js, PUT /me/rematch): "Sag mir, wenn
  // jemand aus meinem Adressbuch dazukommt". Off unless the person switches
  // it on; with it, contact syncs keep the unmatched hashes peppered in
  // AddressBookHash. at: the last change of the switch
  rematch: {
    optIn: { type: Boolean, default: false },
    at: { type: Date, default: null },
  },

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

// The Plus counts of the day (lib/metrics.js plusDay) and the nightly
// reconcile (lib/plusReconcile.js) select by source and active
userSchema.index({ "plus.source": 1, "plus.active": 1 });

userSchema.statics.hashPhone = (phone) =>
  crypto.createHash("sha256").update(phone).digest("hex");

/**
 * The pepper for hmacPhone: PHONE_HASH_PEPPER, set once and never changed (a
 * new pepper orphans every ActiveDay row, README "Pseudonymous data").
 * Without it a value derived from JWT_SECRET, so a deployment that forgot
 * the variable still works; index.js warns about it at start.
 */
userSchema.statics.phonePepperConfigured = () => !!process.env.PHONE_HASH_PEPPER;
const phonePepper = () =>
  process.env.PHONE_HASH_PEPPER || crypto.createHash("sha256").update(`${process.env.JWT_SECRET || ""}:phone-hash`).digest("hex");
// SHA-256 of the pepper, never the pepper: stored as AppConfig.migrations
// .phoneHmacKey so the start knows whether every phoneHmac still matches the
// current pepper without reading all accounts (lib/pseudonyms.js)
userSchema.statics.phonePepperFingerprint = () => crypto.createHash("sha256").update(`pepper:${phonePepper()}`).digest("hex");

/**
 * Keyed hash of the E.164 number for the analytics collections (ActiveDay):
 * unlike hashPhone it cannot be computed offline over the German number
 * space without the pepper. Not for /contacts/match, Invite.toHash,
 * Circle.invites.hash or BannedNumber.hash: those stay SHA-256, because the
 * app computes them and a re-keying would break invites and the ban list.
 */
userSchema.statics.hmacPhone = (phone) => crypto.createHmac("sha256", phonePepper()).update(phone).digest("hex");

module.exports = mongoose.model("User", userSchema);
