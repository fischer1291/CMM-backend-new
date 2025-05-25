const express = require("express");
const User = require("../models/User");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/\s+/g, "")
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

module.exports = (io) => {
  const router = express.Router();

  // ✅ Status setzen
  router.post("/set", async (req, res) => {
    let { phone, isAvailable } = req.body;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, error: "Phone number required" });
    }

    phone = normalizePhone(phone);

    try {
      const updateFields = { isAvailable };
      if (!isAvailable) {
        updateFields.lastOnline = new Date(); // ⬅️ Zeit speichern
      }

      const user = await User.findOneAndUpdate({ phone }, updateFields, {
        new: true,
      });

      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User nicht gefunden" });
      }

      // 🔔 WebSocket senden
      io.emit("statusUpdate", {
        phone: user.phone,
        isAvailable: user.isAvailable,
        lastOnline: user.lastOnline,
      });

      // ✅ Push senden nur bei Aktivierung
      if (isAvailable) {
        const contacts = await User.find({
          pushToken: { $ne: null },
          phone: { $ne: user.phone },
        });

        if (contacts.length > 0) {
          const messages = contacts.map((c) => ({
            to: c.pushToken,
            sound: "default",
            title: "📞 Call Me Maybe",
            body: `${user.phone} ist jetzt erreichbar!`,
            data: { phone: user.phone },
          }));

          const response = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messages),
          });

          const result = await response.json();
          console.log("✅ Push Result:", JSON.stringify(result, null, 2));
        }
      }

      res.json({ success: true, user });
    } catch (err) {
      console.error("❌ Fehler beim Status setzen:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ✅ Status abfragen
  router.get("/get", async (req, res) => {
    let { phone } = req.query;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, error: "Phone number required" });
    }

    phone = normalizePhone(phone);

    try {
      const user = await User.findOne({ phone });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User nicht gefunden" });
      }
      res.json({
        success: true,
        isAvailable: user.isAvailable,
        lastOnline: user.lastOnline,
      });
    } catch (err) {
      console.error("❌ Fehler bei Statusabfrage:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
