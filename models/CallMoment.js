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
});

// Calculate total reactions before saving
callMomentSchema.pre("save", function (next) {
  this.totalReactions = this.reactions.reduce(
    (total, reaction) => total + reaction.count,
    0,
  );
  next();
});

module.exports = mongoose.model("CallMoment", callMomentSchema);
