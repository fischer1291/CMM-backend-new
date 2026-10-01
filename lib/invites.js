/**
 * A new user signed up: everyone who invited them is connected with them
 * right away (both become each other's contacts, and the pair is kept in
 * User.connections so an address book sync without the other's number
 * doesn't separate them again). The inviters hear about
 * it once the new user has a name (announceJoined, from /me/update), so the
 * message can say who it is. The inviters are kept in User.invitedBy: every
 * few invitees who then have their first talk earn the inviter Plus days
 * (lib/referral.js, from lib/calls.js recordTalk); a join alone counts as
 * "beigetreten" (invitesJoined) only.
 *
 * The other way in, without the inviter having the number: the personal
 * invite link (/einladung?von=CODE, User.inviteCode). The page counts its
 * visits per day, code and platform (InviteVisit), and a sign-up that
 * carries the code is connected the same way (claimInviteCode).
 */
const User = require("../models/User");
const Invite = require("../models/Invite");
const InviteVisit = require("../models/InviteVisit");
const { notifyMany } = require("./notify");
const { claimCircleInvites } = require("./circles");
const { newCode } = require("./waitlist");
const { localParts } = require("./localTime");

const ZONE = "Europe/Berlin";
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const PLATFORMS = ["ios", "android", "other"];

/** "ab cd-2345" → "ABCD2345"; null when it can't be a code. */
function normalizeInviteCode(raw) {
  if (typeof raw !== "string" || raw.length > 16) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE.test(code) ? code : null;
}

/**
 * The user's invite code, given on first use (sign-up, or the first GET /me
 * of an older account). A collision on the unique index rolls a new one.
 */
async function ensureInviteCode(user) {
  if (user.inviteCode) return user.inviteCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      const res = await User.updateOne({ _id: user._id, inviteCode: null }, { $set: { inviteCode: code } });
      if (res.modifiedCount) {
        user.inviteCode = code;
        return code;
      }
      // Another request was first: take what it stored
      const stored = await User.findOne({ _id: user._id }, { inviteCode: 1 }).lean();
      if (stored?.inviteCode) return (user.inviteCode = stored.inviteCode);
      return null;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new Error("invite_code_collision");
}

/**
 * Signed up through someone's link: connect both like connectInviters and
 * credit the inviter. Nothing happens for an unknown code, the own code, or
 * someone who already has an inviter. Returns the inviter's phone or null.
 */
async function claimInviteCode(user, raw, io) {
  const code = normalizeInviteCode(raw);
  if (!code || user.invitedBy?.length) return null;
  const inviter = await User.findOne({ inviteCode: code }, { phone: 1 }).lean();
  if (!inviter || inviter.phone === user.phone) return null;
  await Promise.all([
    User.updateOne(
      { phone: user.phone },
      {
        $addToSet: { contacts: inviter.phone, connections: inviter.phone, pendingJoinAnnouncement: inviter.phone, invitedBy: inviter.phone },
        $set: { joinedViaInvite: true },
      },
    ),
    // Counted once per pair: connectInviters (an Invite document for the same
    // person, started in parallel by /verify/check) may have connected them
    // already, then this adds nothing
    User.updateOne(
      { phone: inviter.phone, connections: { $ne: user.phone } },
      { $addToSet: { contacts: user.phone, connections: user.phone }, $inc: { invitesJoined: 1 } },
    ),
  ]);
  return inviter.phone;
}

/**
 * /einladung was opened: one more visit for the day, code and platform.
 * Unknown codes count too (valid: false), so the page learns nothing about
 * who exists. Returns whether the code belongs to someone.
 */
async function countInviteVisit({ code: raw, platform }, now = new Date()) {
  const code = normalizeInviteCode(raw);
  if (!code) return { counted: false, valid: false };
  const device = PLATFORMS.includes(platform) ? platform : "other";
  const [valid] = await Promise.all([
    User.exists({ inviteCode: code }),
    InviteVisit.updateOne({ day: localParts(now, ZONE).dateKey, code, platform: device }, { $inc: { visits: 1 }, $setOnInsert: { at: now } }, { upsert: true }),
  ]);
  return { counted: true, valid: !!valid };
}

async function connectInviters(user, io) {
  // Invited into circles before having the app: now real invites
  await claimCircleInvites(user);
  const invites = await Invite.find({ toHash: user.phoneHash }).lean();
  if (!invites.length) return 0;
  const inviters = [...new Set(invites.map((i) => i.from))].filter((p) => p !== user.phone);

  await Promise.all([
    User.updateOne(
      { phone: user.phone },
      {
        $addToSet: { contacts: { $each: inviters }, connections: { $each: inviters }, pendingJoinAnnouncement: { $each: inviters }, invitedBy: { $each: inviters } },
        $set: { joinedViaInvite: true },
      },
    ),
    // Same guard as claimInviteCode: a pair connected through the code first
    // is not counted a second time
    User.updateMany(
      { phone: { $in: inviters }, connections: { $ne: user.phone } },
      { $addToSet: { contacts: user.phone, connections: user.phone }, $inc: { invitesJoined: 1 } },
    ),
  ]);
  await Invite.deleteMany({ toHash: user.phoneHash });
  return inviters.length;
}

/** Tell the inviters that `user` (now with a name) joined. */
async function announceJoined(user, io) {
  const inviters = user.pendingJoinAnnouncement || [];
  if (!inviters.length || !user.name) return;
  await User.updateOne({ phone: user.phone }, { pendingJoinAnnouncement: [] });
  for (const phone of inviters) {
    io?.to(`user:${phone}`).emit("contactJoined", { phone: user.phone, name: user.name });
  }
  await notifyMany(inviters, "contact_joined", { phone: user.phone, name: user.name });
}

module.exports = { connectInviters, announceJoined, ensureInviteCode, claimInviteCode, countInviteVisit, normalizeInviteCode };
