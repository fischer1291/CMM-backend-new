/**
 * Notification settings and signing out a device.
 */
const express = require("express");
const User = require("../models/User");
const PushDecision = require("../models/PushDecision");

const router = express.Router();

const requireAuth = (req, res, next) =>
  req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });

const prefsOf = (user) => {
  const p = user.notificationPrefs || {};
  return {
    available: p.available !== false,
    nudges: p.nudges !== false,
    moments: p.moments !== false,
    quietHours: {
      enabled: p.quietHours?.enabled !== false,
      start: p.quietHours?.start ?? 22 * 60,
      end: p.quietHours?.end ?? 8 * 60,
    },
  };
};

const isMinute = (v) => Number.isInteger(v) && v >= 0 && v < 24 * 60;

// GET /me/notifications
router.get("/me/notifications", requireAuth, async (req, res) => {
  const user = await User.findOne({ phone: req.auth.phone });
  if (!user) return res.status(404).json({ success: false, error: "User not found" });
  res.json({ success: true, prefs: prefsOf(user) });
});

// PUT /me/notifications { available?, nudges?, moments?, quietHours? }
router.put("/me/notifications", requireAuth, async (req, res) => {
  const body = req.body || {};
  const update = {};
  for (const key of ["available", "nudges", "moments"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return res.status(400).json({ success: false, error: `${key} must be a boolean` });
    update[`notificationPrefs.${key}`] = body[key];
  }
  if (body.quietHours !== undefined) {
    const { enabled, start, end } = body.quietHours || {};
    if (typeof enabled !== "boolean" || !isMinute(start) || !isMinute(end)) {
      return res.status(400).json({ success: false, error: "Invalid quietHours" });
    }
    update["notificationPrefs.quietHours"] = { enabled, start, end };
  }

  const user = await User.findOneAndUpdate({ phone: req.auth.phone }, { $set: update }, { new: true });
  if (!user) return res.status(404).json({ success: false, error: "User not found" });
  res.json({ success: true, prefs: prefsOf(user) });
});

// GET /me/notifications/recent: the last pushes meant for me, sent or skipped (and why)
router.get("/me/notifications/recent", requireAuth, async (req, res) => {
  const recent = await PushDecision.find({ to: req.auth.phone }).sort({ at: -1 }).limit(20).lean();
  res.json({
    success: true,
    recent: recent.map(({ type, about, result, app, delivery, at }) => ({
      type,
      about: about || null,
      result,
      app: app || null,
      delivery: delivery || null,
      at,
    })),
  });
});

// POST /auth/logout: this device stops receiving pushes and calls for the account
router.post("/auth/logout", requireAuth, async (req, res) => {
  const { pushToken, voipToken } = req.body || {};
  const unset = {};
  const user = await User.findOne({ phone: req.auth.phone }, "pushToken voipToken");
  if (!user) return res.json({ success: true });
  // Only this device's tokens; a request without any (older app) removes both
  const all = !pushToken && !voipToken;
  if (all || pushToken === user.pushToken) Object.assign(unset, { pushToken: 1, pushTokenMetadata: 1 });
  if (all || voipToken === user.voipToken) Object.assign(unset, { voipToken: 1, voipTokenMetadata: 1 });
  if (Object.keys(unset).length) await User.updateOne({ phone: req.auth.phone }, { $unset: unset });
  res.json({ success: true });
});

module.exports = router;
