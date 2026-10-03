/**
 * Sign-in by SMS code (Twilio Verify): start, check, and since plan 2.9 the
 * answer to "Ist das dein Konto?" for numbers that may have changed hands.
 * Issues the app token and keeps the account's device list.
 */
const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const User = require("../models/User");
const { normalizePhone, countryOf } = require("../lib/phone");
const { signToken } = require("../lib/auth");
const { connectInviters, ensureInviteCode, claimInviteCode } = require("../lib/invites");
const { signInBlock, forget: forgetGate } = require("../lib/accessGate");
const { opsConfig, localeOf } = require("../lib/appConfig");
const opsCounters = require("../lib/opsCounters");
const { localParts } = require("../lib/localTime");
const { client: twilioClient } = require("../lib/twilio");
const ActiveDay = require("../models/ActiveDay");
const { deviceOf, deviceIdOf, knownDevice, rememberDevice } = require("../lib/devices");
const { archiveAndDelete, activityKeys } = require("../lib/account");
const { notify } = require("../lib/notify");

const router = express.Router();

const skip = () => process.env.NODE_ENV === "test";

/**
 * Demo login for App Store review: REVIEW_PHONE gets no SMS and signs in
 * with REVIEW_CODE. Off unless both are set (code at least 6 digits), and
 * off after the day REVIEW_UNTIL ("YYYY-MM-DD", Europe/Berlin) has ended.
 * Without REVIEW_UNTIL it stays on (as before plan 2.1); the alert
 * review_login (lib/alerts.js) asks for an end date then, and for removing
 * the variables once it has passed.
 */
const REVIEW_ZONE = "Europe/Berlin";

/** REVIEW_UNTIL as "YYYY-MM-DD", null when unset, "invalid" when it is no real date. */
function reviewUntil(env = process.env) {
  const value = String(env.REVIEW_UNTIL || "").trim();
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return "invalid";
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.toISOString().slice(0, 10) === value ? value : "invalid";
}

/**
 * Whether the demo login works, for /api/push-health (never the values):
 * off, invalid_until (REVIEW_UNTIL is no date: the login is off), expired
 * (REVIEW_UNTIL has passed), invalid_phone, invalid_code or on.
 */
function reviewLoginStatus(now = new Date(), env = process.env) {
  const phone = env.REVIEW_PHONE || "";
  const code = env.REVIEW_CODE || "";
  if (!phone && !code) return "off";
  // The end date first: a leftover, half-broken configuration after the
  // review still reads "expired", so review_login asks for removing it
  const until = reviewUntil(env);
  if (until === "invalid") return "invalid_until";
  if (until && localParts(now, REVIEW_ZONE).dateKey > until) return "expired";
  if (!normalizePhone(phone)) return "invalid_phone";
  if (!/^\d{6,10}$/.test(code)) return "invalid_code";
  return "on";
}

function reviewCodeFor(phone, now = new Date()) {
  if (reviewLoginStatus(now) !== "on") return null;
  return phone === normalizePhone(process.env.REVIEW_PHONE) ? process.env.REVIEW_CODE : null;
}

const sameCode = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Consent sent with /check since plan 1.6: ageConfirmed (true only), and
// the versions of the terms and the privacy policy the app showed. Nothing
// here refuses a sign-in: older apps send no consent at all, and a bad
// version is stored as null (the confirmation itself still counts).
const MAX_VERSION_LENGTH = 40;
const versionOf = (value) => {
  const v = typeof value === "string" ? value.trim() : "";
  return v && v.length <= MAX_VERSION_LENGTH ? v : null;
};
const consentOf = (body) =>
  body?.ageConfirmed === true ? { termsVersion: versionOf(body.termsVersion), privacyVersion: versionOf(body.privacyVersion) } : null;

/** Stores the consent once, and again whenever one of the versions changes. */
async function recordConsent(phone, consent) {
  await User.updateOne(
    {
      phone,
      $or: [
        { "consent.ageConfirmedAt": null },
        { "consent.termsVersion": { $ne: consent.termsVersion } },
        { "consent.privacyVersion": { $ne: consent.privacyVersion } },
      ],
    },
    { $set: { consent: { ageConfirmedAt: new Date(), ...consent } } },
  );
}

const countOps = (name) => opsCounters.count(name).catch((err) => console.error("❌ opsCounters:", err.message));
// The full cap is logged once per day and instance, not once per refused start
let capLoggedDay = null;

// SMS cost the project money: limit per target number and per client IP
const perPhone = (limit) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    skip,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => normalizePhone(req.body?.phone) || ipKeyGenerator(req.ip),
    message: { success: false, error: "Zu viele Versuche. Bitte warte ein paar Minuten." },
  });
const perIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skip,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Zu viele Versuche. Bitte später erneut versuchen." },
});

