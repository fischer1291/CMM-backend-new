const express = require("express");
const User = require("../models/User");
const { actingPhone } = require("../lib/auth");

const router = express.Router();

// Legacy: older app versions register after verify/check. New versions get
// the account from verify/check directly.
router.post("/register", async (req, res) => {
  const phone = actingPhone(req, res, req.body?.phone);
  if (!phone) return;
  const { pushToken } = req.body;

  try {
    const update = { $setOnInsert: { phone, phoneHash: User.hashPhone(phone) } };
    if (typeof pushToken === "string" && pushToken) update.$set = { pushToken };
    const user = await User.findOneAndUpdate({ phone }, update, { new: true, upsert: true });
    res.json({ success: true, user: { phone: user.phone, name: user.name || "" } });
  } catch (err) {
    console.error("❌ auth/register failed:", err.message);
    res.status(500).json({ success: false, error: "Registrierung fehlgeschlagen" });
  }
});

router.post("/push-token", async (req, res) => {
  const phone = actingPhone(req, res, req.body?.phone);
  if (!phone) return;
  const { pushToken } = req.body;
  if (typeof pushToken !== "string" || !pushToken) {
    return res.status(400).json({ success: false, error: "pushToken required" });
  }

  try {
    const user = await User.findOneAndUpdate({ phone }, { pushToken }, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, error: "User nicht gefunden" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Speichern fehlgeschlagen" });
  }
});

module.exports = router;
