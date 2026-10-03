/**
 * Who may see or reach whom. Contacts (a user's address book matched to
 * registered users) are the basis; blocks remove people from each other's
 * contacts and are checked explicitly where contacts aren't involved
 * (calls, profile/status lookups). Calls additionally need a connection
 * (isConnected): both know each other, or they share a circle.
 */
const Block = require("../models/Block");
const User = require("../models/User");
const Circle = require("../models/Circle");

/** Phones `phone` blocked or was blocked by. */
async function blockedWith(phone) {
  const blocks = await Block.find({ $or: [{ blocker: phone }, { blocked: phone }] }, "blocker blocked").lean();
  return new Set(blocks.map((b) => (b.blocker === phone ? b.blocked : b.blocker)));
}

async function isBlocked(a, b) {
  if (!a || !b) return false;
  return !!(await Block.exists({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
}

/**
 * Are `a` and `b` connected, so one may ring the other? True when each has
 * the other as a contact (address book match on both sides, or an invite
 * connection, see User.connections) or when both are members of the same
 * circle. Blocks are checked separately (isBlocked).
 */
async function isConnected(a, b) {
  if (!a || !b || a === b) return false;
  const mutual = await User.exists({ phone: a, contacts: b });
  if (mutual && (await User.exists({ phone: b, contacts: a }))) return true;
  return !!(await Circle.exists({ $and: [{ "members.phone": a }, { "members.phone": b }] }));
}

/**
 * May `viewer` see whether `owner` is available? Returns viewer => boolean
 * (see lib/circles.js audienceOf: all, or the chosen shared circles).
 */
function audienceOf(owner) {
  // Required lazily: lib/circles requires this module's siblings
  return require("./circles").audienceOf(owner);
}

module.exports = { blockedWith, isBlocked, isConnected, audienceOf };
