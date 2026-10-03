// RevenueCat events as records: duplicates, sandbox, TRANSFER, status, and the REST sync
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const revenuecat = require("../lib/revenuecat");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  process.env.REVENUECAT_WEBHOOK_SECRET = "rc-secret";
  delete process.env.REVENUECAT_API_KEY;
  revenuecat.setFetchSubscriber(null);
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const DAY = 24 * 3600 * 1000;

async function login(phone, name = "X") {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: "Europe/Berlin" });
  return { token: res.body.token, id: String((await User.findOne({ phone }))._id) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const hook = (event) => request(ctx.app).post("/webhooks/revenuecat").set("Authorization", "Bearer rc-secret").send({ event });
let n = 0;
const event = (type, id, at, extra = {}) => ({
  id: `evt-${++n}`,
  type,
  app_user_id: id,
  product_id: "wannayap_plus_monthly",
  store: "APP_STORE",
  environment: "PRODUCTION",
  period_type: "NORMAL",
  price: 2.99,
  currency: "EUR",
  price_in_purchased_currency: 2.99,
  takehome_percent: 0.85,
  event_timestamp_ms: at,
  purchased_at_ms: at,
  expiration_at_ms: at + 30 * DAY,
  ...extra,
});

/** First admin's session cookie, for /admin/plus. */
async function adminCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ email: "owner@example.com", password: "a-long-admin-password", setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ email: "owner@example.com", password: "a-long-admin-password", code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return (done.headers["set-cookie"] || [])[0]?.split(";")[0];
}

test("webhook: every event is stored once; a retry is a duplicate and changes nothing", async () => {
  const anna = await login(ANNA);
  const t = Date.now();
  const purchase = event("INITIAL_PURCHASE", anna.id, t, { presented_offering_id: "default" });
  assert.equal((await hook(purchase).expect(200)).body.result, "ok");
  assert.equal((await hook(purchase).expect(200)).body.result, "duplicate");
  assert.equal(await SubscriptionEvent.countDocuments(), 1);

  const stored = await SubscriptionEvent.findOne({ rcEventId: purchase.id });
  assert.equal(String(stored.userId), anna.id);
  assert.equal(stored.appUserId, anna.id);
  assert.equal(stored.type, "INITIAL_PURCHASE");
  assert.equal(stored.priceCents, 299);
  assert.equal(stored.currency, "EUR");
  assert.equal(stored.priceInPurchasedCurrencyCents, 299);
  assert.equal(stored.takehomePercent, 0.85);
  assert.equal(stored.environment, "PRODUCTION");
  assert.equal(stored.presentedOfferingId, "default");
  assert.equal(stored.expirationAt.getTime(), t + 30 * DAY);
  assert.equal(stored.source, "revenuecat");
  assert.equal(stored.result, "ok");

  // An older event is stored too, with what the webhook decided
  assert.equal((await hook(event("RENEWAL", anna.id, t - 5000))).body.result, "stale");
  assert.equal((await SubscriptionEvent.findOne({ type: "RENEWAL" })).result, "stale");
  assert.equal((await hook(event("RENEWAL", "nobody", t + 1000))).body.result, "unknown_user");
  assert.equal((await SubscriptionEvent.findOne({ appUserId: "nobody" })).result, "unknown_user");
  // Still exactly one Plus
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.active, true);
  assert.equal(user.plus.until.getTime(), t + 30 * DAY);
});

test("webhook: a sandbox purchase keeps Plus for the tester, counted separately, never as paying", async () => {
  const cookie = await adminCookie();
  const anna = await login(ANNA);
  const ben = await login(BEN);
  const t = Date.now();
  await hook(event("INITIAL_PURCHASE", anna.id, t, { environment: "SANDBOX" })).expect(200);
  await hook(event("INITIAL_PURCHASE", ben.id, t)).expect(200);
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.active, true);
  assert.equal(user.plus.source, "sandbox");
  assert.equal((await SubscriptionEvent.findOne({ appUserId: anna.id })).environment, "SANDBOX");
  assert.equal((await request(ctx.app).get("/me/plan").set(auth(anna.token))).body.plan, "plus");

  const stats = (await request(ctx.app).get("/admin/plus").set("Cookie", cookie).expect(200)).body;
  assert.equal(stats.active, 2);
  assert.equal(stats.sandbox, 1);
  assert.deepEqual(stats.bySource, { sandbox: 1, store: 1 });
  assert.deepEqual(stats.byProduct, { wannayap_plus_monthly: 1 }, "products only count real purchases");

  // The referral card still shows for a tester: no store subscription
  const plan = (await request(ctx.app).get("/me/plan").set(auth(anna.token))).body;
  assert.equal(plan.plus.source, "sandbox");
});

