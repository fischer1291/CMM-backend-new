const express = require("express");
const router = express.Router();
const User = require("../models/User");

// Kontakte abgleichen
router.post("/match", async (req, res) => {
  const { phones } = req.body; // Array von Telefonnummern
  try {
    const matched = await User.find({ phone: { $in: phones } });
    res.json({ success: true, matched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
