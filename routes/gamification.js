/**
 * Schedules, personal talk-time stats (+ opt-in sharing) and nudges.
 * All endpoints need a token: they are new, so no legacy clients exist.
 */
const express = require("express");
const User = require("../models/User");
const Nudge = require("../models/Nudge");
const { normalizePhone, regionOf } = require("../lib/phone");
const { parseSchedule, nextSlot } = require("../lib/schedule");
const { statsFor, sharedView, canView } = require("../lib/stats");
const { isValidTimezone, localParts } = require("../lib/localTime");
const { sendExpoPushes } = require("../lib/push");

const MAX_NUDGES_PER_DAY = 20;
const MAX_SHARED_WITH = 200;

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  next();
}

const scheduleOf = (user) => ({
  enabled: !!user.schedule?.enabled,
  timezone: user.schedule?.timezone || null,
  slots: (user.schedule?.slots || []).map(({ day, start, end }) => ({ day, start, end })),
});

/** No pushes at night in the recipient's zone. */
const isQuietTime = (timezone, now = new Date()) => {
  const { minutes } = localParts(now, timezone);
  return minutes < 8 * 60 || minutes >= 22 * 60;
};

module.exports = (io) => {
  const router = express.Router();
  router.use(["/me/schedule", "/me/stats", "/stats", "/nudge", "/nudges"], requireAuth);

  const me = (req) => User.findOne({ phone: req.auth.phone });

  // --- Schedule ---------------------------------------------------------

  router.get("/me/schedule", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, schedule: scheduleOf(user), next: nextSlot(user.schedule) });
  });

  router.put("/me/schedule", async (req, res) => {
    const { value, error } = parseSchedule(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const user = await User.findOneAndUpdate({ phone: req.auth.phone }, { schedule: value }, { new: true });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, schedule: scheduleOf(user), next: nextSlot(user.schedule) });
  });

  // --- Stats ------------------------------------------------------------

  router.get("/me/stats", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const timezone = isValidTimezone(req.query.tz) ? req.query.tz : undefined;
    try {
      const stats = await statsFor(user, { timezone });
      res.json({
        success: true,
        stats,
        sharing: {
          visibility: user.statsSharing?.visibility || "private",
          sharedWith: user.statsSharing?.sharedWith || [],
        },
      });
    } catch (err) {
      console.error("❌ stats:", err.message);
      res.status(500).json({ success: false, error: "Statistik konnte nicht geladen werden" });
    }
  });

  router.put("/me/stats/sharing", async (req, res) => {
    const { visibility, sharedWith = [] } = req.body || {};
    if (!["private", "contacts", "selected"].includes(visibility)) {
      return res.status(400).json({ success: false, error: "Invalid visibility" });
    }
    if (!Array.isArray(sharedWith) || sharedWith.length > MAX_SHARED_WITH) {
      return res.status(400).json({ success: false, error: "Invalid sharedWith" });
    }
    const region = regionOf(req.auth.phone);
    const phones = [...new Set(sharedWith.map((p) => normalizePhone(String(p), region)).filter(Boolean))];

    const user = await User.findOneAndUpdate(
      { phone: req.auth.phone },
      { statsSharing: { visibility, sharedWith: visibility === "selected" ? phones : [] } },
      { new: true },
    );
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, sharing: user.statsSharing });
  });

  // Someone else's stats, only if they chose to share them with the viewer
  router.get("/stats/:phone", async (req, res) => {
    const target = normalizePhone(req.params.phone, regionOf(req.auth.phone));
    const owner = target && (await User.findOne({ phone: target }));
    // Same answer for "unknown" and "not shared": no account enumeration
    if (!owner || !canView(owner, req.auth.phone)) {
      return res.status(403).json({ success: false, shared: false });
    }
    const stats = await statsFor(owner);
    res.json({ success: true, shared: true, name: owner.name || "", stats: sharedView(stats) });
  });

  // --- Nudges -----------------------------------------------------------

  // POST /nudge { phone }: "I'd like to talk" to a contact who is offline
  router.post("/nudge", async (req, res) => {
    const from = req.auth.phone;
    const to = normalizePhone(String(req.body?.phone || ""), regionOf(from));
    if (!to || to === from) return res.status(400).json({ success: false, error: "invalid" });

    const [sender, target] = await Promise.all([User.findOne({ phone: from }), User.findOne({ phone: to })]);
    // Only people who have you in their address book can nudge you
    if (!sender || !target || !target.contacts.includes(from)) {
      return res.status(403).json({ success: false, error: "not_allowed" });
    }
    if (target.isAvailable) {
      return res.status(409).json({ success: false, error: "already_available" });
    }
    const today = await Nudge.countDocuments({ from, createdAt: { $gt: new Date(Date.now() - 24 * 3600 * 1000) } });
    if (today >= MAX_NUDGES_PER_DAY) {
      return res.status(429).json({ success: false, error: "too_many" });
    }

    try {
      await Nudge.create({ from, to });
    } catch (err) {
      if (err.code === 11000) return res.status(429).json({ success: false, error: "already_nudged" });
      throw err;
    }

    const name = sender.name || "Ein Kontakt";
    io.to(`user:${to}`).emit("nudge", { from, name, at: new Date() });
    const quiet = isQuietTime(target.schedule?.timezone);
    if (target.pushToken && !quiet) {
      await sendExpoPushes([
        {
          to: target.pushToken,
          sound: "default",
          title: `${name} würde gern mit dir sprechen 👋`,
          body: "Schalte dich erreichbar, wenn es dir passt.",
          data: { type: "nudge", phone: from },
        },
      ]);
    }
    res.json({ success: true, pushed: !!target.pushToken && !quiet });
  });

  // GET /nudges: who nudged me recently (and which contacts I nudged)
  router.get("/nudges", async (req, res) => {
    const phone = req.auth.phone;
    const [received, sent] = await Promise.all([
      Nudge.find({ to: phone }).sort({ createdAt: -1 }).lean(),
      Nudge.find({ from: phone }, "to createdAt").lean(),
    ]);
    const senders = await User.find({ phone: { $in: received.map((n) => n.from) } }, "phone name").lean();
    const nameOf = new Map(senders.map((u) => [u.phone, u.name || ""]));
    res.json({
      success: true,
      received: received.map((n) => ({ from: n.from, name: nameOf.get(n.from) || "", at: n.createdAt })),
      sent: sent.map((n) => ({ to: n.to, at: n.createdAt })),
    });
  });

  return router;
};
