const express = require("express");
const User = require("../models/User");
const { actingPhone } = require("../lib/auth");
const { normalizePhone, regionOf } = require("../lib/phone");
const { isBlocked } = require("../lib/relations");
const { announceJoined } = require("../lib/invites");

const router = express.Router();

const profileOf = (user) => ({
  phone: user.phone,
  name: user.name || "",
  avatarUrl: user.avatarUrl || "",
  lastOnline: user.lastOnline || null,
  momentActiveUntil: user.momentActiveUntil || null,
});

// GET /me            -> own profile (authenticated)
// GET /me?phone=...  -> profile of that user (name, avatar, last online)
router.get("/", async (req, res) => {
  let phone;
  if (req.query.phone) {
    phone = normalizePhone(String(req.query.phone), regionOf(req.auth?.phone));
  } else {
    phone = req.auth?.phone;
  }
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number required" });
  }

  try {
    const user = await User.findOne({ phone });
    const viewer = req.auth?.phone;
    if (!user || (viewer && phone !== viewer && (await isBlocked(viewer, phone)))) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.json({ success: true, user: profileOf(user) });
  } catch (err) {
    res.status(500).json({ success: false, error: "Profil konnte nicht geladen werden" });
  }
});

const MAX_NAME_LENGTH = 50;

// POST /me/update { name?, avatarUrl? }
router.post("/update", async (req, res) => {
  const phone = actingPhone(req, res, req.body?.phone);
  if (!phone) return;

  const update = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ success: false, error: `Name: 1–${MAX_NAME_LENGTH} Zeichen` });
    }
    update.name = name;
  }
  if (req.body.avatarUrl !== undefined) {
    const url = String(req.body.avatarUrl);
    if (url && !/^https:\/\//.test(url)) {
      return res.status(400).json({ success: false, error: "avatarUrl must be https" });
    }
    update.avatarUrl = url;
  }

  try {
    const user = await User.findOneAndUpdate({ phone }, update, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.json({ success: true, user: profileOf(user) });
    if (update.name) {
      announceJoined(user, req.app.get("io")).catch((err) => console.error("❌ announceJoined:", err.message));
    }
  } catch (err) {
    res.status(500).json({ success: false, error: "Profil konnte nicht gespeichert werden" });
  }
});

module.exports = router;