test("webhook: status follows the event type and period", async () => {
  const anna = await login(ANNA);
  const t = Date.now();
  const status = async () => (await User.findOne({ phone: ANNA })).plus.status;
  await hook(event("INITIAL_PURCHASE", anna.id, t, { period_type: "TRIAL" })).expect(200);
  assert.equal(await status(), "trial");
  await hook(event("RENEWAL", anna.id, t + 1000)).expect(200);
  assert.equal(await status(), "active");
  await hook(event("BILLING_ISSUE", anna.id, t + 2000)).expect(200);
  assert.equal(await status(), "billing_issue");
  await hook(event("CANCELLATION", anna.id, t + 3000, { cancel_reason: "UNSUBSCRIBE" })).expect(200);
  assert.equal(await status(), "cancelled");
  assert.equal((await User.findOne({ phone: ANNA })).plus.active, true, "cancelled: Plus until the period ends");
  assert.equal((await SubscriptionEvent.findOne({ type: "CANCELLATION" })).cancelReason, "UNSUBSCRIBE");
  await hook(event("UNCANCELLATION", anna.id, t + 4000)).expect(200);
  assert.equal(await status(), "active");
  await hook(event("SUBSCRIPTION_PAUSED", anna.id, t + 5000)).expect(200);
  assert.equal(await status(), "paused");
  await hook(event("EXPIRATION", anna.id, t + 6000)).expect(200);
  assert.equal(await status(), "expired");
  assert.equal((await User.findOne({ phone: ANNA })).plus.active, false);
});

test("webhook: TRANSFER moves Plus from the old app user to the new one", async () => {
  const anna = await login(ANNA);
  const ben = await login(BEN);
  const t = Date.now();
  await hook(event("INITIAL_PURCHASE", anna.id, t, { product_id: "wannayap_plus_yearly", expiration_at_ms: t + 365 * DAY })).expect(200);
  const transfer = { id: "evt-transfer", type: "TRANSFER", store: "APP_STORE", environment: "PRODUCTION", event_timestamp_ms: t + 1000, transferred_from: [anna.id], transferred_to: [ben.id] };
  assert.equal((await hook(transfer).expect(200)).body.result, "ok");

  const from = await User.findOne({ phone: ANNA });
  assert.equal(from.plus.active, false);
  assert.equal(from.plus.status, "expired");
  const to = await User.findOne({ phone: BEN });
  assert.equal(to.plus.active, true);
  assert.equal(to.plus.source, "store");
  assert.equal(to.plus.status, "active");
  assert.equal(to.plus.productId, "wannayap_plus_yearly");
  assert.equal(to.plus.until.getTime(), t + 365 * DAY);
  assert.equal((await request(ctx.app).get("/me/plan").set(auth(ben.token))).body.plan, "plus");
  assert.equal((await request(ctx.app).get("/me/plan").set(auth(anna.token))).body.plan, "free");

  const stored = await SubscriptionEvent.findOne({ rcEventId: "evt-transfer" });
  assert.deepEqual(stored.transferredFrom, [anna.id]);
  assert.deepEqual(stored.transferredTo, [ben.id]);
  assert.equal(String(stored.userId), ben.id);
  assert.equal((await hook(transfer)).body.result, "duplicate");
  // Nobody we know on the receiving side
  assert.equal((await hook({ ...transfer, id: "evt-transfer-2", transferred_to: ["nobody"] })).body.result, "unknown_user");
});

test("webhook: TRANSFER without a known source asks RevenueCat, or grants Plus without end date and warns", async () => {
  const ben = await login(BEN);
  const t = Date.now();
  const transfer = (id) => ({ id, type: "TRANSFER", store: "APP_STORE", environment: "PRODUCTION", event_timestamp_ms: t, transferred_from: ["$RCAnonymousID:abc"], transferred_to: [ben.id] });

  // No key: Plus without end, the log says so
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    assert.equal((await hook(transfer("tr-1")).expect(200)).body.result, "ok");
  } finally {
    console.warn = warn;
  }
  let to = await User.findOne({ phone: BEN });
  assert.equal(to.plus.active, true);
  assert.equal(to.plus.until, null);
  assert.ok(warned.some((w) => w.includes("REVENUECAT_API_KEY")), warned.join("\n"));

  // With the key, the REST answer decides; a failing lookup keeps nothing, so the retry applies
  process.env.REVENUECAT_API_KEY = "rc-api-key";
  await User.updateOne({ phone: BEN }, { plus: { active: false, until: null, since: null, source: null, productId: null, eventAt: null, status: null } });
  const asked = [];
  revenuecat.setFetchSubscriber(async (id) => {
    asked.push(id);
    if (asked.length === 1) throw new Error("revenuecat_503");
    return { subscriptions: { wannayap_plus_yearly: { expires_date: new Date(t + 200 * DAY).toISOString(), period_type: "normal", is_sandbox: false, store: "app_store" } } };
  });
  await hook(transfer("tr-2")).expect(500);
  assert.equal(await SubscriptionEvent.countDocuments({ rcEventId: "tr-2" }), 0, "a failed event is not kept");
  assert.equal((await hook(transfer("tr-2")).expect(200)).body.result, "ok");
  assert.deepEqual(asked, [ben.id, ben.id]);
  to = await User.findOne({ phone: BEN });
  assert.equal(to.plus.active, true);
  assert.equal(to.plus.productId, "wannayap_plus_yearly");
  assert.equal(to.plus.until.getTime(), t + 200 * DAY);
  assert.equal(to.plus.status, "active");
});

