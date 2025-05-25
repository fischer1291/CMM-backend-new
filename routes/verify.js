const express = require("express");
const router = express.Router();
const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// 🔧 Telefonnummer vereinheitlichen
function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/\s+/g, "")
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

// 1. Code senden
router.post("/start", async (req, res) => {
  let { phone } = req.body;
  if (!phone)
    return res
      .status(400)
      .json({ success: false, error: "Phone number required" });

  phone = normalizePhone(phone);
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
  let { phone, code } = req.body;
  if (!phone || !code)
    return res
      .status(400)
      .json({ success: false, error: "Phone and code required" });

  phone = normalizePhone(phone);
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
