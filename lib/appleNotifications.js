/**
 * App Store Server Notifications V2 (plan 2.6b): Apple's own signed word on
 * a subscription, the second source next to RevenueCat, which stays the
 * primary one for User.plus. POST /webhooks/apple (routes/webhooks.js) hands
 * the body here:
 *
 * - verifyJws checks a JWS the way Apple's own libraries do, with
 *   node:crypto alone: alg ES256, the x5c chain leaf -> intermediate ->
 *   Apple Root CA - G3 (embedded in lib/appleRoot.js, never the root the
 *   payload brings), every certificate valid at the payload's signedDate,
 *   Apple's marker extensions on leaf (1.2.840.113635.100.6.11.1) and
 *   intermediate (1.2.840.113635.100.6.2.1), then the signature with the
 *   leaf's P-256 key. decodeNotification does that for the notification
 *   and its signedTransactionInfo / signedRenewalInfo and checks bundle id
 *   (APPLE_BUNDLE_ID) and environment.
 * - handleNotification stores every notification as a SubscriptionEvent
 *   (source "apple", rcEventId "apple:<notificationUUID>", so Apple's
 *   retries are duplicates) and finds the user through the newest event of
 *   the same originalTransactionId (RevenueCat's events carry it too), else
 *   the transaction's appAccountToken. Apple often notifies seconds before
 *   RevenueCat does (INITIAL_BUY, renewals of subscriptions older than the
 *   field), so such an event waits as unknown_user until RevenueCat's event
 *   of the same originalTransactionId arrives: resolveLate (called from
 *   routes/plus.js) then fills in its userId (result resolved_late).
 *   REFUND ends a store Plus of the same product; CONSUMPTION_REQUEST is
 *   counted and, only with the App Store Server API configured AND the
 *   flag apple_consumption on, answered with the talk minutes since the
 *   purchase. Every other type is only stored.
 *
 * Day counters (lib/opsCounters.js): appleUnverified (a JWS-shaped payload
 * that didn't verify), appleMalformed (not even a JWS with a certificate
 * chain: scanners, no alert), appleUnknownUser, appleConsumptionRequest,
 * appleConsumptionSent, appleConsumptionFailed. The alert
 * apple_notifications (lib/alerts.js) reads appleUnverified,
 * appleConsumptionFailed and the events still unassigned after 30 minutes
 * (unassignedSince), not the raw appleUnknownUser.
 * README "App Store Server Notifications".
 */
const crypto = require("crypto");
const { X509Certificate } = crypto;
const mongoose = require("mongoose");
const User = require("../models/User");
const Talk = require("../models/Talk");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const { appleRootCaG3 } = require("./appleRoot");
const { flag } = require("./appConfig");
const { talksOf } = require("./stats");
const { STORE_SOURCES } = require("./plusReconcile");

const DEFAULT_BUNDLE_ID = "com.schly21.kontaktlisteapp";
const bundleId = () => process.env.APPLE_BUNDLE_ID || DEFAULT_BUNDLE_ID;

// Apple's marker extensions: "Apple Worldwide Developer Relations" on the
// intermediate, "App Store receipt signing" on the leaf
const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const ENVIRONMENTS = { Production: "PRODUCTION", Sandbox: "SANDBOX" };
const CONSUMPTION_FLAG = "apple_consumption";
const DAY_MS = 24 * 3600 * 1000;
// Refusals that aren't even a JWS with a parseable chain: scanners and
// stray requests, counted as appleMalformed without an alert
const MALFORMED_REASONS = new Set(["format", "header", "payload", "x5c", "certificate"]);
// How long a notification may wait for RevenueCat's event of the same
// subscription before the alert counts it as unassigned
const UNASSIGNED_GRACE_MS = 30 * 60 * 1000;

// --- Trust ---------------------------------------------------------------------

let roots = [appleRootCaG3];

/**
 * Tests only: trust these PEM certificates instead of Apple's root (null
 * restores it). Refused outside NODE_ENV=test, so no running server can
 * be talked into another root.
 */
function setRootsForTests(pems) {
  if (process.env.NODE_ENV !== "test") throw new Error("setRootsForTests is for tests only");
  roots = pems ? pems.map((pem) => new X509Certificate(pem)) : [appleRootCaG3];
}

class JwsError extends Error {
  constructor(reason) {
    super(`apple_jws_${reason}`);
    this.reason = reason;
  }
}
const fail = (reason) => {
  throw new JwsError(reason);
};

// --- A little DER, enough to list a certificate's extensions ---------------------

