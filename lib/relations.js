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
 * May `viewer` see whether `owner` is available? Returns viewer => boolean
 * (see lib/circles.js audienceOf: all, or the chosen shared circles).
 */
function audienceOf(owner) {
  // Required lazily: lib/circles requires this module's siblings
  return require("./circles").audienceOf(owner);
}

module.exports = { blockedWith, isBlocked, audienceOf };
