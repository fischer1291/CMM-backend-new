const express = require("express");
const User = require("../models/User");
const { actingPhone } = require("../lib/auth");
const { normalizePhone, regionOf } = require("../lib/phone");
const { sendExpoPushes } = require("../lib/push");

/**
 * Users who have `phone` in their contact list. Only they may learn about
 * this user's availability.
 */
async function followersOf(phone) {
  return User.find({ contacts: phone }, "phone pushToken");
}

/** Own availability as the app shows it. */
const statusOf = (user) => ({
  isAvailable: user.isAvailable,
  lastOnline: user.lastOnline,
  availableUntil: user.isAvailable ? user.momentActiveUntil || null : null,
  availableSource: user.isAvailable ? user.availableSource || null : null,
});

/** Socket + push notification to the user's followers. */
async function broadcastStatus(io, user) {
  const followers = await followersOf(user.phone);
  const rooms = followers.map((f) => `user:${f.phone}`);
  if (rooms.length > 0) {
    io.to(rooms).emit("statusUpdate", {
      phone: user.phone,
      isAvailable: user.isAvailable,
      lastOnline: user.lastOnline,
      mood: user.mood || null,
      availableUntil: user.isAvailable ? user.momentActiveUntil || null : null,
    });
  }

  if (user.isAvailable) {
    const displayName = user.name || "Ein Kontakt";
    await sendExpoPushes(
      followers
        .filter((f) => f.pushToken)
        .map((f) => ({
          to: f.pushToken,
          sound: "default",
          title: `${displayName} ist erreichbar`,
          body: "Jetzt ist ein guter Moment für einen Anruf.",
          data: { type: "contact_available", phone: user.phone },
        })),
    );
  }
}

module.exports = (io) => {
  const router = express.Router();

  // POST /status/set { isAvailable }
  router.post("/set", async (req, res) => {
    const phone = actingPhone(req, res, req.body?.phone);
    if (!phone) return;
    if (typeof req.body.isAvailable !== "boolean") {
      return res.status(400).json({ success: false, error: "isAvailable must be a boolean" });
    }
    const { isAvailable } = req.body;

    try {
      // Manually available = open-ended, until switched off
      const update = { isAvailable, availableSource: isAvailable ? "manual" : null, momentActiveUntil: null };
      if (!isAvailable) {
        update.lastOnline = new Date();
        update.mood = null;
      }
      const user = await User.findOneAndUpdate({ phone }, update, { new: true });
      if (!user) {
        return res.status(404).json({ success: false, error: "User nicht gefunden" });
      }

      broadcastStatus(io, user).catch((err) =>
        console.error("❌ Status broadcast failed:", err.message),
      );

      res.json({ success: true, ...statusOf(user) });
    } catch (err) {
      console.error("❌ Fehler beim Status setzen:", err.message);
      res.status(500).json({ success: false, error: "Status konnte nicht gesetzt werden" });
    }
  });

  // GET /status/get[?phone=...]
  router.get("/get", async (req, res) => {
    const phone = req.query.phone
      ? normalizePhone(String(req.query.phone), regionOf(req.auth?.phone))
      : req.auth?.phone;
    if (!phone) {
      return res.status(400).json({ success: false, error: "Phone number required" });
    }

    try {
      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, error: "User nicht gefunden" });
      }
      const { availableSource, ...status } = statusOf(user);
      const own = phone === req.auth?.phone;
      res.json({ success: true, ...status, ...(own ? { availableSource } : {}) });
    } catch (err) {
      res.status(500).json({ success: false, error: "Status konnte nicht geladen werden" });
    }
  });

  return router;
};

module.exports.broadcastStatus = broadcastStatus;