/** The TLV at `offset` of `buf`: { tag, start (of the content), end }. */
function tlv(buf, offset) {
  if (offset + 2 > buf.length) fail("certificate");
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    if (bytes < 1 || bytes > 3 || start + bytes > buf.length) fail("certificate");
    len = 0;
    for (let i = 0; i < bytes; i++) len = len * 256 + buf[start + i];
    start += bytes;
  }
  const end = start + len;
  if (end > buf.length) fail("certificate");
  return { tag, start, end };
}

/** The TLVs directly inside the constructed TLV `outer`. */
function children(buf, outer) {
  const out = [];
  for (let at = outer.start; at < outer.end; ) {
    const child = tlv(buf, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

/** An OBJECT IDENTIFIER's content bytes as "1.2.840...". */
function oidString(bytes) {
  const parts = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  if (!parts.length) return "";
  const first = parts[0] < 80 ? Math.floor(parts[0] / 40) : 2;
  return [first, parts[0] - first * 40, ...parts.slice(1)].join(".");
}

/** The extension ids (dotted) of a certificate: tbsCertificate's [3] block. */
function extensionOids(cert) {
  const der = cert.raw;
  const certificate = tlv(der, 0);
  const tbs = children(der, certificate)[0];
  if (!tbs || tbs.tag !== 0x30) fail("certificate");
  const block = children(der, tbs).find((c) => c.tag === 0xa3);
  if (!block) return new Set();
  const list = children(der, block)[0];
  const oids = new Set();
  for (const ext of list ? children(der, list) : []) {
    const id = children(der, ext)[0];
    if (id?.tag === 0x06) oids.add(oidString(der.subarray(id.start, id.end)));
  }
  return oids;
}

// --- JWS -------------------------------------------------------------------------

const json = (part, reason) => {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") fail(reason);
    return value;
  } catch (err) {
    if (err instanceof JwsError) throw err;
    return fail(reason);
  }
};
const validAt = (cert, at) => (cert.validFromDate || new Date(cert.validFrom)) <= at && at <= (cert.validToDate || new Date(cert.validTo));

/**
 * Verify one JWS from Apple and return its payload; throws a JwsError
 * (err.reason) otherwise. The certificates must be valid at the payload's
 * signedDate (Apple's choice too: a notification signed before a renewal
 * of the leaf stays verifiable), `now` when it has none.
 */
function verifyJws(jws, { roots: trusted = roots, now = new Date() } = {}) {
  if (typeof jws !== "string" || jws.length > 64 * 1024) fail("format");
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail("format");
  const header = json(parts[0], "header");
  if (header.alg !== "ES256") fail("alg");
  if (!Array.isArray(header.x5c) || header.x5c.length < 2 || header.x5c.length > 3 || header.x5c.some((c) => typeof c !== "string")) fail("x5c");
  let certs;
  try {
    certs = header.x5c.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch {
    fail("certificate");
  }
  const payload = json(parts[1], "payload");
  const at = typeof payload.signedDate === "number" && Number.isFinite(payload.signedDate) ? new Date(payload.signedDate) : now;

  // Apple sends leaf, intermediate and its root; the root that counts is ours
  if (certs.length === 3) {
    if (!trusted.some((r) => r.fingerprint256 === certs[2].fingerprint256)) fail("untrusted_root");
    certs = certs.slice(0, 2);
  }
  const [leaf, intermediate] = certs;
  const root = trusted.find((r) => intermediate.checkIssued(r) && intermediate.verify(r.publicKey));
  if (!root) fail("untrusted_root");
  if (!intermediate.ca || leaf.ca) fail("chain");
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) fail("chain");
  if (![leaf, intermediate, root].every((c) => validAt(c, at))) fail("expired");
  if (!extensionOids(leaf).has(LEAF_OID) || !extensionOids(intermediate).has(INTERMEDIATE_OID)) fail("apple_oid");
  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("leaf_key");
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length !== 64) fail("signature");
  const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, signature);
  if (!ok) fail("signature");
  return payload;
}

/**
 * The verified notification: { payload, transaction, renewal, environment }
 * (environment PRODUCTION or SANDBOX). Throws a JwsError when anything
 * doesn't check out, bundle id and environment included.
 */
