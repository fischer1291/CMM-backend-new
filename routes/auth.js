const express = require("express");
const router = express.Router();
const User = require("../models/User");

// 📞 Telefonnummer vereinheitlichen
function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/\s+/g, "")
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

// ✅ Registrierung mit Telefonnummer und optionalem PushToken
router.post("/register", async (req, res) => {
  let { phone, pushToken } = req.body;

  if (!phone) {
    return res
      .status(400)
      .json({ success: false, error: "Phone number required" });
  }

  phone = normalizePhone(phone);

  try {
    let user = await User.findOne({ phone });

    if (!user) {
      user = new User({ phone, pushToken });
      await user.save();
    } else {
      // Update pushToken bei bestehendem User, falls vorhanden
      if (pushToken) {
        user.pushToken = pushToken;
        await user.save();
      }
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Push Token separat speichern oder aktualisieren
router.post("/push-token", async (req, res) => {
  let { phone, pushToken } = req.body;

  if (!phone || !pushToken) {
    return res
      .status(400)
      .json({ success: false, error: "Phone and pushToken required" });
  }

  phone = normalizePhone(phone);

  try {
    const user = await User.findOneAndUpdate(
      { phone },
      { pushToken },
      { new: true },
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "User nicht gefunden" });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
