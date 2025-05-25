const express = require("express");
const router = express.Router();
const User = require("../models/User");

function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

function isOutsideQuietHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour >= 8 && hour < 22; // 08:00 – 21:59 Uhr
}

function wasInvitedToday(date) {
  if (!date) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function shuffleArray(array) {
  return array.sort(() => 0.5 - Math.random());
}

// ✅ POST /moment/push-broadcast
router.post("/push-broadcast", async (req, res) => {
  if (!isOutsideQuietHours()) {
    return res
      .status(403)
      .json({ success: false, error: "Quiet hours active" });
  }

  try {
    let users = await User.find({
      pushToken: { $ne: null },
      isAvailable: false, // Nur Nutzer, die NICHT erreichbar sind
    });

    // 🔁 Filter: max 1x pro Tag
    users = users.filter((u) => !wasInvitedToday(u.lastMomentInvite));

    const selected = shuffleArray(users).slice(0, 10);
    if (selected.length === 0) {
      return res.json({
        success: true,
        message: "No users selected (already invited or none available)",
      });
    }

    const messages = selected.map((user) => ({
      to: user.pushToken,
      sound: "default",
      title: "🎯 Call Me Moment",
      body: "Bereit für ein ehrliches Gespräch? Bestätige jetzt für 15 Minuten!",
      data: { type: "callMeMoment" },
    }));

    // Update Invite Timestamp
    await Promise.all(
      selected.map((u) =>
        User.findByIdAndUpdate(u._id, { lastMomentInvite: new Date() }),
      ),
    );

    // Push senden
    const fetch = (...args) =>
      import("node-fetch").then(({ default: fetch }) => fetch(...args));
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log("📤 Push sent:", JSON.stringify(result, null, 2));

    res.json({ success: true, sent: selected.length });
  } catch (err) {
    console.error("❌ Fehler beim Senden:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ POST /moment/confirm
router.post("/confirm", async (req, res) => {
  const { phone, mood } = req.body;
  if (!phone) {
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required" });
  }

  try {
    const normalizedPhone = normalizePhone(phone);

    const user = await User.findOneAndUpdate(
      { phone: normalizedPhone },
      {
        isAvailable: true,
        mood: mood || null,
        lastOnline: new Date(),
      },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // WebSocket: Status-Update an alle
    req.app.get("io").emit("statusUpdate", {
      phone: user.phone,
      isAvailable: true,
      mood: user.mood || null,
    });

    // Auto-Deaktivierung nach 15 Minuten
    setTimeout(
      async () => {
        await User.findOneAndUpdate(
          { phone: normalizedPhone },
          {
            isAvailable: false,
            lastOnline: new Date(),
            mood: null,
          },
        );

        req.app.get("io").emit("statusUpdate", {
          phone: user.phone,
          isAvailable: false,
        });

        console.log(`⏱️ Auto-offline for ${normalizedPhone}`);
      },
      15 * 60 * 1000,
    ); // 15 min

    res.json({ success: true, user });
  } catch (err) {
    console.error("❌ Fehler bei /moment/confirm:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
