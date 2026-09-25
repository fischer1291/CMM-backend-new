const express = require("express");
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");
const { actingPhone } = require("../lib/auth");
const { normalizePhone, regionOf } = require("../lib/phone");
const { notify } = require("../lib/notify");
const { blockedWith } = require("../lib/relations");
const mongoose = require("mongoose");
const { talkedWith, talkedToday, deleteMoment, VISIBLE_MS, DAY_MS } = require("../lib/moments");
const { broadcastStatus } = require("./status");

// Session lengths the app offers; 15 minutes for older app versions
const SESSION_MINUTES = [15, 30, 60, 120];
const DEFAULT_SESSION_MINUTES = 15;
const MAX_SCREENSHOT_LENGTH = 1_000_000; // ~730 KB image as base64 data URI

/**
 * A moment's picture: our own Cloudinary upload (/upload/moment) or, from
 * older app versions, an inline JPEG/PNG. No other URLs: an arbitrary
 * https:// image would let anyone track who looks at the feed.
 */
function isAllowedScreenshot(value) {
  if (typeof value !== "string" || value.length > MAX_SCREENSHOT_LENGTH) return false;
  if (/^data:image\/(jpeg|png);base64,/.test(value)) return true;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  return !!cloud && value.startsWith(`https://res.cloudinary.com/${cloud}/image/upload/`);
}

const formatReactionsForUser = (reactions, userPhone) => {
  return reactions.map((reaction) => ({
    emoji: reaction.emoji,
    count: reaction.count,
    userReacted: reaction.users.some((u) => u.phone === userPhone),
  }));
};

// Moments stored before phone normalization may lack the leading "+"
const withLegacyVariants = (phones) => [...phones, ...phones.map((p) => p.replace(/^\+/, ""))];

/** Phones whose moments `phone` may see: own + contacts. */
async function visiblePhonesFor(phone) {
  const me = await User.findOne({ phone }, "contacts");
  return withLegacyVariants([phone, ...((me && me.contacts) || [])]);
}

/**
 * Ends expired Yap Moments. Runs periodically (see index.js), so expiry
 * survives server restarts, unlike the previous per-request setTimeout.
 */
async function expireMoments(io) {
  const expired = await User.find({
    isAvailable: true,
    momentActiveUntil: { $ne: null, $lte: new Date() },
  });
  for (const user of expired) {
    user.isAvailable = false;
    user.mood = null;
    user.momentActiveUntil = null;
    user.availableSource = null;
    user.lastOnline = new Date();
    await user.save();
    await broadcastStatus(io, user);
    console.log(`⏱️ Auto-offline for ${user.phone}`);
  }
  return expired.length;
}

