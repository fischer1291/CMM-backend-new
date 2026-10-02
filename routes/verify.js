const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const User = require("../models/User");
const { normalizePhone, countryOf } = require("../lib/phone");
const { signToken } = require("../lib/auth");
const { connectInviters, ensureInviteCode, claimInviteCode } = require("../lib/invites");
const { signInBlock } = require("../lib/accessGate");
const { opsConfig, localeOf } = require("../lib/appConfig");
const opsCounters = require("../lib/opsCounters");
const { localParts } = require("../lib/localTime");
const { client: twilioClient } = require("../lib/twilio");

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

  // Banned or suspended: no SMS
  const blocked = await signInBlock(phone);
  if (blocked) return res.status(403).json({ success: false, error: blocked });

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

// 2. Code überprüfen: creates the account and issues the auth token
router.post("/check", perPhone(10), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!phone || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ success: false, error: "Nummer und Code erforderlich" });
  }

  const blocked = await signInBlock(phone);
  if (blocked) return res.status(403).json({ success: false, error: blocked });

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

    const isNew = !(await User.exists({ phone }));
    // The device language rides along (measured only, lib/appConfig.js localeOf)
    const locale = localeOf(req.headers);
    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, phoneHash: User.hashPhone(phone), phoneHmac: User.hmacPhone(phone) }, ...(locale ? { $set: { locale } } : {}) },
      { new: true, upsert: true },
    );

    if (isNew) {
      // Invited by friends: connect them right away
      connectInviters(user, req.app.get("io")).catch((err) => console.error("❌ connectInviters:", err.message));
    }
    // The personal invite link's code (also for accounts from before plan 1.11)
    await ensureInviteCode(user).catch((err) => console.error("❌ ensureInviteCode:", err.message));
    // Came through someone's link (/einladung): connect both, credit the
    // inviter. Unknown codes and the own code are ignored in silence.
    if (typeof req.body?.inviteCode === "string" && req.body.inviteCode.length <= 16) {
      await claimInviteCode(user, req.body.inviteCode, req.app.get("io")).catch((err) => console.error("❌ claimInviteCode:", err.message));
    }
    // Milestone: first verified sign-in (accounts from before the milestones
    // get it on their next one); never overwritten
    await User.updateOne({ phone, "milestones.verifiedAt": null }, { $set: { "milestones.verifiedAt": new Date() } });
    const consent = consentOf(req.body);
    if (consent) await recordConsent(phone, consent);

    res.json({
      success: true,
      phone,
      // null while JWT_SECRET is not configured (legacy mode)
      token: signToken(phone),
      user: { phone: user.phone, name: user.name || "", avatarUrl: user.avatarUrl || "" },
    });
  } catch (err) {
    console.error("❌ verify/check failed:", err.message);
    res.status(502).json({ success: false, error: "Code konnte nicht geprüft werden" });
  }
});

module.exports = router;
module.exports.reviewLoginStatus = reviewLoginStatus;
module.exports.reviewUntil = reviewUntil;