function decodeNotification(signedPayload, { roots: trusted = roots, now = new Date() } = {}) {
  const payload = verifyJws(signedPayload, { roots: trusted, now });
  if (typeof payload.notificationType !== "string" || !payload.notificationType) fail("notification_type");
  // Summary notifications (RENEWAL_EXTENSION for many subscribers) carry `summary` instead of `data`
  const meta = payload.data || payload.summary || {};
  if (meta.bundleId !== bundleId()) fail("bundle_id");
  const environment = ENVIRONMENTS[meta.environment];
  if (!environment) fail("environment");
  const inner = (jws) => {
    if (!jws) return null;
    const decoded = verifyJws(jws, { roots: trusted, now });
    if (decoded.bundleId != null && decoded.bundleId !== bundleId()) fail("bundle_id");
    if (decoded.environment != null && ENVIRONMENTS[decoded.environment] !== environment) fail("environment");
    return decoded;
  };
  const transaction = inner(payload.data?.signedTransactionInfo);
  const renewal = inner(payload.data?.signedRenewalInfo);
  return { payload, transaction, renewal, environment };
}

// --- Mapping ---------------------------------------------------------------------

const dateOf = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null);
// Apple's prices are milliunits of the purchase currency
const centsOf = (milli) => (typeof milli === "number" && Number.isFinite(milli) ? Math.round(milli / 10) : null);
const REVOCATION = { 0: "OTHER", 1: "APP_ISSUE" };

/** SubscriptionEvent.type of a notification: "REFUND", "SUBSCRIBED:INITIAL_BUY", ... */
const typeOf = (payload) => (payload.subtype ? `${payload.notificationType}:${payload.subtype}` : payload.notificationType);

/** The SubscriptionEvent fields of a verified notification (nothing of the raw payload beyond them). */
function mapToEvent({ payload, transaction, renewal, environment }, now = new Date()) {
  const t = transaction || {};
  const uuid = typeof payload.notificationUUID === "string" && payload.notificationUUID ? payload.notificationUUID.slice(0, 64) : null;
  const price = centsOf(t.price);
  return {
    rcEventId: `apple:${uuid || crypto.createHash("sha256").update(JSON.stringify([payload.notificationType, payload.subtype, payload.signedDate, t.transactionId])).digest("hex")}`,
    source: "apple",
    type: typeOf(payload),
    originalTransactionId: t.originalTransactionId || renewal?.originalTransactionId || null,
    appUserId: t.appAccountToken || null,
    productId: t.productId || renewal?.productId || null,
    store: "APP_STORE",
    environment,
    periodType: t.offerDiscountType === "FREE_TRIAL" ? "TRIAL" : t.offerType ? "OFFER" : t.type === "Auto-Renewable Subscription" ? "NORMAL" : null,
    // Apple sends the price in the purchase currency only (no USD)
    priceCents: price,
    priceInPurchasedCurrencyCents: price,
    currency: t.currency || null,
    cancelReason: t.revocationReason != null ? REVOCATION[t.revocationReason] || "OTHER" : null,
    expirationAt: dateOf(t.expiresDate),
    purchasedAt: dateOf(t.purchaseDate),
    eventAt: dateOf(payload.signedDate) || now,
  };
}

// --- Users -----------------------------------------------------------------------

/**
 * appAccountToken is a UUID the app may set on a purchase. The app sets
 * none today (RevenueCat identifies by app user id); should it ever, the
 * convention is our user id padded to a UUID: "00000000-" + the 24 hex
 * digits of the ObjectId, dashed as a UUID.
 */
function userIdOfToken(token) {
  const hex = typeof token === "string" ? token.replace(/-/g, "").toLowerCase() : "";
  if (!/^0{8}[0-9a-f]{24}$/.test(hex)) return null;
  const id = hex.slice(8);
  return mongoose.isValidObjectId(id) ? id : null;
}

/** The user of a notification: the newest event of the same original transaction, else the token. */
async function userFor(fields) {
  if (fields.originalTransactionId) {
    const known = await SubscriptionEvent.findOne({ originalTransactionId: fields.originalTransactionId, userId: { $ne: null } }, { userId: 1 })
      .sort({ eventAt: -1, createdAt: -1 })
      .lean();
    const user = known && (await User.findById(known.userId));
    if (user) return user;
  }
  const id = userIdOfToken(fields.appUserId);
  return id ? User.findById(id) : null;
}

/**
 * REFUND: Apple took the money back, so the Plus it paid for ends, but
 * only a store Plus (source store, or sandbox for a sandbox refund) of the
 * same product, and only when the refunded transaction is the running
 * period (a refund of an earlier month while a later one runs revokes only
 * that month). Anything else stays as RevenueCat set it. The write is
 * guarded by the plus.eventAt it was decided on, so a RevenueCat event
 * applied in between isn't overwritten: then it decides again on the new
 * state, and after a second conflict it throws (500, Apple retries).
 */
