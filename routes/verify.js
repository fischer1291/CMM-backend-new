const express = require("express");
const router = express.Router();
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// 1. Code senden
router.post("/start", async (req, res) => {
  const { phone } = req.body;
  try {
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: "sms" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Code überprüfen
router.post("/check", async (req, res) => {
  const { phone, code } = req.body;
  try {
    const verification_check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (verification_check.status === "approved") {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: "Code nicht korrekt" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
