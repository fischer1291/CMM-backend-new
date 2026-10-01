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

// The research invitation (README "User research"): only in the own profile
const researchOf = (user) => ({
  invitedAt: user.research?.invitedAt || null,
  bookedAt: user.research?.bookedAt || null,
  dismissedAt: user.research?.dismissedAt || null,
  doneAt: user.research?.doneAt || null,
});

// What the person agreed to in onboarding (README "Authentication"): only in
// the own profile; null for accounts from before plan 1.6
const consentOf = (user) => ({
  ageConfirmedAt: user.consent?.ageConfirmedAt || null,
  termsVersion: user.consent?.termsVersion || null,
  privacyVersion: user.consent?.privacyVersion || null,
});

// GET /me            -> own profile (authenticated), with `research` and `consent`
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
    const own = !!viewer && phone === viewer;
    res.json({ success: true, user: { ...profileOf(user), ...(own ? { research: researchOf(user), consent: consentOf(user) } : {}) } });
  } catch (err) {
    res.status(500).json({ success: false, error: "Profil konnte nicht geladen werden" });
  }
});

// POST /me/research { action: "booked" | "dismissed" }: the answer to the
// research card, each set once; the card stays away either way
const RESEARCH_ACTIONS = { booked: "research.bookedAt", dismissed: "research.dismissedAt" };
router.post("/research", async (req, res) => {
  const phone = actingPhone(req, res, req.body?.phone);
  if (!phone) return;
  const field = RESEARCH_ACTIONS[req.body?.action];
  if (!field) return res.status(400).json({ success: false, error: "invalid_action" });
  try {
    const user = await User.findOne({ phone }, { research: 1 });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    if (!user.research?.invitedAt) return res.status(409).json({ success: false, error: "not_invited" });
    await User.updateOne({ phone, [field]: null }, { $set: { [field]: new Date() } });
    res.json({ success: true, research: researchOf(await User.findOne({ phone }, { research: 1 })) });
  } catch (err) {
    res.status(500).json({ success: false, error: "Antwort konnte nicht gespeichert werden" });
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
