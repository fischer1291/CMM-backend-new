const express = require("express");
const router = express.Router();
const User = require("../models/User");

function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/\s+/g, "")
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

// Kontakte abgleichen
router.post("/match", async (req, res) => {
  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) {
    return res
      .status(400)
      .json({ success: false, error: "Phone list missing or invalid" });
  }

  try {
    // Normalisiere alle Telefonnummern
    const normalizedPhones = phones.map(normalizePhone);

    const matched = await User.find({ phone: { $in: normalizedPhones } });

    const result = matched.map((user) => ({
      phone: user.phone,
      isAvailable: user.isAvailable,
      lastOnline: user.lastOnline,
      name: user.name || "",
      avatarUrl: user.avatarUrl || "",
    }));

    res.json({ success: true, matched: result });
  } catch (err) {
    console.error("❌ Fehler beim Abgleich:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
