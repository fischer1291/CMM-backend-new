// App Store Server Notifications V2 (plan 2.6b, POST /webhooks/apple,
// lib/appleNotifications.js): only a JWS signed under the trusted root with
// Apple's marker extensions counts; every notification is stored once as a
// SubscriptionEvent with source "apple"; REFUND ends a store Plus of the
// same product and nothing else; CONSUMPTION_REQUEST is only answered with
// the App Store Server API configured and the flag on; refunds reported by
// both sources count once in MetricsDaily.plus.refunds. The certificates
// come from test/fixtures/apple/make.sh (a test root injected with
// setRootsForTests; production trusts only lib/appleRoot.js).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const opsCounters = require("../lib/opsCounters");
const apple = require("../lib/appleNotifications");
const { appleRootCaG3, APPLE_ROOT_CA_G3_SHA256 } = require("../lib/appleRoot");
const { applyEvent } = require("../routes/plus");
const { saveConfig, resetFlagsCache } = require("../lib/appConfig");
const { plusDay, todayKey } = require("../lib/metrics");
const { RULES } = require("../lib/alerts");

const FIX = path.join(__dirname, "fixtures", "apple");
const pem = (name) => fs.readFileSync(path.join(FIX, `${name}.pem`), "utf8");
const cert = (name) => new crypto.X509Certificate(pem(name));
const BUNDLE = "com.schly21.kontaktlisteapp";
const DAY = 24 * 3600 * 1000;

let ctx;
let sent = [];
before(async () => {
  ctx = await setup();
  apple.setRootsForTests([pem("root")]);
});
after(async () => {
  apple.setRootsForTests(null);
  apple.setSendConsumption(null);
  await teardown();
});
beforeEach(async () => {
  await reset();
  await SubscriptionEvent.syncIndexes();
  sent = [];
  apple.setSendConsumption(async (environment, transactionId, body) => {
    sent.push({ environment, transactionId, body });
  });
  delete process.env.ASC_ISSUER_ID;
  delete process.env.ASC_KEY_ID;
  delete process.env.ASC_PRIVATE_KEY;
  delete process.env.APPLE_BUNDLE_ID;
});

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const CHAIN = ["leaf", "intermediate", "root"];

/** A JWS like Apple's: ES256 with `key`'s leaf, x5c from the named fixture certificates. */
function jws(payload, { chain = CHAIN, key = chain[0], alg = "ES256" } = {}) {
  const head = b64({ alg, x5c: chain.map((name) => cert(name).raw.toString("base64")) });
  const body = b64(payload);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(FIX, `${key}.key`)));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** A signed notification with an optional signed transaction. */
function notification(type, { subtype, transaction, environment = "Production", bundleId = BUNDLE, uuid = crypto.randomUUID(), signedDate = Date.now(), ...signing } = {}) {
  const data = { bundleId, environment, appAppleId: 1234567890, bundleVersion: "42" };
  if (transaction) {
    data.signedTransactionInfo = jws({ bundleId, environment, signedDate, type: "Auto-Renewable Subscription", currency: "EUR", price: 4990, ...transaction }, signing);
  }
  return jws({ notificationType: type, subtype, notificationUUID: uuid, version: "2.0", signedDate, data }, signing);
}

