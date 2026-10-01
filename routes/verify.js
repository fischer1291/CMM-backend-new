const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const twilio = require("twilio");
const User = require("../models/User");
const { normalizePhone, countryOf } = require("../lib/phone");
const { signToken } = require("../lib/auth");
const { connectInviters } = require("../lib/invites");
const { signInBlock } = require("../lib/accessGate");
const { opsConfig } = require("../lib/appConfig");
const opsCounters = require("../lib/opsCounters");
const { localParts } = require("../lib/localTime");

const router = express.Router();

let client = null;
function twilioClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

const skip = () => process.env.NODE_ENV === "test";

/**
 * Demo login for App Store review: REVIEW_PHONE gets no SMS and signs in
 * with REVIEW_CODE. Off unless both are set (code at least 6 digits).
 */
function reviewCodeFor(phone) {
  const reviewPhone = normalizePhone(process.env.REVIEW_PHONE || "");
  const code = process.env.REVIEW_CODE || "";
  return reviewPhone && phone === reviewPhone && /^\d{6,10}$/.test(code) ? code : null;
}

/** Whether the demo login works, for /api/push-health (never the values). */
function reviewLoginStatus() {
  const phone = process.env.REVIEW_PHONE || "";
  const code = process.env.REVIEW_CODE || "";
  if (!phone && !code) return "off";
  if (!normalizePhone(phone)) return "invalid_phone";
  if (!/^\d{6,10}$/.test(code)) return "invalid_code";
  return "on";
}

const sameCode = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, phoneHash: User.hashPhone(phone) } },
      { new: true, upsert: true },
    );

    if (isNew) {
      // Invited by friends: connect them right away
      connectInviters(user, req.app.get("io")).catch((err) => console.error("❌ connectInviters:", err.message));
    }

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
