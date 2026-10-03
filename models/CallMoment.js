// A picture from a real call (lib/moments.js), shared once the other person
// agreed and visible to friends for 24 hours.
const mongoose = require("mongoose");

// Reaction schema
const reactionSchema = new mongoose.Schema({
  emoji: {
    type: String,
    required: true,
    enum: ["❤️", "😂", "😮", "😢", "😍", "👏"], // Valid reaction emojis
  },
  users: [
    {
      phone: {
        type: String,
        required: true,
      },
      timestamp: {
        type: Date,
        default: Date.now,
      },
    },
  ],
  count: {
    type: Number,
    default: 0,
  },
});

// CallMoment schema
const callMomentSchema = new mongoose.Schema({
  userPhone: {
    type: String,
    required: true,
  },
  userName: {
    type: String,
    required: true,
  },
  targetPhone: {
    type: String,
    required: true,
  },
  targetName: {
    type: String,
    required: true,
  },
  screenshot: {
    type: String,
    required: true,
  },
  note: {
    type: String,
    default: "",
  },
  mood: {
    type: String,
    required: true,
  },
  callDuration: {
    type: String,
    required: true,
  },
  reactions: [reactionSchema], // Array of reactions
  totalReactions: {
    type: Number,
    default: 0,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  // Hidden after several reports (routes/social.js) or by support
  hidden: { type: Boolean, default: false },
  // When support's statement of reasons for hiding went to the author
  // (lib/moderation.js hideMoment): one per hiding, cleared on unhide
  hiddenNoticeAt: { type: Date, default: null },
  // Shared only once the other person agreed; older moments count as shared
  status: { type: String, enum: ["pending", "shared"], default: "shared" },
  sharedAt: { type: Date, default: null },
});

// The plan limit momentsPerDay (lib/plan.js) and the feeds read a person's
// moments by time
callMomentSchema.index({ userPhone: 1, timestamp: -1 });

// Calculate total reactions before saving
callMomentSchema.pre("save", function (next) {
  this.totalReactions = this.reactions.reduce(
    (total, reaction) => total + reaction.count,
    0,
  );
  next();
});

module.exports = mongoose.model("CallMoment", callMomentSchema);
