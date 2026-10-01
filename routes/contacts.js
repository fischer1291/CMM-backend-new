const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const User = require("../models/User");
const { normalizePhone, regionOf } = require("../lib/phone");
const { blockedWith, audienceOf } = require("../lib/relations");
const opsCounters = require("../lib/opsCounters");

const router = express.Router();

const MAX_CONTACTS = 5000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
// The app syncs at start, after a contact joined and on pull-to-refresh: a
// person never comes near this, a script probing numbers does
const MATCHES_PER_DAY = 60;
// A huge list that matches nobody is somebody scanning the number space
const SUSPICIOUS_HASHES = 2000;

const perUser = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: MATCHES_PER_DAY,
  skip: () => process.env.NODE_ENV === "test",
  keyGenerator: (req) => req.auth?.phone || ipKeyGenerator(req.ip),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Zu viele Abgleiche heute. Bitte morgen erneut versuchen." },
});

/**
 * POST /contacts/match
 * Body: { hashes: [sha256(E.164)] }  (preferred: numbers never leave the device)
 *   or  { phones: ["0171 ...", ...] } (legacy; normalized with the caller's region)
 * Returns the registered users among them. For authenticated users the
 * matches plus their invite connections (User.connections) become their
 * contact list, which limits who receives their status updates, whose
 * CallMoments they see and whom they may call. lastOnline is only told for
 * people who know the caller too, so the endpoint can't be used to watch
 * strangers.
 */
router.post("/match", perUser, async (req, res) => {
  const { phones, hashes } = req.body || {};
  const region = regionOf(req.auth?.phone);

  let query;
  if (Array.isArray(hashes)) {
    const valid = hashes.filter((h) => typeof h === "string" && SHA256_HEX.test(h));
    query = { phoneHash: { $in: valid.slice(0, MAX_CONTACTS) } };
  } else if (Array.isArray(phones)) {
    const normalized = phones
      .slice(0, MAX_CONTACTS)
      .map((p) => normalizePhone(String(p), region))
      .filter(Boolean);
    query = { phone: { $in: normalized } };
  } else {
    return res.status(400).json({ success: false, error: "hashes or phones required" });
  }

  const asked = Array.isArray(hashes) ? hashes.length : phones.length;

  try {
    const matched = await User.find(query);
    const own = req.auth?.phone;
    const blocked = own ? await blockedWith(own) : new Set();
    const others = matched.filter((u) => u.phone !== own && !blocked.has(u.phone));

    if (own) {
      // One atomic write that reads connections from the document itself, so a
      // connectInviters running at the same time (sign-up, see routes/verify.js)
      // is never lost: either it is already in connections here, or its
      // $addToSet lands on top of this contacts list afterwards
      const union = { $setUnion: [others.map((u) => u.phone), { $ifNull: ["$connections", []] }] };
      // Milestones in the same write: the first sync, and the first sync that
      // found somebody. $ifNull keeps a value that is already there.
      const now = new Date();
      const milestones = { "milestones.contactsSyncedAt": { $ifNull: ["$milestones.contactsSyncedAt", now] } };
      if (others.length) milestones["milestones.firstRegisteredContactAt"] = { $ifNull: ["$milestones.firstRegisteredContactAt", now] };
      await User.updateOne({ phone: own }, [{ $set: { contacts: { $setDifference: [union, [own, ...blocked]] }, ...milestones } }]);
    }
    if (asked > SUSPICIOUS_HASHES && others.length === 0) {
      console.warn(`⚠️ contacts/match: ${asked} entries without a match from ${own ? `${own.slice(0, 3)}…${own.slice(-3)}` : req.ip}`);
      opsCounters.count("matchSuspicious").catch((err) => console.error("❌ opsCounters:", err.message));
    }

    // Only if the user shares their availability with you
    const visible = new Map();
    for (const user of others) visible.set(user.phone, !own || (await audienceOf(user))(own));
    // Only people who know you too tell you when they were last online
    const mutual = (user) => !!own && ((user.contacts || []).includes(own) || (user.connections || []).includes(own));
    res.json({
      success: true,
      matched: others.map((user) => ({
        phone: user.phone,
        phoneHash: user.phoneHash,
        isAvailable: user.isAvailable && visible.get(user.phone),
        lastOnline: mutual(user) ? user.lastOnline : null,
        name: user.name || "",
        avatarUrl: user.avatarUrl || "",
      })),
    });
  } catch (err) {
    console.error("❌ Fehler beim Abgleich:", err.message);
    res.status(500).json({ success: false, error: "Abgleich fehlgeschlagen" });
  }
});

module.exports = router;
