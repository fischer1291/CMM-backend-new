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
  // Came in through someone's invite (admin growth numbers)
  joinedViaInvite: { type: Boolean, default: false },
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
