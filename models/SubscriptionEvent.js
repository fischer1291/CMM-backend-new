const mongoose = require("mongoose");

// One subscription event as RevenueCat (later also Apple) sent it: the
// webhook stores it before it touches the user, so a retry of the same event
// (rcEventId unique) is a no-op, and MRR, churn and sandbox share can be
// computed later from what was actually sent. Only the listed fields, never
// the raw payload. `result` is what applyEvent decided for it.
const subscriptionEventSchema = new mongoose.Schema({
  rcEventId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  appUserId: { type: String, default: null },
  type: { type: String, required: true },
  productId: { type: String, default: null },
  store: { type: String, default: null },
  environment: { type: String, enum: ["PRODUCTION", "SANDBOX"], default: "PRODUCTION" },
  periodType: { type: String, default: null },
  // RevenueCat's price in USD and in the purchase currency, both in cents
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

module.exports = mongoose.model("SubscriptionEvent", subscriptionEventSchema);
