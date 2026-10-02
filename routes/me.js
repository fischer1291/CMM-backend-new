/**
 * The own profile and what belongs to it: GET /me, the research answer, the
 * device's permission state, profile edits, and since plan 2.9 the device
 * list and "Überall abmelden".
 */
const express = require("express");
const User = require("../models/User");
const { actingPhone, signToken } = require("../lib/auth");
const { normalizePhone, regionOf } = require("../lib/phone");
const { isBlocked } = require("../lib/relations");
const { announceJoined, ensureInviteCode } = require("../lib/invites");
const { localeOf } = require("../lib/appConfig");
const { endSessions } = require("../lib/moderation");
const { deviceIdOf, listDevices, forgetDevices } = require("../lib/devices");
const opsCounters = require("../lib/opsCounters");

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

// GET /me            -> own profile (authenticated), with `inviteCode`, `research` and `consent`
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
    // The share link's code; accounts from before plan 1.11 get theirs here
    if (own && !user.inviteCode) await ensureInviteCode(user).catch((err) => console.error("❌ ensureInviteCode:", err.message));
    res.json({
      success: true,
      user: { ...profileOf(user), ...(own ? { inviteCode: user.inviteCode || null, research: researchOf(user), consent: consentOf(user) } : {}) },
    });
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

// POST /me/state { notifications?, contactsPermission? }: what the device
// says about its permissions (plan 2.3), each "granted" | "denied" |
// "undetermined". Stored in User.device only when a value changed or the
// last write is older than two hours, so the app may send it on every start;
// lib/lifecycle.js reads it (invite_reminder has its own text for "denied").
// A new route: token only, no legacy claimed phone (no old app sends it).
const PERMISSION_STATES = ["granted", "denied", "undetermined"];
const DEVICE_REFRESH_MS = 2 * 3600 * 1000;
const deviceOf = (user) => ({
  notifications: user.device?.notifications || null,
  contactsPermission: user.device?.contactsPermission || null,
  at: user.device?.at || null,
});
router.post("/state", async (req, res) => {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  const phone = req.auth.phone;
  const told = {};
  for (const key of ["notifications", "contactsPermission"]) {
    const value = req.body?.[key];
    if (value === undefined) continue;
    if (!PERMISSION_STATES.includes(value)) return res.status(400).json({ success: false, error: `invalid_${key}` });
    told[key] = value;
  }
  if (!Object.keys(told).length) return res.status(400).json({ success: false, error: "nothing_to_store" });
  try {
    const user = await User.findOne({ phone }, { device: 1 });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const now = new Date();
    const changed = Object.entries(told).some(([key, value]) => user.device?.[key] !== value);
    const stale = !user.device?.at || now - user.device.at >= DEVICE_REFRESH_MS;
    if (!changed && !stale) return res.json({ success: true, device: deviceOf(user) });
    const set = { "device.at": now };
    for (const [key, value] of Object.entries(told)) set[`device.${key}`] = value;
    const updated = await User.findOneAndUpdate({ phone }, { $set: set }, { new: true, projection: { device: 1 } });
    res.json({ success: true, device: deviceOf(updated) });
  } catch (err) {
    res.status(500).json({ success: false, error: "Status konnte nicht gespeichert werden" });
  }
});

// GET /me/devices (plan 2.9): the devices signed in on the account, most
// recently seen first; `current` marks the calling one (X-Device-Id)
router.get("/devices", async (req, res) => {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  try {
    const user = await User.findOne({ phone: req.auth.phone }, { devices: 1 }).lean();
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, devices: listDevices(user, deviceIdOf(req.headers)) });
  } catch (err) {
    res.status(500).json({ success: false, error: "Geräte konnten nicht geladen werden" });
  }
});

// POST /me/logout-all { pushToken?, voipToken? } (plan 2.9, "Überall
// abmelden"): every token issued until now stops working
// (lib/moderation.js endSessions: tokensValidAfter, the access cache, open
// sockets, the caller's too: it reconnects with the new token). Push and
// VoIP tokens go unless they are the ones the caller sent (its own), the
// device list keeps only the calling device. The answer carries a fresh
// token for the caller, issued a second after the cut-off: tokens carry
// whole seconds and lib/accessGate.js refuses the cut-off's own second.
router.post("/logout-all", async (req, res) => {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  const phone = req.auth.phone;
  const { pushToken, voipToken } = req.body || {};
  try {
    const user = await User.findOne({ phone }, { pushToken: 1, voipToken: 1 }).lean();
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const now = new Date();
    const current = deviceIdOf(req.headers);
    const unset = {};
    if (user.pushToken && user.pushToken !== pushToken) Object.assign(unset, { pushToken: 1, pushTokenMetadata: 1 });
    if (user.voipToken && user.voipToken !== voipToken) Object.assign(unset, { voipToken: 1, voipTokenMetadata: 1 });
    // $pull in place of a read-modify-write: a device stored meanwhile by a
    // concurrent request does not bring the old list back
    await User.updateOne(
      { phone },
      {
        ...(current ? { $pull: { devices: { id: { $ne: current } } } } : { $set: { devices: [] } }),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    );
    await endSessions(phone, req.app.get("io"), now);
    forgetDevices(phone);
    opsCounters.count("logoutAll").catch((err) => console.error("❌ opsCounters:", err.message));
    res.json({ success: true, token: signToken(phone, { issuedAt: new Date(now.getTime() + 1000) }) });
  } catch (err) {
    console.error("❌ logout-all failed:", err.message);
    res.status(500).json({ success: false, error: "Abmelden hat nicht geklappt. Bitte versuch es noch einmal." });
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
  // The device language, measured only (lib/appConfig.js localeOf)
  const locale = localeOf(req.headers);
  if (locale) update.locale = locale;

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
