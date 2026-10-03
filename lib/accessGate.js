/**
 * Moderation state that app tokens must respect: sessions ended by support
 * (tokensValidAfter) and banned numbers. Cached per number for a minute, so a
 * request costs no extra query; admin actions update the cache right away.
 */
const User = require("../models/User");
const BannedNumber = require("../models/BannedNumber");
const SupportTicket = require("../models/SupportTicket");

const TTL_MS = 60 * 1000;
// Where a suspended person objects while they cannot sign in (plan 2.7)
const APPEAL_EMAIL = "hallo@wannayap.app";
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

/**
 * Was the reason of this suspension written for the person? Only then does a
 * statement of reasons (lib/moderation.js) exist for exactly this end date.
 * Suspensions from before plan 2.7 stored suspendReason as an internal note
 * (the console said "Grund (intern)", the report queue filled in the
 * reporter's reason), so their text is never shown to the person.
 */
const reasonWasStated = (phone, until) =>
  SupportTicket.exists({ phone, category: "moderation", "moderation.action": "suspend", "moderation.until": until });

/**
 * Why `phone` may not sign in right now, or null. The moderator's reason is
 * free text written for the person affected (it can name others), so it is
 * only part of the answer with `withReason`, which the caller passes once the
 * SMS code is verified; before that anyone who types the number would read
 * it. `banOnly` checks the ban alone (routes/verify.js /start, which sends
 * the code to a suspended number as well, and /check, which looks at a
 * suspension after the code).
 */
async function signInBlock(phone, { withReason = false, banOnly = false, now = new Date() } = {}) {
  if (await BannedNumber.exists({ hash: User.hashPhone(phone) })) {
    return "Diese Nummer ist für Wanna yap? gesperrt.";
  }
  if (banOnly) return null;
  const user = await User.findOne({ phone }, { suspendedUntil: 1, suspendReason: 1 }).lean();
  if (user?.suspendedUntil && user.suspendedUntil > now) {
    const until = user.suspendedUntil.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "long" });
    // The statement of reasons (lib/moderation.js) waits in the app, which a
    // suspended person cannot open: the way to object comes here, and the
    // reason too once they proved the number is theirs
    const reason = withReason && user.suspendReason && (await reasonWasStated(phone, user.suspendedUntil)) ? ` (Grund: ${user.suspendReason})` : "";
    return `Dein Konto ist bis zum ${until} gesperrt${reason}. Du kannst widersprechen: Schreib uns an ${APPEAL_EMAIL}.`;
  }
  return null;
}

module.exports = { tokenAllowed, forget, reset, signInBlock };