const post = (signedPayload) => request(ctx.app).post("/webhooks/apple").send({ signedPayload });
const today = () => opsCounters.countsOf(todayKey(new Date()));
/** The webhook counts after its answer: wait for the counter. */
async function counted(name, n, ms = 2000) {
  const end = Date.now() + ms;
  while (((await today())[name] || 0) < n && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return (await today())[name] || 0;
}

let phoneN = 0;
const person = (plus = {}) =>
  User.create({
    phone: `+49152${String(++phoneN).padStart(7, "0")}`,
    plus: { active: true, since: new Date(Date.now() - 20 * DAY), until: new Date(Date.now() + 10 * DAY), source: "store", status: "active", productId: "wannayap_plus_monthly", ...plus },
  });
/** RevenueCat's INITIAL_PURCHASE for `user`, with Apple's original transaction id. */
const rcPurchase = (user, originalTransactionId, extra = {}) =>
  applyEvent({
    id: `rc-${crypto.randomUUID()}`,
    type: "INITIAL_PURCHASE",
    app_user_id: String(user._id),
    product_id: user.plus.productId,
    store: "APP_STORE",
    environment: "PRODUCTION",
    period_type: "NORMAL",
    price: 4.99,
    currency: "EUR",
    event_timestamp_ms: Date.now() - 20 * DAY,
    purchased_at_ms: Date.now() - 20 * DAY,
    expiration_at_ms: user.plus.until.getTime(),
    original_transaction_id: originalTransactionId,
    ...extra,
  });

test("appleRoot: the embedded Apple Root CA - G3 matches its fingerprint and parses; the test chain carries Apple's marker extensions", () => {
  assert.equal(appleRootCaG3.fingerprint256, APPLE_ROOT_CA_G3_SHA256);
  assert.match(appleRootCaG3.subject, /CN=Apple Root CA - G3/);
  assert.ok(appleRootCaG3.ca);
  assert.equal(apple.extensionOids(appleRootCaG3).size > 0, true, "the DER walk reads the real root");
  assert.ok(apple.extensionOids(cert("leaf")).has(apple.LEAF_OID));
  assert.ok(apple.extensionOids(cert("intermediate")).has(apple.INTERMEDIATE_OID));
  assert.ok(!apple.extensionOids(cert("plain-leaf")).has(apple.LEAF_OID));
  // Outside the tests no other root can be injected
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => apple.setRootsForTests([pem("foreign-root")]), /tests only/);
  } finally {
    process.env.NODE_ENV = env;
  }
});

test("verifyJws: a valid chain and signature give the payload; tampering, a foreign root, a missing OID, another alg or an expired chain are refused", () => {
  const roots = [cert("root")];
  const reason = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof apple.JwsError, err.message);
      return err.reason;
    }
    return "accepted";
  };
  const good = jws({ hello: "welt", signedDate: Date.now() });
  assert.deepEqual(apple.verifyJws(good, { roots }).hello, "welt");
  // Without the root in x5c (leaf and intermediate only) it still chains to ours
  assert.equal(apple.verifyJws(jws({ a: 1 }, { chain: ["leaf", "intermediate"] }), { roots }).a, 1);

  const [h, , s] = good.split(".");
  assert.equal(reason(() => apple.verifyJws(`${h}.${b64({ hello: "geld", signedDate: Date.now() })}.${s}`, { roots })), "signature");
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1 }, { chain: ["foreign-leaf", "foreign-intermediate", "foreign-root"] }), { roots })), "untrusted_root");
  // A foreign chain that claims our root as its third certificate still doesn't chain to it
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1 }, { chain: ["foreign-leaf", "foreign-intermediate", "root"] }), { roots })), "untrusted_root");
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1 }, { chain: ["plain-leaf", "intermediate", "root"] }), { roots })), "apple_oid");
  // Signed with another key than the leaf's
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1 }, { key: "plain-leaf" }), { roots })), "signature");
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1 }, { alg: "ES384" }), { roots })), "alg");
  // Signed (says the payload) before the certificates were valid
  assert.equal(reason(() => apple.verifyJws(jws({ a: 1, signedDate: Date.now() - 400 * DAY }), { roots })), "expired");
  assert.equal(reason(() => apple.verifyJws("kein.jws", { roots })), "format");
  assert.equal(reason(() => apple.verifyJws(undefined, { roots })), "format");
  // The production root knows nothing of the test chain
  assert.equal(reason(() => apple.verifyJws(good, { roots: [appleRootCaG3] })), "untrusted_root");
});

