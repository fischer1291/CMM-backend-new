const express = require("express");
const router = express.Router();
const User = require("../models/User");

// Registrierung mit Telefonnummer
router.post("/register", async (req, res) => {
  const { phone } = req.body;
  try {
    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone });
      await user.save();
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