test("sync: 501 without the key; with it, RevenueCat's answer sets Plus, sandbox included", async () => {
  const anna = await login(ANNA);
  const t = Date.now();
  await request(ctx.app).post("/me/plus/sync").expect(401);
  const off = await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(501);
  assert.deepEqual(off.body, { success: false, error: "not_configured" });

  process.env.REVENUECAT_API_KEY = "rc-api-key";
  let subscriber = null;
  const asked = [];
  revenuecat.setFetchSubscriber(async (id) => {
    asked.push(id);
    return subscriber;
  });

  // Never bought anything: free, nothing changes
  let body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plan, "free");
  assert.deepEqual(asked, [anna.id]);

  // Bought in the sandbox, trial period
  subscriber = { subscriptions: { wannayap_plus_monthly: { expires_date: new Date(t + 7 * DAY).toISOString(), period_type: "trial", is_sandbox: true, store: "app_store" } } };
  body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plan, "plus");
  assert.equal(body.plus.source, "sandbox");
  assert.equal(body.plus.productId, "wannayap_plus_monthly");
  assert.equal(body.userId, anna.id);
  assert.equal(body.limits.circles, 20);
  let user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.status, "trial");
  assert.equal(user.plus.until.getTime(), t + 7 * DAY);

  // Production, yearly ends later than monthly, cancelled: still Plus, status cancelled
  subscriber = {
    subscriptions: {
      wannayap_plus_monthly: { expires_date: new Date(t - DAY).toISOString(), period_type: "normal", is_sandbox: false },
      wannayap_plus_yearly: { expires_date: new Date(t + 300 * DAY).toISOString(), period_type: "normal", is_sandbox: false, unsubscribe_detected_at: new Date(t).toISOString() },
    },
  };
  body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plan, "plus");
  assert.equal(body.plus.source, "store");
  assert.equal(body.plus.productId, "wannayap_plus_yearly");
  assert.equal((await User.findOne({ phone: ANNA })).plus.status, "cancelled");

  // Everything expired: Plus ends
  subscriber = { subscriptions: { wannayap_plus_yearly: { expires_date: new Date(t - DAY).toISOString(), period_type: "normal", is_sandbox: false } } };
  body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plan, "free");
  user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.status, "expired");

  // RevenueCat down: 502, nothing changes
  revenuecat.setFetchSubscriber(async () => {
    throw new Error("revenuecat_500");
  });
  assert.equal((await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(502)).body.error, "revenuecat_unavailable");
});

test("sync: an admin grant without end and gift Plus are not overwritten by an expired store subscription", async () => {
  const anna = await login(ANNA);
  process.env.REVENUECAT_API_KEY = "rc-api-key";
  const t = Date.now();
  revenuecat.setFetchSubscriber(async () => ({ subscriptions: { wannayap_plus_monthly: { expires_date: new Date(t - DAY).toISOString(), period_type: "normal", is_sandbox: false } } }));
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: new Date(t + 10 * DAY), since: new Date(), source: "gift" } });
  let body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plan, "plus");
  assert.equal(body.plus.source, "gift");

  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: null, since: new Date(), source: "admin" } });
  revenuecat.setFetchSubscriber(async () => ({ subscriptions: { wannayap_plus_monthly: { expires_date: new Date(t + 30 * DAY).toISOString(), period_type: "normal", is_sandbox: false } } }));
  body = (await request(ctx.app).post("/me/plus/sync").set(auth(anna.token)).expect(200)).body;
  assert.equal(body.plus.source, "admin");
  assert.equal(body.plus.until, null);
});

test("events keep their user also when they change nothing: stale, admin grant kept", async () => {
  await login(ANNA, "Anna");
  const anna = await User.findOne({ phone: ANNA });
  const id = String(anna._id);
  // An admin grant without end stays: the store event is stored with its user all the same
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: null, since: new Date(), source: "admin" } });
  await hook(event("INITIAL_PURCHASE", id, Date.now(), { id: "evt-kept-1" })).expect(200);
  const kept = await SubscriptionEvent.findOne({ rcEventId: "evt-kept-1" }).lean();
  assert.equal(kept.result, "admin_grant_kept");
  assert.equal(String(kept.userId), id, "Apple's notifications of this subscription find the account through it (plan 2.6b)");
  // An event older than what the account already has: stale, but still Anna's
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: new Date(Date.now() + 30 * DAY), since: new Date(), source: "store", eventAt: new Date() } });
  await hook(event("RENEWAL", id, Date.now() - DAY, { id: "evt-stale-1" })).expect(200);
  const stale = await SubscriptionEvent.findOne({ rcEventId: "evt-stale-1" }).lean();
  assert.equal(stale.result, "stale");
  assert.equal(String(stale.userId), id);
});
