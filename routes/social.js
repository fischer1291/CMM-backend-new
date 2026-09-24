/**
 * The social graph: blocking, reporting, invites, circles and who sees
 * one's availability. Everything needs a token; /admin/* the admin key.
 */
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Block = require("../models/Block");
const Report = require("../models/Report");
const Invite = require("../models/Invite");
const CallMoment = require("../models/CallMoment");
const { normalizePhone, regionOf } = require("../lib/phone");
const { requireAdminKey } = require("../lib/auth");

const MAX_CIRCLES = 12;
const MAX_CIRCLE_MEMBERS = 200;
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
  router.use(["/blocks", "/reports", "/invites", "/me/circles", "/me/audience"], requireAuth);

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
    const pull = { contacts: other, "statsSharing.sharedWith": other, "circles.$[].members": other };
    const pullMe = { contacts: me, "statsSharing.sharedWith": me, "circles.$[].members": me };
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

  // --- Admin: review reports (X-Admin-Key) --------------------------------

  router.get("/admin/reports", requireAdminKey, async (req, res) => {
    const reports = await Report.find({ status: "open" }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, reports });
  });

  // POST /admin/reports/:id/resolve { removeMoment? }
  router.post("/admin/reports/:id/resolve", requireAdminKey, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false });
    const report = await Report.findByIdAndUpdate(req.params.id, { status: "resolved" }, { new: true });
    if (!report) return res.status(404).json({ success: false });
    if (req.body?.removeMoment && report.momentId) await CallMoment.deleteOne({ _id: report.momentId });
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

  // --- Circles ----------------------------------------------------------

  const circlesOf = (user) =>
    (user.circles || []).map(({ id, name, emoji, members }) => ({ id, name, emoji, members }));

  router.get("/me/circles", async (req, res) => {
    const user = await User.findOne({ phone: req.auth.phone }, "circles availabilityAudience").lean();
    if (!user) return res.status(404).json({ success: false });
    res.json({
      success: true,
      circles: circlesOf(user),
      audience: user.availabilityAudience || { mode: "all", circles: [] },
    });
  });

  // PUT /me/circles { circles: [{ id?, name, emoji, members }] }: replaces all
  router.put("/me/circles", async (req, res) => {
    const input = req.body?.circles;
    if (!Array.isArray(input) || input.length > MAX_CIRCLES) {
      return res.status(400).json({ success: false, error: `circles: at most ${MAX_CIRCLES}` });
    }
    const user = await User.findOne({ phone: req.auth.phone }, "contacts availabilityAudience");
    if (!user) return res.status(404).json({ success: false });
    const contacts = new Set(user.contacts);

    const circles = [];
    for (const c of input) {
      const name = str(c?.name, 30);
      if (!name || !Array.isArray(c.members) || c.members.length > MAX_CIRCLE_MEMBERS) {
        return res.status(400).json({ success: false, error: "Invalid circle" });
      }
      circles.push({
        id: /^[a-z0-9]{6,16}$/.test(c.id || "") ? c.id : crypto.randomBytes(5).toString("hex"),
        name,
        emoji: str(c.emoji, 8) || "💛",
        // Only people who are actually contacts
        members: [...new Set(c.members.map((p) => target(req, p)).filter((p) => p && contacts.has(p)))],
      });
    }

    // Chosen audience circles that no longer exist fall away
    const ids = new Set(circles.map((c) => c.id));
    const audience = user.availabilityAudience || { mode: "all", circles: [] };
    const keep = (audience.circles || []).filter((id) => ids.has(id));
    await User.updateOne(
      { phone: req.auth.phone },
      { circles, availabilityAudience: { mode: keep.length ? audience.mode : "all", circles: keep } },
    );
    res.json({ success: true, circles, audience: { mode: keep.length ? audience.mode : "all", circles: keep } });
  });

  // PUT /me/audience { mode: "all" | "circles", circles: [ids] }
  router.put("/me/audience", async (req, res) => {
    const { mode, circles = [] } = req.body || {};
    if (!["all", "circles"].includes(mode) || !Array.isArray(circles)) {
      return res.status(400).json({ success: false, error: "invalid" });
    }
    const user = await User.findOne({ phone: req.auth.phone }, "circles");
    if (!user) return res.status(404).json({ success: false });
    const ids = new Set(user.circles.map((c) => c.id));
    const chosen = circles.filter((id) => ids.has(id));
    if (mode === "circles" && !chosen.length) {
      return res.status(400).json({ success: false, error: "Choose at least one circle" });
    }
    const audience = { mode, circles: mode === "circles" ? chosen : [] };
    await User.updateOne({ phone: req.auth.phone }, { availabilityAudience: audience });
    res.json({ success: true, audience });
  });

  return router;
};