async function refund(user, decoded, fields) {
  const source = decoded.environment === "SANDBOX" ? "sandbox" : "store";
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = user.plus || {};
    if (!p.active || p.source !== source || !STORE_SOURCES.includes(p.source)) return { result: "refund_not_store", user, users: [] };
    if (fields.productId && p.productId && fields.productId !== p.productId) return { result: "refund_other_product", user, users: [] };
    if (fields.expirationAt && p.until && p.until.getTime() - fields.expirationAt.getTime() > DAY_MS) return { result: "refund_earlier_period", user, users: [] };
    const revokedAt = dateOf(decoded.transaction?.revocationDate) || fields.eventAt;
    const eventAt = p.eventAt && p.eventAt > fields.eventAt ? p.eventAt : fields.eventAt;
    const updated = await User.findOneAndUpdate(
      { _id: user._id, "plus.active": true, "plus.source": source, "plus.eventAt": p.eventAt || null },
      { $set: { "plus.active": false, "plus.status": "expired", "plus.until": revokedAt, "plus.eventAt": eventAt } },
      { new: true },
    );
    if (updated) return { result: "refunded", user: updated, users: [updated] };
    user = await User.findById(user._id);
    if (!user) return { result: "unknown_user", user: null, users: [] };
  }
  throw new Error("apple_refund_conflict");
}

/**
 * RevenueCat's event of subscription `originalTransactionId` found `userId`
 * (routes/plus.js applyEvent): Apple's notifications of it that came first
 * and found nobody get that user now (result resolved_late). Only the
 * assignment is late: a REFUND RevenueCat revokes itself, a CONSUMPTION_REQUEST
 * stays unanswered. Returns how many it assigned.
 */
async function resolveLate(originalTransactionId, userId) {
  if (!originalTransactionId || !userId) return 0;
  const res = await SubscriptionEvent.updateMany(
    { source: "apple", originalTransactionId: String(originalTransactionId), userId: null },
    { $set: { userId, result: "resolved_late" } },
  );
  return res.modifiedCount || 0;
}

/** Apple notifications of the last 24 hours still without a user more than 30 minutes after they came (the alert). */
function unassignedSince(now = new Date()) {
  return SubscriptionEvent.countDocuments({
    source: "apple",
    result: "unknown_user",
    userId: null,
    createdAt: { $gte: new Date(now.getTime() - DAY_MS), $lt: new Date(now.getTime() - UNASSIGNED_GRACE_MS) },
  });
}

// --- CONSUMPTION_REQUEST ---------------------------------------------------------

const ascConfigured = () => !!(process.env.ASC_ISSUER_ID && process.env.ASC_KEY_ID && process.env.ASC_PRIVATE_KEY);

