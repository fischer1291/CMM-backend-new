/**
 * Shared circles: membership, who sees whom, a circle's "warmth" this week,
 * rooms (group calls) and rituals.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const Talk = require("../models/Talk");
const { localParts, DEFAULT_TIMEZONE } = require("./localTime");

const MAX_MEMBERS = 50;
const MAX_CIRCLES = 20;
/** A room nobody left properly (app crashed) ends after this */
const ROOM_MAX_MS = 3 * 3600 * 1000;
const ROOM_MAX_SECONDS = ROOM_MAX_MS / 1000;

// Unambiguous characters for codes people might type
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const isId = (id) => mongoose.isValidObjectId(id);
const memberPhones = (circle) => circle.members.map((m) => m.phone);
const isMember = (circle, phone) => circle.members.some((m) => m.phone === phone);

/** Everyone who shares at least one circle with `phone`. */
async function coMembersOf(phone) {
  const circles = await Circle.find({ "members.phone": phone }, "members.phone").lean();
  return new Set(circles.flatMap((c) => c.members.map((m) => m.phone)).filter((p) => p !== phone));
}

/**
 * Who may see that `owner` is available: returns viewer => boolean.
 * "all": everyone who can see them at all (contacts, circle members).
 * "circles": members and people invited to the chosen circles.
 */
async function audienceOf(owner) {
  const audience = owner.availabilityAudience;
  if (!audience || audience.mode !== "circles") return () => true;
  const ids = (audience.circles || []).filter(isId);
  const circles = await Circle.find({ _id: { $in: ids }, "members.phone": owner.phone }, "members.phone invites.phone").lean();
  const allowed = new Set(
    circles.flatMap((c) => [...c.members.map((m) => m.phone), ...c.invites.map((i) => i.phone).filter(Boolean)]),
  );
  return (viewer) => allowed.has(viewer);
}

/** Monday 00:00 (local) of the week containing `now`. */
function weekStart(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const { day, minutes } = localParts(now, timeZone);
  const sinceMonday = (day + 6) % 7;
  const start = new Date(now.getTime() - (sinceMonday * 24 * 60 + minutes) * 60 * 1000);
  start.setUTCSeconds(0, 0);
  return start;
}

/**
 * How connected the circle was this week: shared minutes (calls between
 * members and the circle's rooms), how many members talked to another
 * member, and whether everyone did (the weekly goal).
 */
async function warmthOf(circle, now = new Date()) {
  const members = memberPhones(circle);
  const since = weekStart(now, circle.ritual?.timezone || DEFAULT_TIMEZONE);
  const inCircle = new Set(members);

  const [pairTalks, roomTalks] = await Promise.all([
    Talk.find({ group: { $ne: true }, participants: { $in: members }, startedAt: { $gte: since } }).lean(),
    Talk.find({ group: true, circleId: circle._id, startedAt: { $gte: since } }).lean(),
  ]);

  let seconds = 0;
  const talked = new Set();
  for (const t of pairTalks) {
    if (!t.participants.every((p) => inCircle.has(p))) continue;
    seconds += t.seconds;
    t.participants.forEach((p) => talked.add(p));
  }
  // Each participant has a record; the room's time counts once: the longest
  const rooms = new Map();
  for (const t of roomTalks) {
    if (t.participants.length > 1) talked.add(t.owner);
    const key = t.callId.split(":")[0];
    rooms.set(key, Math.max(rooms.get(key) || 0, t.seconds));
  }
  seconds += [...rooms.values()].reduce((a, b) => a + b, 0);

  const talkedCount = members.filter((p) => talked.has(p)).length;
  return {
    minutes: Math.round(seconds / 60),
    talkedCount,
    memberCount: members.length,
    goalReached: members.length >= 2 && talkedCount === members.length,
  };
}

// --- Rooms ------------------------------------------------------------------

async function activeRoomOf(circleId) {
  return Room.findOne({ circleId, active: true });
}

/** The circle's open room, created if there is none. Returns { room, created }. */
async function openRoom(circle, startedBy) {
  const existing = await activeRoomOf(circle._id);
  if (existing) return { room: existing, created: false };
  const room = await Room.create({
    circleId: circle._id,
    channel: `room_${circle._id}_${Date.now().toString(36)}`,
    startedBy,
  });
  return { room, created: true };
}

async function joinRoom(room, phone, now = new Date()) {
  await Room.updateOne({ _id: room._id }, { $pull: { participants: { phone, leftAt: null } } });
  await Room.updateOne({ _id: room._id }, { $push: { participants: { phone, joinedAt: now, leftAt: null } } });
  return Room.findById(room._id);
}

/**
 * `phone` leaves: their time counts as a talk with everyone who was there
 * at the same time. The room ends when nobody is left.
 */
