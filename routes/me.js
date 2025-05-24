const express = require("express");
const router = express.Router();
const User = require("../models/User");

// GET /me?phone=...
router.get("/", async (req, res) => {
  const { phone } = req.query;
  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ success: false });
  res.json({ success: true, user });
});

// POST /me/update
router.post("/update", async (req, res) => {
  const { phone, name, avatarUrl } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { phone },
      { name, avatarUrl },
      { new: true },
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