/** A short-lived App Store Server API token (ES256 with the .p8 key from App Store Connect). */
function ascToken(now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" });
  const body = enc({ iss: process.env.ASC_ISSUER_ID, iat, exp: iat + 15 * 60, aud: "appstoreconnect-v1", bid: bundleId() });
  const key = crypto.createPrivateKey(process.env.ASC_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const API_HOSTS = { PRODUCTION: "https://api.storekit.itunes.apple.com", SANDBOX: "https://api.storekit-sandbox.itunes.apple.com" };

/** PUT /inApps/v1/transactions/consumption/{transactionId}; Apple answers 202. */
let sendConsumptionFn = async (environment, transactionId, body) => {
  const res = await fetch(`${API_HOSTS[environment]}/inApps/v1/transactions/consumption/${encodeURIComponent(transactionId)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${ascToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`app_store_api_${res.status}`);
};

/** Tests swap the HTTP call; null restores the real one. */
function setSendConsumption(fn) {
  sendConsumptionFn = fn || module.exports.realSendConsumption;
}

// Apple's buckets (ConsumptionRequest v1): playTime 1 = 0-5 min, 2 = 5-60
// min, 3 = 1-6 h, 4 = 6-24 h, 5 = 1-4 days, 6 = 4-16 days, 7 = more
const PLAY_TIME = [5, 60, 6 * 60, 24 * 60, 4 * 24 * 60, 16 * 24 * 60];
const playTimeOf = (minutes) => {
  const i = PLAY_TIME.findIndex((limit) => minutes < limit);
  return i < 0 ? 7 : i + 1;
};
// accountTenure 1 = 0-3 days, 2 = 3-10, 3 = 10-30, 4 = 30-90, 5 = 90-180, 6 = 180-365, 7 = more
const TENURE_DAYS = [3, 10, 30, 90, 180, 365];
const tenureOf = (days) => {
  const i = TENURE_DAYS.findIndex((limit) => days < limit);
  return i < 0 ? 7 : i + 1;
};

/** Talk minutes of `user` since `from` (1:1 talks and the rooms they own, as their stats count them). */
async function talkMinutesSince(user, from) {
  const [sum] = await Talk.aggregate([{ $match: { ...talksOf(user.phone), startedAt: { $gte: from } } }, { $group: { _id: null, seconds: { $sum: "$seconds" } } }]);
  return Math.floor((sum?.seconds || 0) / 60);
}

/**
 * The ConsumptionRequest body for Apple's refund decision. customerConsented
 * must be true or Apple discards the answer, and it means the person agreed
 * to share this: the app asks nobody today. That is why the answer only
 * goes out once the owner switches the flag apple_consumption on (after
 * the privacy text says so, CMM/docs/PRIVACY-CHANGE.md).
 */
async function consumptionBody(user, transaction, now = new Date()) {
  const since = dateOf(transaction.purchaseDate) || dateOf(transaction.originalPurchaseDate) || now;
  const minutes = await talkMinutesSince(user, since);
  return {
    customerConsented: true,
    consumptionStatus: minutes > 0 ? 2 : 1,
    platform: 1,
    sampleContentProvided: true,
    deliveryStatus: 0,
    appAccountToken: transaction.appAccountToken || "",
    accountTenure: tenureOf((now.getTime() - user._id.getTimestamp().getTime()) / DAY_MS),
    playTime: playTimeOf(minutes),
    lifetimeDollarsRefunded: 0,
    lifetimeDollarsPurchased: 0,
    userStatus: 1,
    refundPreference: 0,
  };
}

/** Answer a CONSUMPTION_REQUEST if we may: "sent", "not_configured", "flag_off" or "no_transaction". */
async function answerConsumption(user, decoded, now = new Date()) {
  if (!ascConfigured()) return "not_configured";
  if (!(await flag(CONSUMPTION_FLAG, false))) return "flag_off";
  const transaction = decoded.transaction;
  if (!transaction?.transactionId) return "no_transaction";
  await sendConsumptionFn(decoded.environment, String(transaction.transactionId), await consumptionBody(user, transaction, now));
  return "sent";
}

// --- One notification ------------------------------------------------------------

/**
 * Store, then act on one verified notification. Returns { result, user,
 * users (the ones whose Plus changed), consumption (true for a
 * CONSUMPTION_REQUEST of a known user) }. A duplicate changes nothing; if
 * acting throws, the stored event is removed again so Apple's retry
 * applies.
 */
async function handleNotification(decoded, now = new Date()) {
  const fields = mapToEvent(decoded, now);
  let stored;
  try {
    stored = await SubscriptionEvent.create(fields);
  } catch (err) {
    if (err.code === 11000) return { result: "duplicate", user: null, users: [] };
    throw err;
  }
  let outcome;
  try {
    const user = await userFor(fields);
    const kind = decoded.payload.notificationType;
    if (!user) {
      // A notification about a transaction we can't place; TEST and summaries name none
      outcome = { result: fields.originalTransactionId || fields.appUserId ? "unknown_user" : "stored", user: null, users: [] };
    } else if (kind === "REFUND") {
      outcome = await refund(user, decoded, fields);
    } else if (kind === "CONSUMPTION_REQUEST") {
      outcome = { result: "consumption_request", user, users: [], consumption: true };
    } else {
      outcome = { result: "stored", user, users: [] };
    }
  } catch (err) {
    await SubscriptionEvent.deleteOne({ _id: stored._id }).catch(() => {});
    throw err;
  }
  // What was done stays done: a failed bookkeeping write is logged, not a 500 (Apple's retry would only be a duplicate)
  try {
    await SubscriptionEvent.updateOne({ _id: stored._id }, { result: outcome.result, userId: outcome.user?._id || null });
  } catch (err) {
    console.error("❌ Apple notification result:", err.message);
  }
  return outcome;
}

module.exports = {
  verifyJws,
  decodeNotification,
  mapToEvent,
  handleNotification,
  resolveLate,
  unassignedSince,
  isMalformed: (err) => err instanceof JwsError && MALFORMED_REASONS.has(err.reason),
  answerConsumption,
  ascToken,
  consumptionBody,
  extensionOids,
  userIdOfToken,
  setRootsForTests,
  setSendConsumption,
  realSendConsumption: sendConsumptionFn,
  ascConfigured,
  JwsError,
  LEAF_OID,
  INTERMEDIATE_OID,
  CONSUMPTION_FLAG,
  DEFAULT_BUNDLE_ID,
  UNASSIGNED_GRACE_MS,
};