async function leaveRoom(room, phone, now = new Date()) {
  const fresh = await Room.findById(room._id);
  if (!fresh) return null;
  const mine = fresh.participants.find((p) => p.phone === phone && !p.leftAt);
  if (!mine) return fresh;
  mine.leftAt = now;

  const overlapping = fresh.participants.filter(
    (p) => p.phone !== phone && p.joinedAt < now && (!p.leftAt || p.leftAt > mine.joinedAt),
  );
  const seconds = Math.min(Math.round((now - mine.joinedAt) / 1000), ROOM_MAX_SECONDS);
  if (overlapping.length && seconds > 0) {
    await Talk.updateOne(
      { callId: `${fresh._id}:${phone}:${mine.joinedAt.getTime()}` },
      {
        $setOnInsert: {
          participants: [phone, ...new Set(overlapping.map((p) => p.phone))],
          startedAt: mine.joinedAt,
          seconds,
          group: true,
          owner: phone,
          circleId: fresh.circleId,
        },
      },
      { upsert: true },
    );
  }
  if (!fresh.participants.some((p) => !p.leftAt)) {
    fresh.active = false;
    fresh.endedAt = now;
  }
  await fresh.save();
  return fresh;
}

/** Rooms left open by crashed apps: everyone still inside leaves now. */
async function endStaleRooms(now = new Date()) {
  const stale = await Room.find({ active: true, createdAt: { $lt: new Date(now - ROOM_MAX_MS) } });
  for (const room of stale) {
    for (const p of room.participants.filter((x) => !x.leftAt)) await leaveRoom(room, p.phone, now);
    await Room.updateOne({ _id: room._id }, { active: false, endedAt: now });
  }
  // Rooms nobody ever joined
  await Room.updateMany(
    { active: true, participants: { $size: 0 }, createdAt: { $lt: new Date(now - 15 * 60 * 1000) } },
    { active: false, endedAt: now },
  );
  return stale.length;
}

// --- Rituals ----------------------------------------------------------------

/** Circles whose ritual starts now: returns them after marking today as done. */
async function dueRituals(now = new Date()) {
  const circles = await Circle.find({ "ritual.enabled": true });
  const due = [];
  for (const circle of circles) {
    const zone = circle.ritual.timezone || DEFAULT_TIMEZONE;
    const { dateKey, day, minutes } = localParts(now, zone);
    if (day !== circle.ritual.day || minutes < circle.ritual.start || minutes >= circle.ritual.start + 10) continue;
    const claimed = await Circle.findOneAndUpdate(
      { _id: circle._id, "ritual.lastKey": { $ne: dateKey } },
      { "ritual.lastKey": dateKey },
      { new: true },
    );
    if (claimed) due.push(claimed);
  }
  return due;
}

/** Every minute: rituals that start now open their circle's room and tell everyone. */
async function tickRituals(io, now = new Date()) {
  const { notifyMany } = require("./notify");
  const due = await dueRituals(now);
  for (const circle of due) {
    const { room, created } = await openRoom(circle, "ritual");
    const members = memberPhones(circle);
    io?.to(members.map((p) => `user:${p}`)).emit(created ? "roomOpened" : "roomUpdated", {
      circleId: String(circle._id),
      roomId: String(room._id),
      channel: room.channel,
      startedBy: "ritual",
    });
    const recipients = await User.find({ phone: { $in: members } }, "phone pushToken notificationPrefs timezone schedule.timezone");
    await notifyMany(recipients, "circle_ritual", {
      circleId: String(circle._id),
      circleName: `${circle.emoji} ${circle.name}`,
    });
  }
  return due.length;
}

// --- Sign-up and migration --------------------------------------------------

/** A new user was invited into circles by number hash: now it's a real invite. */
async function claimCircleInvites(user) {
  await Circle.updateMany(
    { "invites.hash": user.phoneHash },
    { $set: { "invites.$[i].phone": user.phone, "invites.$[i].hash": null } },
    { arrayFilters: [{ "i.hash": user.phoneHash }] },
  );
}

/**
 * Old private circles (User.circles) become shared circles owned by the
 * user; their people become invite drafts the owner can send. The
 * availability audience keeps pointing at the same people.
 */
async function migratePrivateCircles() {
  const users = await User.find({ "circles.0": { $exists: true } }).lean();
  for (const user of users) {
    const idMap = new Map();
    for (const old of user.circles) {
      const circle = await Circle.create({
        name: old.name,
        emoji: old.emoji || "💛",
        createdBy: user.phone,
        members: [{ phone: user.phone }],
        invites: (old.members || []).map((phone) => ({ phone, invitedBy: user.phone, status: "draft" })),
        code: newCode(),
      });
      idMap.set(old.id, String(circle._id));
    }
    const audience = user.availabilityAudience || { mode: "all", circles: [] };
    const circles = (audience.circles || []).map((id) => idMap.get(id)).filter(Boolean);
    await User.updateOne(
      { phone: user.phone },
      {
        $set: { availabilityAudience: { mode: circles.length ? audience.mode : "all", circles } },
        $unset: { circles: 1 },
      },
    );
  }
  return users.length;
}

module.exports = {
  MAX_MEMBERS,
  MAX_CIRCLES,
  newCode,
  isId,
  memberPhones,
  isMember,
  coMembersOf,
  audienceOf,
  weekStart,
  warmthOf,
  activeRoomOf,
  openRoom,
  joinRoom,
  leaveRoom,
  endStaleRooms,
  dueRituals,
  tickRituals,
  claimCircleInvites,
  migratePrivateCircles,
};
