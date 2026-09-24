/**
 * Nudge rules. A nudge is a gentle "I'd like to talk"; it must never turn
 * into pressure:
 *
 * - visible to the recipient for VISIBLE_MS, and only while open
 * - resolved as "answered" when the recipient becomes available or the two
 *   talk; "dismissed" when the recipient taps it away (the sender is not told)
 * - next nudge to the same person: ANSWERED_COOLDOWN after an answered one,
 *   OPEN_COOLDOWN otherwise (unanswered or dismissed)
 * - after UNANSWERED_STREAK unanswered nudges in a row: a REST_MS pause
 */
const Nudge = require("../models/Nudge");

const HOUR = 3600 * 1000;
const VISIBLE_MS = 4 * HOUR;
const ANSWERED_COOLDOWN_MS = 1 * HOUR;
const OPEN_COOLDOWN_MS = 24 * HOUR;
const UNANSWERED_STREAK = 3;
const REST_MS = 7 * 24 * HOUR;

/** When `from` may nudge `to` next: { allowedAt: Date|null, reason } (null = now). */
async function nextNudgeAllowed(from, to, now = new Date()) {
  const history = await Nudge.find({ from, to }).sort({ createdAt: -1 }).limit(UNANSWERED_STREAK).lean();
  const last = history[0];
  if (!last) return { allowedAt: null };

  const unanswered = history.filter((n) => n.status !== "answered");
  if (unanswered.length === UNANSWERED_STREAK && history.length === UNANSWERED_STREAK) {
    const until = new Date(last.createdAt.getTime() + REST_MS);
    if (until > now) return { allowedAt: until, reason: "resting" };
  }

  const until =
    last.status === "answered"
      ? new Date((last.resolvedAt || last.createdAt).getTime() + ANSWERED_COOLDOWN_MS)
      : new Date(last.createdAt.getTime() + OPEN_COOLDOWN_MS);
  return until > now ? { allowedAt: until, reason: "already_nudged" } : { allowedAt: null };
}

/** Recipient became available or the two talked: their open nudges are answered. */
async function answerNudges(filter, now = new Date()) {
  await Nudge.updateMany({ ...filter, status: "open" }, { status: "answered", resolvedAt: now });
}

/** Both directions between two people (after they talked). */
const answerBetween = (a, b, now) =>
  answerNudges({ $or: [{ from: a, to: b }, { from: b, to: a }] }, now);

module.exports = { nextNudgeAllowed, answerNudges, answerBetween, VISIBLE_MS, ANSWERED_COOLDOWN_MS, OPEN_COOLDOWN_MS, REST_MS };
