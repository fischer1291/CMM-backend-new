// 📁 routes/status.js
const express = require("express");
const User = require("../models/User");

module.exports = (io) => {
  const router = express.Router();

  // ✅ Status setzen
  router.post("/set", async (req, res) => {
    const { phone, isAvailable } = req.body;
    try {
      const user = await User.findOneAndUpdate(
        { phone },
        { isAvailable },
        { new: true },
      );

      // 🔔 WebSocket Broadcast an alle Clients
      io.emit("statusUpdate", {
        phone: user.phone,
        isAvailable: user.isAvailable,
      });

      res.json({ success: true, user });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ✅ Status abfragen
  router.get("/get", async (req, res) => {
    const { phone } = req.query;
    try {
      const user = await User.findOne({ phone });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User nicht gefunden" });
      }
      res.json({ success: true, isAvailable: user.isAvailable });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
