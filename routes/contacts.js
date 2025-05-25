const express = require("express");
const router = express.Router();
const User = require("../models/User");

// Kontakte abgleichen
router.post("/match", async (req, res) => {
  const { phones } = req.body;
  try {
    const matched = await User.find({ phone: { $in: phones } });

    const result = matched.map((user) => ({
      phone: user.phone,
      isAvailable: user.isAvailable,
      lastOnline: user.lastOnline,
      name: user.name || "",
      avatarUrl: user.avatarUrl || "",
    }));

    res.json({ success: true, matched: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