test("webhook: a verified notification is stored once with source apple and found its user through RevenueCat's original transaction id", async () => {
  const user = await person();
  await rcPurchase(user, "2000000111");
  const rc = await SubscriptionEvent.findOne({ source: "revenuecat" }).lean();
  assert.equal(rc.originalTransactionId, "2000000111", "RevenueCat events keep original_transaction_id");

  const uuid = crypto.randomUUID();
  const signedDate = Date.now() - 60 * 1000;
  const body = notification("DID_RENEW", {
    uuid,
    signedDate,
    transaction: { originalTransactionId: "2000000111", transactionId: "2000000222", productId: "wannayap_plus_monthly", purchaseDate: signedDate, expiresDate: signedDate + 30 * DAY },
  });
  const res = await post(body).expect(200);
  assert.equal(res.body.result, "stored");
  const stored = await SubscriptionEvent.findOne({ source: "apple" }).lean();
  assert.equal(stored.rcEventId, `apple:${uuid}`);
  assert.equal(stored.type, "DID_RENEW");
  assert.equal(String(stored.userId), String(user._id));
  assert.equal(stored.originalTransactionId, "2000000111");
  assert.equal(stored.productId, "wannayap_plus_monthly");
  assert.equal(stored.environment, "PRODUCTION");
  assert.equal(stored.priceCents, 499);
  assert.equal(stored.currency, "EUR");
  assert.equal(stored.eventAt.getTime(), signedDate);
  assert.equal(stored.expirationAt.getTime(), signedDate + 30 * DAY);
  assert.equal(stored.result, "stored");

  // Apple's retry: harmless
  assert.equal((await post(body).expect(200)).body.result, "duplicate");
  assert.equal(await SubscriptionEvent.countDocuments({ source: "apple" }), 1);
  // RevenueCat stays primary: Plus is untouched by anything but a refund
  const after = await User.findById(user._id).lean();
  assert.equal(after.plus.active, true);
  assert.equal(after.plus.until.getTime(), user.plus.until.getTime());

  // A subtype is kept after a colon; a sandbox notification is stored as SANDBOX
  await post(notification("SUBSCRIBED", { subtype: "RESUBSCRIBE", environment: "Sandbox", transaction: { originalTransactionId: "2000000111", productId: "wannayap_plus_monthly" } })).expect(200);
  const sub = await SubscriptionEvent.findOne({ type: "SUBSCRIBED:RESUBSCRIBE" }).lean();
  assert.equal(sub.environment, "SANDBOX");
  assert.equal(await counted("appleUnknownUser", 0), 0);
});

test("webhook: wrong signature, foreign root, wrong bundle id or environment: 401, nothing stored, appleUnverified counted; no JWS at all: appleMalformed", async () => {
  const transaction = { originalTransactionId: "1", productId: "wannayap_plus_monthly" };
  const good = notification("DID_RENEW", { transaction });
  const [h, , s] = good.split(".");
  const tampered = `${h}.${b64({ notificationType: "REFUND", notificationUUID: "x", signedDate: Date.now(), data: { bundleId: BUNDLE, environment: "Production" } })}.${s}`;
  const refused = [
    tampered,
    notification("DID_RENEW", { transaction, chain: ["foreign-leaf", "foreign-intermediate", "foreign-root"] }),
    notification("DID_RENEW", { transaction, bundleId: "com.example.other" }),
    notification("DID_RENEW", { transaction, environment: "Xcode" }),
    notification("DID_RENEW", { transaction, chain: ["plain-leaf", "intermediate", "root"] }),
  ];
  for (const body of refused) {
    const res = await post(body).expect(401);
    assert.equal(res.body.error, "unverified");
  }
  // Scanners and stray requests: refused too, but counted apart (no alert)
  await request(ctx.app).post("/webhooks/apple").send({}).expect(401);
  await post("a.b.c").expect(401);
  await post(`${b64({ alg: "ES256", x5c: ["kaputt"] })}.${b64({ a: 1 })}.AAAA`).expect(401);
  await request(ctx.app).post("/webhooks/apple").set("Content-Type", "application/json").send("{kaputt").expect(400);
  assert.equal(await counted("appleUnverified", 5), 5);
  assert.equal(await counted("appleMalformed", 3), 3);
  assert.equal(await SubscriptionEvent.countDocuments({}), 0);

  // A transaction signed for another app inside a notification for ours
  const data = { bundleId: BUNDLE, environment: "Production", signedTransactionInfo: jws({ bundleId: "com.example.other", environment: "Production", originalTransactionId: "1" }) };
  await post(jws({ notificationType: "DID_RENEW", notificationUUID: crypto.randomUUID(), signedDate: Date.now(), data })).expect(401);
  // APPLE_BUNDLE_ID decides which app is ours
  process.env.APPLE_BUNDLE_ID = "com.example.other";
  await post(notification("DID_RENEW", { transaction: { originalTransactionId: "1" }, bundleId: "com.example.other" })).expect(200);
});

