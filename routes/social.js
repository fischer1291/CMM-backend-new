/**
 * The social graph: blocking, reporting, invites, circles and who sees
 * one's availability. Everything needs a token; /admin/* the admin key.
 */
const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Block = require("../models/Block");
const Report = require("../models/Report");
const Invite = require("../models/Invite");
const CallMoment = require("../models/CallMoment");
const Circle = require("../models/Circle");
const { normalizePhone, regionOf } = require("../lib/phone");

const MAX_INVITES_PER_REQUEST = 50;
/** A moment with this many reports from different people is hidden */
const HIDE_AFTER_REPORTS = 3;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  next();
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

module.exports = (io) => {
  const router = express.Router();
  router.use(["/blocks", "/reports", "/invites", "/me/audience"], requireAuth);

  // GET /me/audience: who sees that I'm available
  router.get("/me/audience", async (req, res) => {
    const user = await User.findOne({ phone: req.auth.phone }, "availabilityAudience").lean();
    res.json({ success: true, audience: user?.availabilityAudience || { mode: "all", circles: [] } });
  });

  const target = (req, phone) => normalizePhone(String(phone || ""), regionOf(req.auth.phone));

  // --- Blocking ---------------------------------------------------------

  router.get("/blocks", async (req, res) => {
    const blocks = await Block.find({ blocker: req.auth.phone }).sort({ createdAt: -1 }).lean();
    const users = await User.find({ phone: { $in: blocks.map((b) => b.blocked) } }, "phone name avatarUrl").lean();
    const byPhone = new Map(users.map((u) => [u.phone, u]));
    res.json({
      success: true,
      blocked: blocks.map((b) => ({
        phone: b.blocked,
        name: byPhone.get(b.blocked)?.name || "",
        avatarUrl: byPhone.get(b.blocked)?.avatarUrl || "",
        at: b.createdAt,
      })),
    });
  });

  router.post("/blocks", async (req, res) => {
    const me = req.auth.phone;
    const other = target(req, req.body?.phone);
    if (!other || other === me) return res.status(400).json({ success: false, error: "invalid" });
    await block(me, other);
    res.json({ success: true });
  });

  router.delete("/blocks/:phone", async (req, res) => {
    const other = target(req, req.params.phone);
    await Block.deleteOne({ blocker: req.auth.phone, blocked: other });
    // They become contacts again with the next address book sync
    res.json({ success: true });
  });

  /** Block: out of each other's contacts, circles, sharing lists; status hidden. */
  async function block(me, other) {
    await Block.updateOne({ blocker: me, blocked: other }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    // Shared circles stay; members who blocked each other just don't see each other there
    const pull = { contacts: other, "statsSharing.sharedWith": other };
    const pullMe = { contacts: me, "statsSharing.sharedWith": me };
    await Promise.all([User.updateOne({ phone: me }, { $pull: pull }), User.updateOne({ phone: other }, { $pull: pullMe })]);
    // Both apps drop the other one from the contact list right away
    io.to(`user:${me}`).emit("contactRemoved", { phone: other });
    io.to(`user:${other}`).emit("contactRemoved", { phone: me });
  }

  // --- Reporting --------------------------------------------------------

  // POST /reports { phone, momentId?, reason, note?, block? }
  router.post("/reports", async (req, res) => {
    const me = req.auth.phone;
    const reported = target(req, req.body?.phone);
    const { reason } = req.body || {};
    if (!reported || reported === me || !["spam", "harassment", "inappropriate", "other"].includes(reason)) {
      return res.status(400).json({ success: false, error: "invalid" });
    }
    let momentId = null;
    if (req.body.momentId !== undefined) {
      if (!mongoose.isValidObjectId(req.body.momentId)) return res.status(400).json({ success: false, error: "invalid" });
      momentId = req.body.momentId;
    }

    await Report.create({ reporter: me, reported, momentId, reason, note: str(req.body.note, 500) });
    console.warn(`🚩 Report (${reason})${momentId ? " on a moment" : ""}`);

    if (momentId) {
      const reporters = await Report.distinct("reporter", { momentId });
      if (reporters.length >= HIDE_AFTER_REPORTS) {
        await CallMoment.updateOne({ _id: momentId }, { hidden: true });
      }
    }
    if (req.body.block === true) await block(me, reported);
    res.json({ success: true });
  });

  // --- Invites ----------------------------------------------------------

  // POST /invites { hashes: [sha256(E.164)] }: remember whom I invited, so
  // we're connected (and I hear about it) when they sign up
  router.post("/invites", async (req, res) => {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    const valid = [...new Set(hashes.filter((h) => typeof h === "string" && SHA256_HEX.test(h)))].slice(0, MAX_INVITES_PER_REQUEST);
    if (!valid.length) return res.status(400).json({ success: false, error: "hashes required" });
    await Invite.bulkWrite(
      valid.map((toHash) => ({
        updateOne: { filter: { from: req.auth.phone, toHash }, update: { $setOnInsert: { createdAt: new Date() } }, upsert: true },
      })),
    );
    res.json({ success: true, invited: valid.length });
  });

  // Older app versions (TestFlight build 20) read circles here: the shared
  // circles in the old shape. Editing needs the new app.
  router.get("/me/circles", requireAuth, async (req, res) => {
    const [circles, user] = await Promise.all([
      Circle.find({ "members.phone": req.auth.phone }).lean(),
      User.findOne({ phone: req.auth.phone }, "availabilityAudience").lean(),
    ]);
    res.json({
      success: true,
      circles: circles.map((c) => ({
        id: String(c._id),
        name: c.name,
        emoji: c.emoji,
        members: [...c.members.map((m) => m.phone), ...c.invites.map((i) => i.phone).filter(Boolean)].filter((p) => p !== req.auth.phone),
      })),
      audience: user?.availabilityAudience || { mode: "all", circles: [] },
    });
  });
  router.put("/me/circles", requireAuth, (req, res) =>
    res.status(410).json({ success: false, error: "update_app" }),
  );

  // PUT /me/audience { mode: "all" | "circles", circles: [ids] }
  router.put("/me/audience", async (req, res) => {
    const { mode, circles = [] } = req.body || {};
    if (!["all", "circles"].includes(mode) || !Array.isArray(circles)) {
      return res.status(400).json({ success: false, error: "invalid" });
    }
    // Only shared circles the user is a member of
    const mine = await Circle.find({ _id: { $in: circles.filter((id) => mongoose.isValidObjectId(id)) }, "members.phone": req.auth.phone }, "_id").lean();
    const chosen = mine.map((c) => String(c._id));
    if (mode === "circles" && !chosen.length) {
      return res.status(400).json({ success: false, error: "Choose at least one circle" });
    }
    const audience = { mode, circles: mode === "circles" ? chosen : [] };
    await User.updateOne({ phone: req.auth.phone }, { availabilityAudience: audience });
    res.json({ success: true, audience });
  });

  return router;
};
