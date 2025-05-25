const express = require("express");
const router = express.Router();
const User = require("../models/User");

router.post("/start", async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ success: false, error: "Phone is required" });

  try {
    const now = new Date();
    const until = new Date(now.getTime() + 15 * 60 * 1000); // +15min

    const user = await User.findOneAndUpdate(
      { phone },
      { isAvailable: true, momentActiveUntil: until },
      { new: true },
    );

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    // TODO: WebSocket Broadcast (später)

    res.json({ success: true, momentActiveUntil: user.momentActiveUntil });
  } catch (err) {
    console.error("❌ Fehler bei /moment/start:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
