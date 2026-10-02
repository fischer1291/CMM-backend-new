/**
 * Wanna yap+: the user's plan, "Interesse zeigen" before purchases are live,
 * and the RevenueCat webhook that keeps subscriptions in sync (lib/plan.js).
 * Every webhook event is stored first (models/SubscriptionEvent.js), so a
 * retry is a duplicate and nothing is applied twice; /me/plus/sync asks
 * RevenueCat's REST API when the app wants the truth right after a purchase
 * (lib/plusReconcile.js applyStoreState, shared with the nightly job).
 */
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Circle = require("../models/Circle");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const { planOf, limits } = require("../lib/plan");
const { referralOf } = require("../lib/referral");
const { yearReview } = require("../lib/yearReview");
const revenuecat = require("../lib/revenuecat");
const opsCounters = require("../lib/opsCounters");
const { PRODUCT_IDS, STORE_SOURCES, hasOpenAdminGrant, applyStoreState } = require("../lib/plusReconcile");

// Webhook trouble is counted per day for the alert revenuecat (lib/alerts.js)
const countOps = (name) => opsCounters.count(name).catch((err) => console.error("❌ opsCounters:", err.message));

// What people can say they're interested in (the paywall's feature list)
const INTEREST = ["hd_video", "bigger_circles", "longer_rounds", "memories", "year_review", "icons", "rituals", "family", "support"];

/** Our RevenueCat app user id is the user's Mongo id. */
async function userForIds(ids) {
  for (const id of (ids || []).filter((id) => mongoose.isValidObjectId(id))) {
    const user = await User.findById(id);
    if (user) return user;
  }
  return null;
}
const userForEvent = (event) => userForIds([event.app_user_id, event.original_app_user_id, ...(event.aliases || [])]);

const ACTIVE_EVENTS = ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT"];
// Cancelled or billing trouble: still Plus until the period runs out
const UNTIL_EXPIRY_EVENTS = ["CANCELLATION", "BILLING_ISSUE", "SUBSCRIPTION_PAUSED"];
const cents = (amount) => (typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : null);
const dateOf = (ms) => (ms ? new Date(ms) : null);

/**
 * Store the event before anything is applied. Null when it was stored before
 * (RevenueCat retried). Without event.id (never in RevenueCat's payloads, but
 * cheap to guard) the key is derived from what identifies the event.
 */