// 1. Code senden
router.post("/start", perIp, perPhone(5), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ success: false, error: "Ungültige Telefonnummer" });
  }

  // Banned: no SMS. Suspended: the SMS goes out (under the same brakes
  // below), because only after the code may /check name the reason of the
  // suspension (DSA Art. 17, lib/accessGate.js); /check never signs in
  // while the suspension runs
  const banned = await signInBlock(phone, { banOnly: true });
  if (banned) return res.status(403).json({ success: false, error: banned });

  if (reviewCodeFor(phone)) {
    return res.json({ success: true, phone });
  }

  // Cost brakes (console → App → Betrieb): kill switch, countries we send
  // to (new numbers only: existing accounts keep signing in), and a global
  // cap per day that is checked and booked in one step
  const ops = await opsConfig();
  if (ops.smsPaused) {
    return res.status(503).json({ success: false, error: "Die Anmeldung per SMS ist gerade pausiert. Bitte versuch es später noch einmal." });
  }
  const country = countryOf(phone);
  if ((!country || !ops.smsRegions.includes(country)) && !(await User.exists({ phone }))) {
    return res.status(403).json({ success: false, error: "Wanna yap? gibt es derzeit nur in Deutschland, Österreich und der Schweiz." });
  }
  if (!(await opsCounters.countUpTo("smsStarted", ops.smsPerDay))) {
    const day = localParts(new Date(), "Europe/Berlin").dateKey;
    if (capLoggedDay !== day) {
      capLoggedDay = day;
      console.error(`❌ verify/start: daily SMS cap of ${ops.smsPerDay} reached`);
    }
    return res.status(429).json({ success: false, error: "Heute sind keine Anmeldungen mehr möglich. Bitte versuch es morgen noch einmal." });
  }

  try {
    await twilioClient()
      .verify.v2.services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: "sms" });
    res.json({ success: true, phone });
  } catch (err) {
    console.error("❌ verify/start failed:", err.message);
    countOps("smsFailed");
    res.status(502).json({ success: false, error: "SMS konnte nicht gesendet werden" });
  }
});

// --- Recycled numbers (plan 2.9) ---------------------------------------------
// Prepaid numbers go back to the carrier and to someone else. Before, the
// new holder's first sign-in simply opened the old account. Now a sign-in
// to an account that has been quiet for RECYCLE_AFTER_DAYS, from a device
// the account does not know, asks first: "Ist das dein Konto?" with the
// first name, the picture and the month of the last activity. "mine" signs
// in as before; "not_mine" archives the old account (ArchivedAccount, 30
// days, support only) and deletes it, and the new holder starts fresh.
// Accounts without name and picture are not asked (nothing to recognize,
// and an empty account holds nothing worth protecting); neither is the
// review login. Without JWT_SECRET (legacy mode) there is no token to hold
// back and no key for the checkToken, so nobody is asked. Neither is a
// sign-in without X-Device-Id (apps from before plan 2.9, which cannot show
// the question): it signs in as before and is only counted
// (accountCheckNoDevice), so the backend may go live before the app and the
// returning owner on an old app is never locked out. The new holder of a
// recycled number installs the current app, which sends the id; once
// minBuild is at a build that sends it, old apps stop at the update screen.

// ASSUMPTION: half a year without any use; carriers give a number away
// after months of inactivity, the exact time differs per carrier
const RECYCLE_AFTER_DAYS = 180;
const DAY_MS = 24 * 3600 * 1000;
// How long the question may stay open, and the answer's one-time token
const CHECK_TTL_MS = 10 * 60 * 1000;

/**
 * When the account was last used: the latest ActiveDay (under every key the
 * number had: keyed hash, and the plain hash of rows from before plan 2.8),
 * else lastOnline, else the first verified sign-in, else the creation of
 * the account. Deliberately not the newest of all: lastOnline is also
 * written without the person (the schedule job, moderation), ActiveDay only
 * by the app itself (token requests, sockets).
 */
async function lastActiveAt(user) {
  const row = await ActiveDay.findOne({ who: { $in: activityKeys(user) } }, { day: 1 }).sort({ day: -1 }).lean();
  if (row) return new Date(`${row.day}T12:00:00Z`);
  return user.lastOnline || user.milestones?.verifiedAt || user._id.getTimestamp();
}

const firstNameOf = (name) => (name || "").trim().split(/\s+/)[0] || "";