test("REFUND: ends a store Plus of the same product in the running period, nothing else", async () => {
  const anna = await person();
  const ben = await person({ productId: "wannayap_plus_yearly", until: new Date(Date.now() + 300 * DAY) });
  const carl = await person({ source: "referral", status: null });
  const dora = await person();
  await rcPurchase(anna, "3000000001");
  await rcPurchase(ben, "3000000002");
  await rcPurchase(dora, "3000000004");
  // Carl's Plus is a gift; an old store purchase of his sits in the history
  await SubscriptionEvent.create({ rcEventId: "old-carl", userId: carl._id, type: "EXPIRATION", originalTransactionId: "3000000003", eventAt: new Date(Date.now() - 60 * DAY) });

  const now = Date.now();
  const refundOf = (originalTransactionId, productId, expiresDate) =>
    notification("REFUND", {
      transaction: { originalTransactionId, transactionId: `${originalTransactionId}9`, productId, purchaseDate: now - 20 * DAY, expiresDate, revocationDate: now - 1000, revocationReason: 0 },
    });
  const res = await post(refundOf("3000000001", "wannayap_plus_monthly", now + 10 * DAY)).expect(200);
  assert.equal(res.body.result, "refunded");
  const a = await User.findById(anna._id).lean();
  assert.equal(a.plus.active, false);
  assert.equal(a.plus.status, "expired");
  assert.equal(a.plus.until.getTime(), now - 1000);
  assert.equal(a.plus.source, "store");
  const stored = await SubscriptionEvent.findOne({ source: "apple", type: "REFUND" }).lean();
  assert.equal(stored.cancelReason, "OTHER");
  assert.equal(String(stored.userId), String(anna._id));

  // Another product than the running one
  assert.equal((await post(refundOf("3000000002", "wannayap_plus_monthly", now + 10 * DAY)).expect(200)).body.result, "refund_other_product");
  assert.equal((await User.findById(ben._id).lean()).plus.active, true);
  // A gifted Plus isn't the store's
  assert.equal((await post(refundOf("3000000003", "wannayap_plus_monthly", now - 30 * DAY)).expect(200)).body.result, "refund_not_store");
  assert.equal((await User.findById(carl._id).lean()).plus.active, true);
  // An earlier month refunded while a later one runs
  assert.equal((await post(refundOf("3000000004", "wannayap_plus_monthly", now - 20 * DAY)).expect(200)).body.result, "refund_earlier_period");
  assert.equal((await User.findById(dora._id).lean()).plus.active, true);
  // A sandbox refund doesn't end a production Plus
  const dSandbox = await post(notification("REFUND", { environment: "Sandbox", transaction: { originalTransactionId: "3000000004", productId: "wannayap_plus_monthly", expiresDate: now + 10 * DAY } })).expect(200);
  assert.equal(dSandbox.body.result, "refund_not_store");
});

