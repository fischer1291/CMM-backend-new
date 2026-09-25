const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const twilio = require("twilio");
const User = require("../models/User");
const { normalizePhone } = require("../lib/phone");
const { signToken } = require("../lib/auth");
const { connectInviters } = require("../lib/invites");
const { signInBlock } = require("../lib/accessGate");

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

const sameCode = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

  try {
    await twilioClient()
      .verify.v2.services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: "sms" });
    res.json({ success: true, phone });
  } catch (err) {
    console.error("❌ verify/start failed:", err.message);
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
      connectInviters(user).catch((err) => console.error("❌ connectInviters:", err.message));
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