const checkSignature = (phone, nonce, until) =>
  crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${phone}|${nonce}|${until}`).digest("hex");

/** The checkToken for an open question: "<nonce>.<until ms>.<HMAC>". */
const checkTokenOf = (phone, nonce, until) => `${nonce}.${until}.${checkSignature(phone, nonce, until)}`;

/** { nonce, until } from a checkToken whose signature holds for `phone`, or null. */
function readCheckToken(phone, token) {
  if (!jwtConfigured() || typeof token !== "string" || token.length > 200) return null;
  const m = /^([a-f0-9]{32})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!m) return null;
  const expected = checkSignature(phone, m[1], m[2]);
  return sameCode(m[3], expected) ? { nonce: m[1], until: Number(m[2]) } : null;
}

const jwtConfigured = () => !!process.env.JWT_SECRET;

/**
 * The question to ask before signing `phone` in from `deviceId`, or null to
 * sign in right away. Stores the nonce on the account (User.accountCheck),
 * so only the newest question can be answered, and only once. Without
 * `deviceId` (an app from before plan 2.9) the answer is "no_device": the
 * question would be due, but the app cannot show it (see above).
 */
async function recycleCheck(phone, deviceId, now = new Date()) {
  if (!jwtConfigured() || reviewCodeFor(phone, now)) return null;
  const user = await User.findOne({ phone }, { phone: 1, phoneHmac: 1, name: 1, avatarUrl: 1, devices: 1, lastOnline: 1, "milestones.verifiedAt": 1 }).lean();
  if (!user || (!(user.name || "").trim() && !user.avatarUrl)) return null;
  if (knownDevice(user, deviceId)) return null;
  const last = await lastActiveAt(user);
  if (now - last < RECYCLE_AFTER_DAYS * DAY_MS) return null;
  if (!deviceId) return "no_device";

  const nonce = crypto.randomBytes(16).toString("hex");
  const until = now.getTime() + CHECK_TTL_MS;
  await User.updateOne({ phone }, { $set: { accountCheck: { nonce, until: new Date(until) } } });
  return {
    accountCheck: {
      name: firstNameOf(user.name),
      avatarUrl: user.avatarUrl || "",
      lastActiveMonth: localParts(last, "Europe/Berlin").dateKey.slice(0, 7),
    },
    checkToken: checkTokenOf(phone, nonce, until),
  };
}

/**
 * Tell the account's other device about a sign-in from a device it did not
 * know (push new_device), before the new device is stored. Only when both
 * sides are known for sure: the signing-in device sends X-Device-Id, and the
 * push token belongs to another device of User.devices
 * (pushTokenMetadata.deviceId is listed there and is not the signing-in
 * one). Everything else stays quiet: apps from before plan 2.9 (no id),
 * accounts without a device list yet, and push tokens still registered
 * with the old body deviceId ("ios-<name>-<os>") would otherwise warn the
 * very phone that signs in.
 */
async function tellOtherDevice(user, device, deviceId) {
  if (!user?.pushToken || !deviceId || knownDevice(user, deviceId)) return;
  const tokenDevice = user.pushTokenMetadata?.deviceId;
  if (!tokenDevice || tokenDevice === deviceId || !knownDevice(user, tokenDevice)) return;
  await notify(user, "new_device", { model: device?.model || null });
}

/**
 * The common end of a successful verification (/check, /account-check):
 * create or update the account, connect invites, store consent, device and
 * lastVerifiedAt, and answer with the token.
 */
async function completeSignIn(req, res, phone, { fresh = false } = {}) {
  const now = new Date();
  const io = req.app.get("io");
  const device = deviceOf(req.headers);
  const deviceId = device?.id || null;
  const existing = await User.findOne({ phone });
  const isNew = !existing;
  if (existing) {
    await tellOtherDevice(existing, device, deviceId).catch((err) => console.error("❌ new_device push:", err.message));
  }
  // The device language rides along (measured only, lib/appConfig.js localeOf)
  const locale = localeOf(req.headers);
  const user = await User.findOneAndUpdate(
    { phone },
    {
      $setOnInsert: { phone, phoneHash: User.hashPhone(phone), phoneHmac: User.hmacPhone(phone) },
      $set: {
        lastVerifiedAt: now,
        accountCheck: { nonce: null, until: null },
        // A fresh account on a recycled number: no token from the old
        // holder's time works for it, whatever its age
        ...(fresh ? { tokensValidAfter: now } : {}),
        ...(locale ? { locale } : {}),
      },
    },
    { new: true, upsert: true },
  );
  if (fresh) forgetGate(phone);
  if (device) await rememberDevice(phone, device, now).catch((err) => console.error("❌ rememberDevice:", err.message));

  if (isNew) {
    // Invited by friends: connect them right away
    connectInviters(user, io).catch((err) => console.error("❌ connectInviters:", err.message));
  }
  // The personal invite link's code (also for accounts from before plan 1.11)
  await ensureInviteCode(user).catch((err) => console.error("❌ ensureInviteCode:", err.message));
  // Came through someone's link (/einladung): connect both, credit the
  // inviter. Unknown codes and the own code are ignored in silence.
  if (typeof req.body?.inviteCode === "string" && req.body.inviteCode.length <= 16) {
    await claimInviteCode(user, req.body.inviteCode, io).catch((err) => console.error("❌ claimInviteCode:", err.message));
  }
  // Milestone: first verified sign-in (accounts from before the milestones
  // get it on their next one); never overwritten
  await User.updateOne({ phone, "milestones.verifiedAt": null }, { $set: { "milestones.verifiedAt": now } });
  const consent = consentOf(req.body);
  if (consent) await recordConsent(phone, consent);

  res.json({
    success: true,
    phone,
    // null while JWT_SECRET is not configured (legacy mode); after the
    // cut-off of a fresh account the token's second must lie behind it
    token: signToken(phone, fresh ? { issuedAt: new Date(now.getTime() + 1000) } : {}),
    user: { phone: user.phone, name: user.name || "", avatarUrl: user.avatarUrl || "" },
  });
}

// 2. Code überprüfen: creates the account and issues the auth token, or
// asks first when the number may have changed hands (recycleCheck)
router.post("/check", perPhone(10), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!phone || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ success: false, error: "Nummer und Code erforderlich" });
  }

  // A ban ends here; a suspension is looked at after the code, so its reason
  // goes only to whoever proved the number is theirs (lib/accessGate.js).
  // /start sends that code to a suspended number too, so this path is the
  // one a suspended person really takes
  const banned = await signInBlock(phone, { banOnly: true });
  if (banned) return res.status(403).json({ success: false, error: banned });

  try {
    const reviewCode = reviewCodeFor(phone);
    if (!reviewCode) countOps("smsChecked");
    const approved = reviewCode
      ? sameCode(code, reviewCode)
      : (
          await twilioClient()
            .verify.v2.services(process.env.TWILIO_VERIFY_SID)
            .verificationChecks.create({ to: phone, code })
        ).status === "approved";

    if (!approved) {
      return res.json({ success: false, error: "Code nicht korrekt" });
    }

    const blocked = await signInBlock(phone, { withReason: true });
    if (blocked) return res.status(403).json({ success: false, error: blocked });

    const deviceId = deviceIdOf(req.headers);
    const question = await recycleCheck(phone, deviceId);
    // Apps from before plan 2.9 send no X-Device-Id and cannot show the
    // question: they sign in as before, counted to see how often
    if (question === "no_device") countOps("accountCheckNoDevice");
    else if (question) {
      countOps("accountCheckAsked");
      return res.json({ success: true, phone, ...question });
    }
    await completeSignIn(req, res, phone);
  } catch (err) {
    console.error("❌ verify/check failed:", err.message);
    res.status(502).json({ success: false, error: "Code konnte nicht geprüft werden" });
  }
});

// 3. Antwort auf "Ist das dein Konto?" { phone, checkToken, answer: "mine" |
// "not_mine" } (plan 2.9): "mine" signs in like /check; "not_mine" archives
// and deletes the old account and creates a fresh one. Consent and
// inviteCode may ride along as with /check. An expired, foreign or already
// used checkToken: 401 check_expired (the app starts over with a new SMS).
router.post("/account-check", perPhone(10), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const answer = req.body?.answer;
  if (!phone || !["mine", "not_mine"].includes(answer)) {
    return res.status(400).json({ success: false, error: "Nummer und Antwort erforderlich" });
  }
  const blocked = await signInBlock(phone);
  if (blocked) return res.status(403).json({ success: false, error: blocked });

  try {
    const now = new Date();
    const read = readCheckToken(phone, req.body?.checkToken);
    // Redeemed in one conditional update: a second answer finds no nonce
    const claimed =
      read && read.until > now.getTime()
        ? await User.findOneAndUpdate(
            { phone, "accountCheck.nonce": read.nonce, "accountCheck.until": { $gt: now } },
            { $set: { accountCheck: { nonce: null, until: null } } },
            { projection: { _id: 1 } },
          )
        : null;
    if (!claimed) return res.status(401).json({ success: false, error: "check_expired" });

    if (answer === "not_mine") {
      countOps("accountCheckNotMine");
      await archiveAndDelete(phone, req.app.get("io"), now);
    } else {
      countOps("accountCheckMine");
    }
    await completeSignIn(req, res, phone, { fresh: answer === "not_mine" });
  } catch (err) {
    console.error("❌ verify/account-check failed:", err.message);
    res.status(502).json({ success: false, error: "Das hat nicht geklappt. Bitte versuch es noch einmal." });
  }
});

module.exports = router;
module.exports.reviewLoginStatus = reviewLoginStatus;
module.exports.reviewUntil = reviewUntil;
module.exports.RECYCLE_AFTER_DAYS = RECYCLE_AFTER_DAYS;