test("unknown transaction: stored as unknown_user and counted; the alert apple_notifications names it once it stays unassigned for 30 minutes", async () => {
  const rule = RULES.find((r) => r.tag === "apple_notifications");
  assert.equal(rule.level, "warn");
  assert.equal(await rule.check(new Date()), null);

  const res = await post(notification("DID_RENEW", { transaction: { originalTransactionId: "9999", productId: "wannayap_plus_monthly" } })).expect(200);
  assert.equal(res.body.result, "unknown_user");
  const stored = await SubscriptionEvent.findOne({ source: "apple" }).lean();
  assert.equal(stored.userId, null);
  assert.equal(stored.result, "unknown_user");
  assert.equal(await counted("appleUnknownUser", 1), 1);
  // TEST notifications name no transaction: stored, not unknown
  assert.equal((await post(notification("TEST")).expect(200)).body.result, "stored");
  assert.equal(await counted("appleUnknownUser", 1), 1);

  // RevenueCat may still be on its way: no alert in the first 30 minutes
  assert.equal(await rule.check(new Date()), null);
  await SubscriptionEvent.updateOne({ _id: stored._id }, { createdAt: new Date(Date.now() - 31 * 60 * 1000) });
  let text = await rule.check(new Date());
  assert.match(text, /1× seit über 30 Minuten keinem Konto zuzuordnen/);
  // Scanners never alert
  await request(ctx.app).post("/webhooks/apple").send({}).expect(401);
  await counted("appleMalformed", 1);
  assert.doesNotMatch(await rule.check(new Date()), /nicht prüfbar/);
  await post(notification("DID_RENEW", { bundleId: "com.example.other" })).expect(401);
  await counted("appleUnverified", 1);
  text = await rule.check(new Date());
  assert.match(text, /heute 1× nicht prüfbar abgelehnt/);
  assert.match(text, /1× seit über 30 Minuten keinem Konto/);

  // The appAccountToken convention: our user id padded to a UUID
  const user = await person();
  const hex = `00000000${String(user._id)}`;
  const token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.equal(apple.userIdOfToken(token), String(user._id));
  assert.equal(apple.userIdOfToken(crypto.randomUUID()), null);
  assert.equal((await post(notification("DID_RENEW", { transaction: { originalTransactionId: "8888", appAccountToken: token } })).expect(200)).body.result, "stored");
  assert.equal(String((await SubscriptionEvent.findOne({ originalTransactionId: "8888" }).lean()).userId), String(user._id));
});

