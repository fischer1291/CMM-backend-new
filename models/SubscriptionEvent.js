const mongoose = require("mongoose");

// One subscription event as RevenueCat or Apple sent it: the webhook stores
// it before it touches the user, so a retry of the same event (rcEventId
// unique) is a no-op, and MRR, churn and sandbox share can be computed later
// from what was actually sent. Only the listed fields, never the raw
// payload. `result` is what the webhook decided for it. source "apple" (plan
// 2.6b, lib/appleNotifications.js): an App Store Server Notification,
// rcEventId "apple:<notificationUUID>", type the notificationType with its
// subtype after a colon ("SUBSCRIBED:INITIAL_BUY", "REFUND"), appUserId the
// transaction's appAccountToken, prices in the purchase currency only.
const subscriptionEventSchema = new mongoose.Schema({
  rcEventId: { type: String, required: true, unique: true },
  // Apple's id of the subscription across renewals: both sources store it
  // (RevenueCat as original_transaction_id), so an Apple notification finds
  // its user through the newest event of the same subscription
  originalTransactionId: { type: String, default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  appUserId: { type: String, default: null },
  type: { type: String, required: true },
  productId: { type: String, default: null },
  store: { type: String, default: null },
  environment: { type: String, enum: ["PRODUCTION", "SANDBOX"], default: "PRODUCTION" },
  periodType: { type: String, default: null },
  // RevenueCat's price in USD and in the purchase currency, both in cents
  // (Apple: both the purchase currency)
  priceCents: { type: Number, default: null },
  currency: { type: String, default: null },
  priceInPurchasedCurrencyCents: { type: Number, default: null },
  takehomePercent: { type: Number, default: null },
  cancelReason: { type: String, default: null },
  presentedOfferingId: { type: String, default: null },
  expirationAt: { type: Date, default: null },
  purchasedAt: { type: Date, default: null },
  eventAt: { type: Date, default: null },
  // TRANSFER: the app user ids the subscription moved between
  transferredFrom: { type: [String], default: [] },
  transferredTo: { type: [String], default: [] },
  source: { type: String, enum: ["revenuecat", "apple"], default: "revenuecat" },
  result: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

subscriptionEventSchema.index({ userId: 1, eventAt: -1 });
subscriptionEventSchema.index({ originalTransactionId: 1, eventAt: -1 }, { partialFilterExpression: { originalTransactionId: { $type: "string" } } });

module.exports = mongoose.model("SubscriptionEvent", subscriptionEventSchema);