module.exports = (io) => {
  const router = express.Router();

  // POST /moment/confirm { mood, minutes? }: available for a limited session
  router.post("/confirm", async (req, res) => {
    const phone = actingPhone(req, res, req.body?.phone);
    if (!phone) return;
    const mood = typeof req.body.mood === "string" ? req.body.mood.slice(0, 20) : null;
    const minutes = req.body.minutes === undefined ? DEFAULT_SESSION_MINUTES : Number(req.body.minutes);
    if (!SESSION_MINUTES.includes(minutes)) {
      return res.status(400).json({ success: false, error: `minutes: one of ${SESSION_MINUTES.join(", ")}` });
    }

    try {
      const before = await User.findOneAndUpdate(
        { phone },
        {
          isAvailable: true,
          availableSource: "session",
          mood,
          lastOnline: new Date(),
          momentActiveUntil: new Date(Date.now() + minutes * 60 * 1000),
        },
      );

      if (!before) {
        return res.status(404).json({ success: false, error: "User not found" });
      }
      const user = await User.findOne({ phone });

      broadcastStatus(io, user, { becameAvailable: !before.isAvailable }).catch((err) =>
        console.error("❌ Status broadcast failed:", err.message),
      );

      res.json({
        success: true,
        user: {
          phone: user.phone,
          isAvailable: user.isAvailable,
          mood: user.mood,
          momentActiveUntil: user.momentActiveUntil,
        },
      });
    } catch (err) {
      console.error("❌ Fehler bei /moment/confirm:", err.message);
      res.status(500).json({ success: false, error: "Moment konnte nicht gestartet werden" });
    }
  });

  // POST /moment/callmoment: a picture from a call. Pending until the other
  // person agrees (POST /moment/:id/consent).
  router.post("/callmoment", async (req, res) => {
    const userPhone = actingPhone(req, res, req.body?.userPhone);
    if (!userPhone) return;

    const { userName, targetName, screenshot, note, mood, callDuration } = req.body;
    const targetPhone = normalizePhone(String(req.body.targetPhone || ""), regionOf(userPhone));
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

    if (!targetPhone || targetPhone === userPhone || !isAllowedScreenshot(screenshot) || !str(mood, 20)) {
      return res.status(400).json({ success: false, message: "Required fields missing or invalid" });
    }
    // Only from a real, recent call between the two
    if (!(await talkedWith(userPhone, targetPhone, new Date(Date.now() - DAY_MS)))) {
      return res.status(403).json({ success: false, error: "no_call" });
    }

    try {
      const callMoment = await CallMoment.create({
        userPhone,
        userName: str(userName, 50) || userPhone,
        targetPhone,
        targetName: str(targetName, 50) || targetPhone,
        screenshot,
        note: str(note, 280),
        mood: str(mood, 20),
        callDuration: str(callDuration, 10) || "00:00",
        status: "pending",
      });
      res.json({ success: true, callMoment });

      const author = await User.findOne({ phone: userPhone }, "name");
      io.to(`user:${targetPhone}`).emit("momentConsent", { id: callMoment._id, from: userPhone });
      notify(targetPhone, "moment_consent", { phone: userPhone, name: author?.name }).catch((err) =>
        console.error("❌ moment push:", err.message),
      );
    } catch (error) {
      console.error("CallMoment error:", error.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // POST /moment/:id/consent { approve }: the other person decides
  router.post("/:id/consent", async (req, res) => {
    const phone = req.auth?.phone;
    if (!phone) return res.status(401).json({ success: false, error: "Authentication required" });
    if (!mongoose.isValidObjectId(req.params.id) || typeof req.body?.approve !== "boolean") {
      return res.status(400).json({ success: false, error: "invalid" });
    }
    const moment = await CallMoment.findOne({ _id: req.params.id, targetPhone: phone, status: "pending" });
    if (!moment) return res.status(404).json({ success: false, error: "not_found" });

    if (!req.body.approve) {
      await deleteMoment(moment);
      return res.json({ success: true, status: "deleted" });
    }
    moment.status = "shared";
    moment.sharedAt = new Date();
    await moment.save();
    res.json({ success: true, status: "shared" });

    const me = await User.findOne({ phone }, "name");
    io.to(`user:${moment.userPhone}`).emit("momentShared", { id: moment._id });
    notify(moment.userPhone, "moment_approved", { phone, name: me?.name }).catch(() => {});
  });

  const present = (moment, phone) => ({
    ...moment.toObject(),
    reactions: formatReactionsForUser(moment.reactions, phone),
    totalReactions: moment.totalReactions,
  });

  // GET /moment/callmoments: shared moments of the last 24 h from you and
  // your contacts. Other people's only after your first real conversation
  // today (without it: just how many there are, no pictures). Also: moments
  // waiting for your consent, and yours waiting for theirs.
  router.get("/callmoments", async (req, res) => {
    const phone =
      req.auth?.phone ||
      normalizePhone(String(req.query.userPhone || ""), undefined, { preferInternational: true });
    if (!phone) {
      return res.status(400).json({ success: false, message: "userPhone required" });
    }

    try {
      const me = await User.findOne({ phone });
      const visible = await visiblePhonesFor(phone);
      const blocked = [...(await blockedWith(phone))];
      const mine = withLegacyVariants([phone]);
      const since = new Date(Date.now() - VISIBLE_MS);

      const [recent, pending, waiting, unlocked] = await Promise.all([
        CallMoment.find({
          $or: [{ userPhone: { $in: visible } }, { targetPhone: { $in: mine } }],
          userPhone: { $nin: withLegacyVariants(blocked) },
          hidden: { $ne: true },
          status: { $ne: "pending" },
          $and: [{ $or: [{ sharedAt: { $gt: since } }, { sharedAt: null, timestamp: { $gt: since } }] }],
        })
          .sort({ timestamp: -1 })
          .limit(50),
        CallMoment.find({ targetPhone: phone, status: "pending" }).sort({ timestamp: -1 }),
        CallMoment.find({ userPhone: phone, status: "pending" }).sort({ timestamp: -1 }),
        me ? talkedToday(me) : false,
      ]);

      const involvesMe = (m) => mine.includes(m.userPhone) || mine.includes(m.targetPhone);
      const feed = unlocked ? recent : recent.filter(involvesMe);
      res.json({
        success: true,
        callMoments: feed.map((m) => present(m, phone)),
        locked: !unlocked,
        lockedCount: recent.length - feed.length,
        pending: pending.map((m) => present(m, phone)),
        waiting: waiting.map((m) => present(m, phone)),
      });
    } catch (error) {
      console.error("Fetch call moments error:", error.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // GET /moment/memories: all shared moments you're part of, any age
  router.get("/memories", async (req, res) => {
    const phone = req.auth?.phone;
    if (!phone) return res.status(401).json({ success: false, error: "Authentication required" });
    const mine = withLegacyVariants([phone]);
    const moments = await CallMoment.find({
      $or: [{ userPhone: { $in: mine } }, { targetPhone: { $in: mine } }],
      status: { $ne: "pending" },
      hidden: { $ne: true },
    })
      .sort({ timestamp: -1 })
      .limit(200);
    res.json({ success: true, memories: moments.map((m) => present(m, phone)) });
  });

  // GET /moment/callmoments/:phone: moments of one user (self or a contact)
  router.get("/callmoments/:phone", async (req, res) => {
    const target = normalizePhone(req.params.phone, regionOf(req.auth?.phone));
    if (!target) {
      return res.status(400).json({ success: false, message: "Invalid phone" });
    }
    if (req.auth) {
      const visible = await visiblePhonesFor(req.auth.phone);
      if (!visible.includes(target)) {
        return res.status(403).json({ success: false, message: "Not a contact" });
      }
    }

    try {
      const variants = withLegacyVariants([target]);
      const callMoments = await CallMoment.find({
        $or: [{ userPhone: { $in: variants } }, { targetPhone: { $in: variants } }],
        status: { $ne: "pending" },
        hidden: { $ne: true },
        timestamp: { $gt: new Date(Date.now() - VISIBLE_MS) },
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
      console.error("Error fetching user CallMoments:", error.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
};

module.exports.expireMoments = expireMoments;