test("CONSUMPTION_REQUEST: stored and counted; answered only with the App Store Server API configured and the flag on, with the talk minutes since the purchase", async () => {
  const user = await person();
  await rcPurchase(user, "4000000001");
  const purchased = Date.now() - 5 * DAY;
  await Talk.create([
    { callId: "c1", participants: [user.phone, "+4915999999999"], startedAt: new Date(purchased + DAY), seconds: 20 * 60 },
    { callId: "c2", participants: [user.phone, "+4915999999998"], startedAt: new Date(purchased + 2 * DAY), seconds: 25 * 60 },
    // Before the purchase: not counted
    { callId: "c0", participants: [user.phone, "+4915999999998"], startedAt: new Date(purchased - DAY), seconds: 600 * 60 },
  ]);
  const request1 = () =>
    notification("CONSUMPTION_REQUEST", { transaction: { originalTransactionId: "4000000001", transactionId: "4000000777", productId: "wannayap_plus_monthly", purchaseDate: purchased, expiresDate: purchased + 30 * DAY } });

  // Nothing configured: stored and counted, no answer
  assert.equal((await post(request1()).expect(200)).body.result, "consumption_request");
  assert.equal(await counted("appleConsumptionRequest", 1), 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);
  assert.equal(await SubscriptionEvent.countDocuments({ source: "apple", type: "CONSUMPTION_REQUEST" }), 1);

  // Configured, flag off (the default): still no answer
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.ASC_ISSUER_ID = "57246542-96fe-1a63-e053-0824d011072a";
  process.env.ASC_KEY_ID = "2X9R4HXF34";
  process.env.ASC_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
  await post(request1()).expect(200);
  assert.equal(await counted("appleConsumptionRequest", 2), 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);

  // Flag on: answered
  await saveConfig({ flags: { apple_consumption: true } }, "owner@example.com");
  resetFlagsCache();
  await post(request1()).expect(200);
  assert.equal(await counted("appleConsumptionSent", 1), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].environment, "PRODUCTION");
  assert.equal(sent[0].transactionId, "4000000777");
  assert.equal(sent[0].body.customerConsented, true);
  assert.equal(sent[0].body.consumptionStatus, 2);
  assert.equal(sent[0].body.playTime, 2, "45 minutes: 5-60 min");
  assert.equal(sent[0].body.platform, 1);
  assert.equal(sent[0].body.accountTenure, 1);

  // The App Store Server API token: ES256 with the configured key, for our bundle
  const token = apple.ascToken(new Date());
  const [h, p, s] = token.split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.bid, BUNDLE);
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).kid, "2X9R4HXF34");

  // A failing answer is counted, the webhook still answered 200
  apple.setSendConsumption(async () => {
    throw new Error("app_store_api_500");
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await post(request1()).expect(200);
    assert.equal(await counted("appleConsumptionFailed", 1), 1);
  } finally {
    console.error = original;
  }
  // ... and raises the alert: Apple waits twelve hours for an answer
  assert.match(await RULES.find((r) => r.tag === "apple_notifications").check(new Date()), /heute 1× Antwort auf CONSUMPTION_REQUEST fehlgeschlagen/);
});

test("Apple before RevenueCat: the notification waits as unknown_user and gets its user from RevenueCat's event (resolved_late), no alert", async () => {
  const rule = RULES.find((r) => r.tag === "apple_notifications");
  const user = await person();
  const buy = notification("SUBSCRIBED", { subtype: "INITIAL_BUY", transaction: { originalTransactionId: "5000000001", transactionId: "5000000001", productId: "wannayap_plus_monthly" } });
  assert.equal((await post(buy).expect(200)).body.result, "unknown_user");
  const early = await SubscriptionEvent.findOne({ source: "apple" });
  // Even if RevenueCat took longer than the grace period
  await SubscriptionEvent.updateOne({ _id: early._id }, { createdAt: new Date(Date.now() - 40 * 60 * 1000) });
  assert.match(await rule.check(new Date()), /keinem Konto zuzuordnen/);

  await rcPurchase(user, "5000000001");
  const resolved = await SubscriptionEvent.findById(early._id).lean();
  assert.equal(String(resolved.userId), String(user._id));
  assert.equal(resolved.result, "resolved_late");
  assert.equal(await rule.check(new Date()), null);
  // The next notification of the subscription finds the user directly
  assert.equal((await post(notification("DID_RENEW", { transaction: { originalTransactionId: "5000000001", productId: "wannayap_plus_monthly" } })).expect(200)).body.result, "stored");

  // A RevenueCat event that changes nothing (stale) still assigns the user
  const other = await person({ eventAt: new Date() });
  await post(notification("DID_RENEW", { transaction: { originalTransactionId: "5000000002", productId: "wannayap_plus_monthly" } })).expect(200);
  const stale = await applyEvent({
    id: `rc-${crypto.randomUUID()}`,
    type: "RENEWAL",
    app_user_id: String(other._id),
    product_id: "wannayap_plus_monthly",
    environment: "PRODUCTION",
    event_timestamp_ms: Date.now() - 400 * DAY,
    original_transaction_id: "5000000002",
  });
  assert.equal(stale.result, "stale");
  assert.equal(String((await SubscriptionEvent.findOne({ source: "apple", originalTransactionId: "5000000002" }).lean()).userId), String(other._id));
  // Another subscription's waiting event stays as it is
  assert.equal(await apple.resolveLate("nichts", other._id), 0);
});

