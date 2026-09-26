/**
 * Wanna yap+: the user's plan, "Interesse zeigen" before purchases are live,
 * and the RevenueCat webhook that keeps subscriptions in sync (lib/plan.js).
 */
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Circle = require("../models/Circle");
const { planOf, limits } = require("../lib/plan");

// What people can say they're interested in (the paywall's feature list)
const INTEREST = ["hd_video", "bigger_circles", "longer_rounds", "memories", "year_review", "icons", "rituals", "family", "support"];

const PRODUCT_IDS = ["wannayap_plus_monthly", "wannayap_plus_yearly"];

/** Our RevenueCat app user id is the user's Mongo id. */
async function userForEvent(event) {
  const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases || [])].filter((id) => mongoose.isValidObjectId(id));
  for (const id of ids) {
    const user = await User.findById(id);
    if (user) return user;
  }
  return null;
}

const ACTIVE_EVENTS = ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT"];
// Cancelled or billing trouble: still Plus until the period runs out
const UNTIL_EXPIRY_EVENTS = ["CANCELLATION", "BILLING_ISSUE", "SUBSCRIPTION_PAUSED"];

/** Apply one RevenueCat event. Returns what happened, for the log and tests. */
async function applyEvent(event, now = new Date()) {
  const user = await userForEvent(event);
  if (!user) return "unknown_user";
  const eventAt = new Date(event.event_timestamp_ms || now);
  if (user.plus?.eventAt && eventAt < user.plus.eventAt) return "stale";
  const until = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
  const base = { eventAt, productId: event.product_id || user.plus?.productId || null };

  if (ACTIVE_EVENTS.includes(event.type) || UNTIL_EXPIRY_EVENTS.includes(event.type)) {
    // An admin grant without end date stays
    if (user.plus?.source === "admin" && user.plus?.active && !user.plus?.until) return "admin_grant_kept";
    user.plus = { ...user.plus?.toObject?.(), ...base, active: true, until, source: "store", since: user.plus?.since || now };
  } else if (event.type === "EXPIRATION") {
    if (user.plus?.source === "store") user.plus = { ...user.plus.toObject(), ...base, active: false, until };
  } else if (event.type === "TRANSFER") {
    return "transfer_ignored";
  } else {
    return "ignored";
  }
  await user.save();
  return "ok";
}

module.exports = (io) => {
  const router = express.Router();
  const requireAuth = (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });

  // GET /me/plan: my plan, both plans' limits for the comparison, my usage
  router.get("/me/plan", requireAuth, async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    const [plan, all, founded] = await Promise.all([planOf(me), limits(), Circle.countDocuments({ createdBy: me.phone })]);
    res.json({
      success: true,
      ...plan,
      userId: String(me._id),
      all,
      usage: { circlesFounded: founded },
      products: PRODUCT_IDS,
      interest: me.plusInterest?.at ? { at: me.plusInterest.at, features: me.plusInterest.features } : null,
    });
  });

  // POST /me/plus-interest { features: [...] }: "Interesse zeigen"
  router.post("/me/plus-interest", requireAuth, async (req, res) => {
    const features = Array.isArray(req.body?.features) ? [...new Set(req.body.features.filter((f) => INTEREST.includes(f)))] : [];
    await User.updateOne({ phone: req.auth.phone }, { plusInterest: { at: new Date(), features } });
    res.json({ success: true });
  });

  return router;
};

/**
 * POST /webhooks/revenuecat: mounted before the app's token check. RevenueCat
 * sends the Authorization header we configured (REVENUECAT_WEBHOOK_SECRET).
 */
module.exports.webhook = (io) => {
  const router = express.Router();
  router.post("/webhooks/revenuecat", async (req, res) => {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const given = String(req.headers.authorization || "");
    const expected = `Bearer ${secret}`;
    if (!secret || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return res.status(401).json({ success: false });
    }
    const event = req.body?.event;
    if (!event?.type) return res.status(400).json({ success: false });
    try {
      const result = await applyEvent(event);
      if (result === "ok") {
        const user = await userForEvent(event);
        if (user) io?.to(`user:${user.phone}`).emit("planChanged", {});
      }
      console.log(`💳 RevenueCat ${event.type}: ${result}`);
      res.json({ success: true, result });
    } catch (err) {
      console.error("❌ RevenueCat webhook:", err.message);
      // RevenueCat retries on errors
      res.status(500).json({ success: false });
    }
  });
  return router;
};

module.exports.applyEvent = applyEvent;
module.exports.INTEREST = INTEREST;
module.exports.PRODUCT_IDS = PRODUCT_IDS;
