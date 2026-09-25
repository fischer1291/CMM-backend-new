/**
 * Moderation state that app tokens must respect: sessions ended by support
 * (tokensValidAfter) and banned numbers. Cached per number for a minute, so a
 * request costs no extra query; admin actions update the cache right away.
 */
const User = require("../models/User");
const BannedNumber = require("../models/BannedNumber");

const TTL_MS = 60 * 1000;
const cache = new Map();

async function stateOf(phone) {
  const hit = cache.get(phone);
  if (hit && hit.expires > Date.now()) return hit.state;
  const [user, banned] = await Promise.all([
    User.findOne({ phone }, { tokensValidAfter: 1 }).lean(),
    BannedNumber.exists({ hash: User.hashPhone(phone) }),
  ]);
  const state = { validAfter: user?.tokensValidAfter?.getTime() || 0, banned: !!banned };
  cache.set(phone, { state, expires: Date.now() + TTL_MS });
  if (cache.size > 50_000) cache.delete(cache.keys().next().value);
  return state;
}

/** Is a token issued at `issuedAt` (seconds) still accepted for `phone`? */
async function tokenAllowed(phone, issuedAt) {
  const { validAfter, banned } = await stateOf(phone);
  if (banned) return false;
  // Tokens carry seconds; one issued in the same second as the cut-off is out
  return !validAfter || issuedAt * 1000 > validAfter;
}

const forget = (phone) => cache.delete(phone);
const reset = () => cache.clear();

/** Why `phone` may not sign in right now, or null. */
async function signInBlock(phone, now = new Date()) {
  if (await BannedNumber.exists({ hash: User.hashPhone(phone) })) {
    return "Diese Nummer ist für Call Me Maybe gesperrt.";
  }
  const user = await User.findOne({ phone }, { suspendedUntil: 1 }).lean();
  if (user?.suspendedUntil && user.suspendedUntil > now) {
    const until = user.suspendedUntil.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "long" });
    return `Dein Konto ist bis zum ${until} gesperrt.`;
  }
  return null;
}

module.exports = { tokenAllowed, forget, reset, signInBlock };
