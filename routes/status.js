const express = require("express");
const User = require("../models/User");
const { actingPhone } = require("../lib/auth");
const { normalizePhone, regionOf } = require("../lib/phone");
const { notifyMany } = require("../lib/notify");
const { answerNudges } = require("../lib/nudges");
const { inAudience, isBlocked } = require("../lib/relations");

/**
 * Users who have `phone` in their contact list. Only they may learn about
 * this user's availability.
 */
async function followersOf(phone) {
  return User.find({ contacts: phone }, "phone pushToken notificationPrefs timezone schedule.timezone");
}

/** Own availability as the app shows it. */
const statusOf = (user) => ({
  isAvailable: user.isAvailable,
  lastOnline: user.lastOnline,
  availableUntil: user.isAvailable ? user.momentActiveUntil || null : null,
  availableSource: user.isAvailable ? user.availableSource || null : null,
});

/**
 * Socket update to the user's followers, plus a push when the user just
 * went from offline to available (not on repeated "available" calls, which
 * would only use up the throttle).
 */
async function broadcastStatus(io, user, { becameAvailable = false } = {}) {
  // Contacts outside the chosen audience see the user as not available
  const all = await followersOf(user.phone);
  const followers = all.filter((f) => inAudience(user, f.phone));
  const hidden = all.filter((f) => !inAudience(user, f.phone));
  if (hidden.length) {
    io.to(hidden.map((f) => `user:${f.phone}`)).emit("statusUpdate", {
      phone: user.phone,
      isAvailable: false,
      lastOnline: user.lastOnline,
      mood: null,
      availableUntil: null,
    });
  }
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

  // Throttled per follower, respects their settings and quiet hours
  if (user.isAvailable && becameAvailable) {
    // Whoever nudged them got what they asked for
    await answerNudges({ to: user.phone });
    await notifyMany(followers, "contact_available", { phone: user.phone, name: user.name });
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
      const before = await User.findOneAndUpdate({ phone }, update);
      if (!before) {
        return res.status(404).json({ success: false, error: "User nicht gefunden" });
      }
      const user = await User.findOne({ phone });

      broadcastStatus(io, user, { becameAvailable: isAvailable && !before.isAvailable }).catch((err) =>
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
      const own = phone === req.auth?.phone;
      const viewer = req.auth?.phone;
      if (!own && viewer && (await isBlocked(viewer, phone))) {
        return res.status(404).json({ success: false, error: "User nicht gefunden" });
      }
      const { availableSource, ...status } = statusOf(user);
      if (!own && viewer && !inAudience(user, viewer)) {
        status.isAvailable = false;
        status.availableUntil = null;
      }
      res.json({ success: true, ...status, ...(own ? { availableSource } : {}) });
    } catch (err) {
      res.status(500).json({ success: false, error: "Status konnte nicht geladen werden" });
    }
  });

  return router;
};

module.exports.broadcastStatus = broadcastStatus;
