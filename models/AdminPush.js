const mongoose = require("mongoose");

// Push to the admin console on the admins' phones (Web Push, lib/adminPush.js).
// One subscription per device and browser that allowed notifications.
const subscriptionSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  // e.g. "iPhone" or "Mac", from the user agent, to tell devices apart
  device: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  lastSentAt: { type: Date, default: null },
});

// The VAPID key pair (created on first use unless ADMIN_PUSH_PUBLIC_KEY and
// ADMIN_PUSH_PRIVATE_KEY are set).
const stateSchema = new mongoose.Schema({
  _id: { type: String },
  publicKey: { type: String, default: null },
  privateKey: { type: String, default: null },
});

module.exports = {
  AdminPushSubscription: mongoose.model("AdminPushSubscription", subscriptionSchema),
  AdminPushState: mongoose.model("AdminPushState", stateSchema),
};
