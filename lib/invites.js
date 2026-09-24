/**
 * A new user signed up: everyone who invited them is connected with them
 * right away (both become each other's contacts). The inviters hear about
 * it once the new user has a name (announceJoined, from /me/update), so the
 * message can say who it is.
 */
const User = require("../models/User");
const Invite = require("../models/Invite");
const { notifyMany } = require("./notify");

async function connectInviters(user) {
  const invites = await Invite.find({ toHash: user.phoneHash }).lean();
  if (!invites.length) return 0;
  const inviters = [...new Set(invites.map((i) => i.from))].filter((p) => p !== user.phone);

  await Promise.all([
    User.updateOne(
      { phone: user.phone },
      { $addToSet: { contacts: { $each: inviters }, pendingJoinAnnouncement: { $each: inviters } } },
    ),
    User.updateMany({ phone: { $in: inviters } }, { $addToSet: { contacts: user.phone } }),
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

module.exports = { connectInviters, announceJoined };
