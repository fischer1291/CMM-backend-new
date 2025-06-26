const express = require("express");
const router = express.Router();
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");

function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/\s+/g, "")
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

    await Promise.all(
      selected.map((u) =>
        User.findByIdAndUpdate(u._id, { lastMomentInvite: new Date() }),
      ),
    );

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
    const activeUntil = new Date(Date.now() + 15 * 60 * 1000);

    const user = await User.findOneAndUpdate(
      { phone: normalizedPhone },
      {
        isAvailable: true,
        mood: mood || null,
        lastOnline: new Date(),
        momentActiveUntil: activeUntil,
      },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    req.app.get("io").emit("statusUpdate", {
      phone: user.phone,
      isAvailable: true,
      mood: user.mood || null,
    });

    setTimeout(
      async () => {
        await User.findOneAndUpdate(
          { phone: normalizedPhone },
          {
            isAvailable: false,
            lastOnline: new Date(),
            mood: null,
            momentActiveUntil: null,
          },
        );

        req.app.get("io").emit("statusUpdate", {
          phone: user.phone,
          isAvailable: false,
        });

        console.log(`⏱️ Auto-offline for ${normalizedPhone}`);
      },
      15 * 60 * 1000,
    ); // 15 Minuten

    res.json({ success: true, user });
  } catch (err) {
    console.error("❌ Fehler bei /moment/confirm:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create new CallMoment
router.post("/callmoment", async (req, res) => {
  try {
    const {
      userPhone,
      userName,
      targetPhone,
      targetName,
      screenshot,
      note,
      mood,
      callDuration,
      timestamp,
    } = req.body;

    if (
      !userPhone ||
      !userName ||
      !targetPhone ||
      !targetName ||
      !screenshot ||
      !mood ||
      !callDuration
    ) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
      });
    }

    const callMoment = new CallMoment({
      userPhone,
      userName,
      targetPhone,
      targetName,
      screenshot,
      note: note || "",
      mood,
      callDuration,
      timestamp: timestamp || new Date(),
    });

    await callMoment.save();
    res.json({
      success: true,
      message: "CallMoment created successfully",
      callMoment,
    });
  } catch (error) {
    console.error("Error creating CallMoment:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get CallMoments feed
router.get("/callmoments", async (req, res) => {
  try {
    const callMoments = await CallMoment.find()
      .sort({ timestamp: -1 })
      .limit(50);
    res.json({
      success: true,
      callMoments: callMoments.map((moment) => ({
        id: moment._id,
        userPhone: moment.userPhone,
        userName: moment.userName,
        targetPhone: moment.targetPhone,
        targetName: moment.targetName,
        screenshot: moment.screenshot,
        note: moment.note,
        mood: moment.mood,
        callDuration: moment.callDuration,
        timestamp: moment.timestamp,
      })),
    });
  } catch (error) {
    console.error("Error fetching CallMoments:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get CallMoments for specific user
router.get("/callmoments/:phone", async (req, res) => {
  try {
    const { phone } = req.params;

    const callMoments = await CallMoment.find({
      $or: [{ userPhone: phone }, { targetPhone: phone }],
    })
      .sort({ timestamp: -1 })
      .limit(20);

    res.json({
      success: true,
      callMoments: callMoments.map((moment) => ({
        id: moment._id,
        userPhone: moment.userPhone,
        userName: moment.userName,
        targetPhone: moment.targetPhone,
        targetName: moment.targetName,
        screenshot: moment.screenshot,
        note: moment.note,
        mood: moment.mood,
        callDuration: moment.callDuration,
        timestamp: moment.timestamp,
      })),
    });
  } catch (error) {
    console.error("Error fetching user CallMoments:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
