const express = require("express");
const User = require("../models/User");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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

      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User nicht gefunden" });
      }

      // 🔔 WebSocket Broadcast an alle Clients
      io.emit("statusUpdate", {
        phone: user.phone,
        isAvailable: user.isAvailable,
      });

      // ✅ Nur bei Aktivierung: Push an andere senden
      if (isAvailable) {
        const contacts = await User.find({
          isAvailable: true,
          pushToken: { $ne: null },
          phone: { $ne: user.phone },
        });

        if (contacts.length === 0) {
          console.log("ℹ️ Keine Kontakte zum Benachrichtigen");
        } else {
          const messages = contacts.map((c) => ({
            to: c.pushToken,
            sound: "default",
            title: "📞 Call Me Maybe",
            body: `${user.phone} ist jetzt erreichbar!`,
            data: { phone: user.phone },
          }));

          // Expo Push API aufrufen
          const response = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messages),
          });

          const result = await response.json();
          console.log(
            "✅ Expo Push Ergebnis:",
            JSON.stringify(result, null, 2),
          );
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
      console.error("❌ Fehler bei Statusabfrage:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
