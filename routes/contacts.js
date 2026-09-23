const express = require("express");
const User = require("../models/User");
const { normalizePhone, regionOf } = require("../lib/phone");

const router = express.Router();

const MAX_CONTACTS = 5000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * POST /contacts/match
 * Body: { hashes: [sha256(E.164)] }  (preferred: numbers never leave the device)
 *   or  { phones: ["0171 ...", ...] } (legacy; normalized with the caller's region)
 * Returns the registered users among them. For authenticated users the
 * matches are stored as their contact list, which limits who receives their
 * status updates and whose CallMoments they see.
 */
router.post("/match", async (req, res) => {
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

  try {
    const matched = await User.find(query);
    const own = req.auth?.phone;
    const others = matched.filter((u) => u.phone !== own);

    if (own) {
      await User.updateOne({ phone: own }, { contacts: others.map((u) => u.phone) });
    }

    res.json({
      success: true,
      matched: others.map((user) => ({
        phone: user.phone,
        phoneHash: user.phoneHash,
        isAvailable: user.isAvailable,
        lastOnline: user.lastOnline,
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