async function recordEvent(event, now) {
  const rcEventId = event.id
    ? String(event.id)
    : `derived:${crypto.createHash("sha256").update(JSON.stringify([event.type, event.app_user_id, event.event_timestamp_ms, event.product_id, event.expiration_at_ms])).digest("hex")}`;
  try {
    return await SubscriptionEvent.create({
      rcEventId,
      appUserId: event.app_user_id || null,
      type: event.type,
      productId: event.product_id || null,
      store: event.store || null,
      environment: event.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
      periodType: event.period_type || null,
      priceCents: cents(event.price),
      currency: event.currency || null,
      priceInPurchasedCurrencyCents: cents(event.price_in_purchased_currency),
      takehomePercent: typeof event.takehome_percent === "number" ? event.takehome_percent : null,
      cancelReason: event.cancel_reason || null,
      presentedOfferingId: event.presented_offering_id || null,
      expirationAt: dateOf(event.expiration_at_ms),
      purchasedAt: dateOf(event.purchased_at_ms),
      eventAt: new Date(event.event_timestamp_ms || now),
      transferredFrom: Array.isArray(event.transferred_from) ? event.transferred_from.map(String) : [],
      transferredTo: Array.isArray(event.transferred_to) ? event.transferred_to.map(String) : [],
      source: "revenuecat",
    });
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
}

/** TRANSFER: the subscription now belongs to another app user (e.g. a new phone number, same Apple ID). */
async function applyTransfer(event, now) {
  const to = await userForIds(event.transferred_to);
  if (!to) return { result: "unknown_user", users: [] };
  const eventAt = new Date(event.event_timestamp_ms || now);
  if (to.plus?.eventAt && eventAt < to.plus.eventAt) return { result: "stale", users: [] };
  if (hasOpenAdminGrant(to)) return { result: "admin_grant_kept", users: [] };
  const from = await userForIds(event.transferred_from);
  const sandbox = event.environment === "SANDBOX";
  const users = [to];
  let moved;
  if (from && !from._id.equals(to._id) && STORE_SOURCES.includes(from.plus?.source) && from.plus?.active) {
    moved = { until: from.plus.until, productId: from.plus.productId, status: from.plus.status, source: from.plus.source };
    from.plus = { ...from.plus.toObject(), active: false, status: "expired", eventAt };
    await from.save();
    users.push(from);
  } else {
    // No known source: ask RevenueCat what the new owner has, if we can
    const found = revenuecat.configured() ? revenuecat.planFromSubscriber(await revenuecat.subscriber(String(to._id)), PRODUCT_IDS, now) : null;
    if (found) {
      moved = { until: found.until, productId: found.productId, status: found.status, source: found.sandbox ? "sandbox" : "store" };
    } else {
      console.warn(`⚠️ RevenueCat TRANSFER to ${to._id} without a known source${revenuecat.configured() ? " and no subscription" : " (REVENUECAT_API_KEY not set)"}: Plus without end date`);
      moved = { until: null, productId: to.plus?.productId || null, status: "active", source: "store" };
    }
  }
  to.plus = { ...to.plus?.toObject?.(), ...moved, eventAt, active: true, since: to.plus?.since || now, source: sandbox ? "sandbox" : moved.source };
  await to.save();
  return { result: "ok", users };
}

/** What one event does to its user: { result, users: the ones that changed }. */
async function apply(event, now) {
  if (event.type === "TRANSFER") return applyTransfer(event, now);
  const user = await userForEvent(event);
  if (!user) return { result: "unknown_user", users: [] };
  const eventAt = new Date(event.event_timestamp_ms || now);
  if (user.plus?.eventAt && eventAt < user.plus.eventAt) return { result: "stale", users: [] };
  const until = dateOf(event.expiration_at_ms);
  // A test account's purchase keeps Plus for the tester, but never counts as paying
  const source = event.environment === "SANDBOX" ? "sandbox" : "store";
  const base = { eventAt, productId: event.product_id || user.plus?.productId || null, status: revenuecat.statusFor(event.type, event.period_type) };

  if (ACTIVE_EVENTS.includes(event.type) || UNTIL_EXPIRY_EVENTS.includes(event.type)) {
    if (hasOpenAdminGrant(user)) return { result: "admin_grant_kept", users: [] };
    user.plus = { ...user.plus?.toObject?.(), ...base, active: true, until, source, since: user.plus?.since || now };
  } else if (event.type === "EXPIRATION") {
    if (STORE_SOURCES.includes(user.plus?.source)) user.plus = { ...user.plus.toObject(), ...base, active: false, until };
  } else {
    return { result: "ignored", users: [] };
  }
  await user.save();
  return { result: "ok", users: [user] };
}

/**
 * Store, then apply one RevenueCat event. Returns { result, users }; result
 * is what happened (ok, duplicate, stale, unknown_user, ...) for the log,
 * the stored event and the tests. If applying throws, the stored event is
 * removed again so RevenueCat's retry isn't mistaken for a duplicate.
 */
async function applyEvent(event, now = new Date()) {
  const stored = await recordEvent(event, now);
  if (!stored) return { result: "duplicate", users: [] };
  let outcome;
  try {
    outcome = await apply(event, now);
  } catch (err) {
    await SubscriptionEvent.deleteOne({ _id: stored._id }).catch(() => {});
    throw err;
  }
  await SubscriptionEvent.updateOne({ _id: stored._id }, { result: outcome.result, userId: outcome.users[0]?._id || null });
  return outcome;
}

module.exports = (io) => {
  const router = express.Router();
  const requireAuth = (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });

  /** The /me/plan body: my plan, both plans' limits for the comparison, my usage. */
  async function planBody(me) {
    const [plan, all, founded] = await Promise.all([planOf(me), limits(), Circle.countDocuments({ createdBy: me.phone })]);
    return {
      success: true,
      ...plan,
      userId: String(me._id),
      all,
      usage: { circlesFounded: founded },
      products: PRODUCT_IDS,
      referral: referralOf(me),
      interest: me.plusInterest?.at ? { at: me.plusInterest.at, features: me.plusInterest.features } : null,
    };
  }

  // GET /me/plan
  router.get("/me/plan", requireAuth, async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    res.json(await planBody(me));
  });

  // POST /me/plus/sync: right after a purchase or restore, when the webhook
  // may still be on its way: ask RevenueCat and set my Plus from the answer.
  // Answers like GET /me/plan; 501 without REVENUECAT_API_KEY.
  router.post("/me/plus/sync", requireAuth, async (req, res) => {
    if (!revenuecat.configured()) return res.status(501).json({ success: false, error: "not_configured" });
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    let found;
    try {
      found = revenuecat.planFromSubscriber(await revenuecat.subscriber(String(me._id)), PRODUCT_IDS);
    } catch (err) {
      console.error("❌ RevenueCat sync:", err.message);
      return res.status(502).json({ success: false, error: "revenuecat_unavailable" });
    }
    if (await applyStoreState(me, found, new Date())) io?.to(`user:${me.phone}`).emit("planChanged", {});
    res.json(await planBody(me));
  });

  // POST /me/plus-interest { features: [...] }: "Interesse zeigen"
  router.post("/me/plus-interest", requireAuth, async (req, res) => {
    const features = Array.isArray(req.body?.features) ? [...new Set(req.body.features.filter((f) => INTEREST.includes(f)))] : [];
    await User.updateOne({ phone: req.auth.phone }, { plusInterest: { at: new Date(), features } });
    res.json({ success: true });
  });

  // GET /me/year-review?year=2026: the headline for everyone, the story with Plus
  router.get("/me/year-review", requireAuth, async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    if (year < 2024 || year > now.getUTCFullYear()) return res.status(400).json({ success: false, error: "invalid_year" });
    const { limits: mine } = await planOf(me);
    res.json({ success: true, review: await yearReview(me, year, { full: !!mine.yearReview }) });
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
      countOps("rcUnauthorized");
      return res.status(401).json({ success: false });
    }
    const event = req.body?.event;
    if (!event?.type) return res.status(400).json({ success: false });
    try {
      const { result, users } = await applyEvent(event);
      for (const user of users) io?.to(`user:${user.phone}`).emit("planChanged", {});
      if (result === "unknown_user") {
        countOps("rcUnknownUser");
        console.error(`❌ RevenueCat ${event.type} for unknown app user ${event.app_user_id || (event.transferred_to || []).join(",")}`);
      } else console.log(`💳 RevenueCat ${event.type}: ${result}`);
      res.json({ success: true, result });
    } catch (err) {
      console.error("❌ RevenueCat webhook:", err.message);
      // RevenueCat retries on errors; the event was not kept, so the retry applies
      res.status(500).json({ success: false });
    }
  });
  return router;
};

module.exports.applyEvent = applyEvent;
module.exports.INTEREST = INTEREST;
module.exports.PRODUCT_IDS = PRODUCT_IDS;
