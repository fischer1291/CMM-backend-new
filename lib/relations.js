/**
 * Who may see or reach whom. Contacts (a user's address book matched to
 * registered users) are the basis; blocks remove people from each other's
 * contacts and are checked explicitly where contacts aren't involved
 * (calls, profile/status lookups).
 */
const Block = require("../models/Block");

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
 * May `viewer` see whether `owner` is available? The viewer must have the
 * owner as a contact (they know each other), and be in the owner's
 * audience (all contacts, or members of chosen circles). Blocks are
 * already reflected in contacts.
 */
function inAudience(owner, viewer) {
  const audience = owner.availabilityAudience;
  if (!audience || audience.mode !== "circles") return true;
  const chosen = new Set(audience.circles || []);
  return (owner.circles || []).some((c) => chosen.has(c.id) && c.members.includes(viewer));
}

module.exports = { blockedWith, isBlocked, inAudience };