test("REFUND: a RevenueCat event applied between reading and writing isn't overwritten", async () => {
  const user = await person({ eventAt: new Date(Date.now() - 20 * DAY) });
  await rcPurchase(user, "6000000001");
  const now = Date.now();
  const decoded = apple.decodeNotification(
    notification("REFUND", { transaction: { originalTransactionId: "6000000001", transactionId: "6000000002", productId: "wannayap_plus_monthly", expiresDate: now + 10 * DAY, revocationDate: now - 1000 } }),
  );
  // RevenueCat renews to the yearly product while the refund is decided: the guarded write misses, the second look sees another product
  const original = User.findOneAndUpdate.bind(User);
  let raced = false;
  User.findOneAndUpdate = async (...args) => {
    if (!raced) {
      raced = true;
      await User.updateOne({ _id: user._id }, { "plus.productId": "wannayap_plus_yearly", "plus.eventAt": new Date(now) });
    }
    return original(...args);
  };
  try {
    assert.equal((await apple.handleNotification(decoded)).result, "refund_other_product");
    assert.ok(raced);
  } finally {
    User.findOneAndUpdate = original;
  }
  const after = await User.findById(user._id).lean();
  assert.equal(after.plus.active, true);
  assert.equal(after.plus.productId, "wannayap_plus_yearly");
});

test("refunds in MetricsDaily.plus: RevenueCat's CUSTOMER_SUPPORT cancellation and Apple's REFUND for the same subscription count once", async () => {
  const from = new Date("2026-09-28T22:00:00Z");
  const to = new Date("2026-09-29T22:00:00Z");
  const at = (h) => new Date(from.getTime() + h * 3600 * 1000);
  const rcRefund = (id, otid, eventAt) => ({ rcEventId: id, type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", originalTransactionId: otid, eventAt, source: "revenuecat" });
  const appleRefund = (id, otid, eventAt, extra = {}) => ({ rcEventId: `apple:${id}`, type: "REFUND", originalTransactionId: otid, eventAt, source: "apple", ...extra });
  await SubscriptionEvent.create([
    // A: both sources, RevenueCat first: one
    rcRefund("rc-a", "A", at(2)),
    appleRefund("a", "A", at(3)),
    // B: both, Apple first: one
    appleRefund("b", "B", at(4)),
    rcRefund("rc-b", "B", at(5)),
    // C: Apple only; D: RevenueCat from before the field (no original transaction id)
    appleRefund("c", "C", at(6)),
    rcRefund("rc-d", null, at(7)),
    // E: a sandbox refund never counts
    appleRefund("e", "E", at(8), { environment: "SANDBOX" }),
    // F: RevenueCat yesterday, Apple today: yesterday's, not today's
    rcRefund("rc-f", "F", new Date(from.getTime() - 3600 * 1000)),
    appleRefund("f", "F", at(1)),
    // G: the same instant: Apple's counts
    rcRefund("rc-g", "G", at(9)),
    appleRefund("g", "G", at(9)),
    // Apple's other types never count as RevenueCat's (RevenueCat stays primary)
    { rcEventId: "apple:renew", type: "DID_RENEW", originalTransactionId: "H", eventAt: at(10), source: "apple" },
    { rcEventId: "apple:expired", type: "EXPIRED:VOLUNTARY", originalTransactionId: "H", eventAt: at(10), source: "apple" },
  ]);
  const day = await plusDay(from, to, new Date("2026-09-30T10:00:00Z"));
  // A, B, C, D, G (F belongs to the day before); RevenueCat's cancellations count as cancelled as before
  assert.equal(day.refunds, 5);
  assert.equal(day.cancelled, 4);
  assert.equal(day.renewed, 0);
  assert.equal(day.expired, 0);
  const before = await plusDay(new Date(from.getTime() - DAY), from, new Date("2026-09-30T10:00:00Z"));
  assert.equal(before.refunds, 1);
});
