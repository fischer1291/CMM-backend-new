/**
 * Shared circles and their rooms (group calls). Everything needs a token,
 * except the invite-code preview for the web landing page.
 */
const express = require("express");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const CallMoment = require("../models/CallMoment");
const { normalizePhone, regionOf } = require("../lib/phone");
const { blockedWith } = require("../lib/relations");
const { notifyMany } = require("../lib/notify");
const { circleBadgesOf } = require("../lib/badges");
const {
  MAX_MEMBERS,
  MAX_CIRCLES,
  newCode,
  isId,
  memberPhones,
  isMember,
  audienceOf,
  warmthOf,
  activeRoomOf,
  openRoom,
  joinRoom,
  leaveRoom,
} = require("../lib/circles");

const SHA256_HEX = /^[a-f0-9]{64}$/;
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

module.exports = (io) => {
  const router = express.Router();
  const requireAuth = (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });
  router.use(["/circles", "/rooms"], (req, res, next) => (req.path.startsWith("/code/") ? next() : requireAuth(req, res, next)));

  const toRooms = (phones) => phones.map((p) => `user:${p}`);
  const emitCircle = (circle, event, payload) => io.to(toRooms(memberPhones(circle))).emit(event, payload);

  /** The circle as the viewer sees it. */
  async function present(circle, viewer, { detail = false } = {}) {
    const blocked = await blockedWith(viewer);
    const phones = memberPhones(circle).filter((p) => !blocked.has(p));
    const users = await User.find(
      { phone: { $in: phones } },
      "phone name avatarUrl isAvailable momentActiveUntil availabilityAudience",
    );
    const byPhone = new Map(users.map((u) => [u.phone, u]));
    const members = [];
    for (const phone of phones) {
      const u = byPhone.get(phone);
      if (!u) continue;
      const visible = phone === viewer || (await audienceOf(u))(viewer);
      members.push({
        phone,
        name: u.name || "",
        avatarUrl: u.avatarUrl || "",
        isAvailable: visible && !!u.isAvailable,
        availableUntil: visible && u.isAvailable ? u.momentActiveUntil || null : null,
      });
    }
    const room = await activeRoomOf(circle._id);
    const out = {
      id: String(circle._id),
      name: circle.name,
      emoji: circle.emoji,
      createdBy: circle.createdBy,
      members,
      invitedCount: circle.invites.length,
      warmth: await warmthOf(circle),
      room: room
        ? { id: String(room._id), channel: room.channel, participants: room.participants.filter((p) => !p.leftAt).map((p) => p.phone) }
        : null,
      ritual: { enabled: circle.ritual.enabled, day: circle.ritual.day, start: circle.ritual.start },
    };
    if (detail) {
      out.code = circle.code;
      const invitedUsers = await User.find({ phone: { $in: circle.invites.map((i) => i.phone).filter(Boolean) } }, "phone name").lean();
      const nameOf = new Map(invitedUsers.map((u) => [u.phone, u.name || ""]));
      out.invites = circle.invites.map((i) => ({
        phone: i.phone,
        name: i.phone ? nameOf.get(i.phone) || "" : "",
        status: i.status,
        pendingSignup: !i.phone,
      }));
      // The circle's album: shared moments between two members
      const inCircle = memberPhones(circle);
      const moments = await CallMoment.find({
        userPhone: { $in: inCircle },
        targetPhone: { $in: inCircle },
        status: { $ne: "pending" },
        hidden: { $ne: true },
      })
        .sort({ timestamp: -1 })
        .limit(30)
        .lean();
      out.badges = await circleBadgesOf(circle);
      out.moments = moments.map((m) => ({ id: String(m._id), screenshot: m.screenshot, userPhone: m.userPhone, targetPhone: m.targetPhone, mood: m.mood, note: m.note, timestamp: m.timestamp }));
    }
    return out;
  }

  const loadMine = async (req, res) => {
    if (!isId(req.params.id)) {
      res.status(404).json({ success: false, error: "not_found" });
      return null;
    }
    const circle = await Circle.findById(req.params.id);
    if (!circle || !isMember(circle, req.auth.phone)) {
      res.status(404).json({ success: false, error: "not_found" });
      return null;
    }
    return circle;
  };

  /**
   * Invite phones (E.164, app users get a push) and hashes (people without
   * the app, connected when they sign up). Drafts become real invites.
   */
  async function invite(circle, from, phones = [], hashes = []) {
    const me = await User.findOne({ phone: from }, "name");
    const blocked = await blockedWith(from);
    const members = new Set(memberPhones(circle));
    const newlyInvited = [];
    for (const phone of phones) {
      if (!phone || members.has(phone) || blocked.has(phone)) continue;
      const existing = circle.invites.find((i) => i.phone === phone);
      if (existing) {
        if (existing.status === "draft") {
          existing.status = "pending";
          existing.at = new Date();
          newlyInvited.push(phone);
        }
        continue;
      }
      circle.invites.push({ phone, invitedBy: from, status: "pending" });
      newlyInvited.push(phone);
    }
    for (const hash of hashes) {
      if (!SHA256_HEX.test(hash) || circle.invites.some((i) => i.hash === hash)) continue;
      circle.invites.push({ hash, invitedBy: from, status: "pending" });
    }
    if (circle.members.length + circle.invites.length > MAX_MEMBERS * 2) throw Object.assign(new Error("too_many"), { status: 400 });
    await circle.save();

    const registered = await User.find({ phone: { $in: newlyInvited } }, "phone pushToken notificationPrefs timezone schedule.timezone");
    for (const u of registered) io.to(`user:${u.phone}`).emit("circleInvite", { circleId: String(circle._id) });
    await notifyMany(registered, "circle_invite", { phone: from, name: me?.name, circleName: `${circle.emoji} ${circle.name}` });
  }

  const phonesOf = (req, list) =>
    Array.isArray(list) ? list.map((p) => normalizePhone(String(p), regionOf(req.auth.phone))).filter(Boolean) : [];

  // GET /circles: my circles, plus invites waiting for me
  router.get("/circles", async (req, res) => {
    const phone = req.auth.phone;
    const [mine, invited] = await Promise.all([
      Circle.find({ "members.phone": phone }).sort({ createdAt: 1 }),
      Circle.find({ invites: { $elemMatch: { phone, status: "pending" } } }),
    ]);
    const inviters = await User.find({ phone: { $in: invited.map((c) => c.invites.find((i) => i.phone === phone)?.invitedBy) } }, "phone name").lean();
    const nameOf = new Map(inviters.map((u) => [u.phone, u.name || ""]));
    res.json({
      success: true,
      circles: await Promise.all(mine.map((c) => present(c, phone))),
      invites: invited.map((c) => {
        const inv = c.invites.find((i) => i.phone === phone);
        return { circleId: String(c._id), name: c.name, emoji: c.emoji, memberCount: c.members.length, invitedBy: inv.invitedBy, invitedByName: nameOf.get(inv.invitedBy) || "" };
      }),
    });
  });

  // POST /circles { name, emoji, invite: [phones], inviteHashes: [hashes] }
  router.post("/circles", async (req, res) => {
    const phone = req.auth.phone;
    const name = str(req.body?.name, 30);
    if (!name) return res.status(400).json({ success: false, error: "name required" });
    if ((await Circle.countDocuments({ "members.phone": phone })) >= MAX_CIRCLES) {
      return res.status(400).json({ success: false, error: "too_many_circles" });
    }
    const circle = await Circle.create({
      name,
      emoji: str(req.body?.emoji, 8) || "💛",
      createdBy: phone,
      members: [{ phone }],
      code: newCode(),
      ritual: { timezone: (await User.findOne({ phone }, "timezone"))?.timezone || null },
    });
    try {
      await invite(circle, phone, phonesOf(req, req.body?.invite), req.body?.inviteHashes || []);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, error: err.message });
      throw err;
    }
    res.json({ success: true, circle: await present(circle, phone, { detail: true }) });
  });

  // GET /circles/code/:code: public preview for invite links
  router.get("/circles/code/:code", async (req, res) => {
    const circle = await Circle.findOne({ code: String(req.params.code).toUpperCase() }, "name emoji members createdBy").lean();
    if (!circle) return res.status(404).json({ success: false, error: "not_found" });
    const creator = await User.findOne({ phone: circle.createdBy }, "name").lean();
    res.json({
      success: true,
      circle: { name: circle.name, emoji: circle.emoji, memberCount: circle.members.length, createdByName: (creator?.name || "").split(" ")[0] },
    });
  });

  // POST /circles/join { code }: the link is the consent
  router.post("/circles/join", async (req, res) => {
    const phone = req.auth.phone;
    const circle = await Circle.findOne({ code: String(req.body?.code || "").trim().toUpperCase() });
    if (!circle) return res.status(404).json({ success: false, error: "not_found" });
    const blocked = await blockedWith(phone);
    if (memberPhones(circle).some((p) => blocked.has(p))) return res.status(404).json({ success: false, error: "not_found" });
    if (!isMember(circle, phone)) {
      if (circle.members.length >= MAX_MEMBERS) return res.status(400).json({ success: false, error: "full" });
      circle.members.push({ phone });
      circle.invites = circle.invites.filter((i) => i.phone !== phone);
      await circle.save();
      emitCircle(circle, "circleUpdated", { circleId: String(circle._id) });
    }
    res.json({ success: true, circle: await present(circle, phone, { detail: true }) });
  });

  router.get("/circles/:id", async (req, res) => {
    const circle = await loadMine(req, res);
    if (circle) res.json({ success: true, circle: await present(circle, req.auth.phone, { detail: true }) });
  });

  // PATCH /circles/:id { name?, emoji?, ritual? }: name/emoji by the creator, the ritual by anyone
  router.patch("/circles/:id", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    const { name, emoji, ritual } = req.body || {};
    if ((name !== undefined || emoji !== undefined) && circle.createdBy !== req.auth.phone) {
      return res.status(403).json({ success: false, error: "creator_only" });
    }
    if (name !== undefined) {
      if (!str(name, 30)) return res.status(400).json({ success: false, error: "name required" });
      circle.name = str(name, 30);
    }
    if (emoji !== undefined) circle.emoji = str(emoji, 8) || circle.emoji;
    if (ritual !== undefined) {
      const { enabled, day, start } = ritual || {};
      if (typeof enabled !== "boolean" || !Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(start) || start < 0 || start >= 24 * 60) {
        return res.status(400).json({ success: false, error: "Invalid ritual" });
      }
      const me = await User.findOne({ phone: req.auth.phone }, "timezone");
      circle.ritual = { enabled, day, start, timezone: me?.timezone || circle.ritual.timezone, lastKey: null };
    }
    await circle.save();
    emitCircle(circle, "circleUpdated", { circleId: String(circle._id) });
    res.json({ success: true, circle: await present(circle, req.auth.phone, { detail: true }) });
  });

  // POST /circles/:id/invite { phones?, hashes?, drafts? }: drafts=true sends all drafts
  router.post("/circles/:id/invite", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    const phones = phonesOf(req, req.body?.phones);
    if (req.body?.drafts === true) phones.push(...circle.invites.filter((i) => i.status === "draft" && i.phone).map((i) => i.phone));
    try {
      await invite(circle, req.auth.phone, phones, Array.isArray(req.body?.hashes) ? req.body.hashes : []);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, error: err.message });
      throw err;
    }
    res.json({ success: true, circle: await present(circle, req.auth.phone, { detail: true }) });
  });

  // POST /circles/:id/accept | /decline: my invite
  const answerInvite = (accept) => async (req, res) => {
    const phone = req.auth.phone;
    if (!isId(req.params.id)) return res.status(404).json({ success: false });
    const circle = await Circle.findOne({ _id: req.params.id, "invites.phone": phone });
    if (!circle) return res.status(404).json({ success: false, error: "not_found" });
    circle.invites = circle.invites.filter((i) => i.phone !== phone);
    if (accept && !isMember(circle, phone)) {
      if (circle.members.length >= MAX_MEMBERS) return res.status(400).json({ success: false, error: "full" });
      circle.members.push({ phone });
    }
    await circle.save();
    emitCircle(circle, "circleUpdated", { circleId: String(circle._id) });
    res.json({ success: true, circle: accept ? await present(circle, phone, { detail: true }) : null });
  };
  router.post("/circles/:id/accept", answerInvite(true));
  router.post("/circles/:id/decline", answerInvite(false));

  // DELETE /circles/:id/invites/:phone: withdraw an invite (creator or the inviter)
  router.delete("/circles/:id/invites/:phone", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    const phone = normalizePhone(req.params.phone, regionOf(req.auth.phone));
    circle.invites = circle.invites.filter(
      (i) => !(i.phone === phone && (i.invitedBy === req.auth.phone || circle.createdBy === req.auth.phone)),
    );
    await circle.save();
    res.json({ success: true });
  });

  // POST /circles/:id/leave; the last one out deletes the circle
  router.post("/circles/:id/leave", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    await leaveCircle(circle, req.auth.phone);
    res.json({ success: true });
  });

  // DELETE /circles/:id/members/:phone: the creator removes someone
  router.delete("/circles/:id/members/:phone", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    if (circle.createdBy !== req.auth.phone) return res.status(403).json({ success: false, error: "creator_only" });
    const phone = normalizePhone(req.params.phone, regionOf(req.auth.phone));
    if (phone === req.auth.phone) return res.status(400).json({ success: false, error: "use_leave" });
    await leaveCircle(circle, phone);
    res.json({ success: true });
  });

  async function leaveCircle(circle, phone) {
    circle.members = circle.members.filter((m) => m.phone !== phone);
    if (!circle.members.length) {
      await Circle.deleteOne({ _id: circle._id });
      await Room.updateMany({ circleId: circle._id, active: true }, { active: false, endedAt: new Date() });
      return;
    }
    // The creator's rights move to the longest member
    if (circle.createdBy === phone) circle.createdBy = circle.members[0].phone;
    await circle.save();
    // Out of the audience of the circle's members is handled by membership itself
    io.to(`user:${phone}`).emit("circleUpdated", { circleId: String(circle._id), removed: true });
    emitCircle(circle, "circleUpdated", { circleId: String(circle._id) });
  }

  // --- Rooms (Offene Runde) -------------------------------------------------

  // POST /circles/:id/room: open the circle's room (or get the running one) and join it
  router.post("/circles/:id/room", async (req, res) => {
    const circle = await loadMine(req, res);
    if (!circle) return;
    const phone = req.auth.phone;
    const { room: opened, created } = await openRoom(circle, phone);
    const room = await joinRoom(opened, phone);
    const payload = { circleId: String(circle._id), roomId: String(room._id), channel: room.channel, startedBy: phone };
    emitCircle(circle, created ? "roomOpened" : "roomUpdated", payload);
    if (created) {
      const me = await User.findOne({ phone }, "name");
      const others = memberPhones(circle).filter((p) => p !== phone);
      const recipients = await User.find({ phone: { $in: others } }, "phone pushToken notificationPrefs timezone schedule.timezone");
      await notifyMany(recipients, "room_open", {
        phone,
        name: me?.name,
        circleId: String(circle._id),
        circleName: `${circle.emoji} ${circle.name}`,
      });
    }
    res.json({ success: true, room: { id: String(room._id), channel: room.channel, circleId: String(circle._id) } });
  });

  const loadRoom = async (req, res) => {
    const room = isId(req.params.id) ? await Room.findById(req.params.id) : null;
    const circle = room ? await Circle.findById(room.circleId) : null;
    if (!room || !circle || !isMember(circle, req.auth.phone)) {
      res.status(404).json({ success: false, error: "not_found" });
      return null;
    }
    return { room, circle };
  };

  router.post("/rooms/:id/join", async (req, res) => {
    const found = await loadRoom(req, res);
    if (!found) return;
    if (!found.room.active) return res.status(409).json({ success: false, error: "ended" });
    const room = await joinRoom(found.room, req.auth.phone);
    emitCircle(found.circle, "roomUpdated", { circleId: String(found.circle._id), roomId: String(room._id) });
    res.json({ success: true, room: { id: String(room._id), channel: room.channel, circleId: String(found.circle._id) } });
  });

  router.post("/rooms/:id/leave", async (req, res) => {
    const found = await loadRoom(req, res);
    if (!found) return;
    const room = await leaveRoom(found.room, req.auth.phone);
    emitCircle(found.circle, "roomUpdated", { circleId: String(found.circle._id), roomId: String(found.room._id), ended: !room?.active });
    res.json({ success: true, ended: !room?.active });
  });

  return router;
};
