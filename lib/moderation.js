/**
 * Support and moderation actions from the admin console. Each one works on a
 * user's phone number; the route writes the audit entry.
 */
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");
const BannedNumber = require("../models/BannedNumber");
const Report = require("../models/Report");
const gate = require("./accessGate");
const { deleteAccount } = require("./account");
const { sendExpoPushes } = require("./push");

const MAX_SUSPEND_DAYS = 365;

/** Mask a number for lists: "+49 ••• 111". */
const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)} ••• ${phone.slice(-3)}` : null);

/** Sign the user out on every device (tokens issued until now stop working). */
async function endSessions(phone, io, now = new Date()) {
  await User.updateOne({ phone }, { tokensValidAfter: now });
  gate.forget(phone);
  io?.in(`user:${phone}`).disconnectSockets(true);
}

/** Offline for everyone, then signed out. */
async function goOffline(phone, io) {
  const user = await User.findOneAndUpdate(
    { phone },
    { isAvailable: false, availableSource: null, momentActiveUntil: null, lastOnline: new Date() },
    { new: true },
  );
  if (user && io) {
    // Lazily: routes/status pulls in the whole status stack
    await require("../routes/status").broadcastStatus(io, user);
  }
  return user;
}

async function suspend(phone, { days, reason }, io, now = new Date()) {
  const span = Math.min(Math.max(Math.round(Number(days) || 0), 1), MAX_SUSPEND_DAYS);
  const until = new Date(now.getTime() + span * 24 * 3600 * 1000);
  await User.updateOne({ phone }, { suspendedUntil: until, suspendReason: String(reason || "").slice(0, 300) || null });
  await goOffline(phone, io);
  await endSessions(phone, io, now);
  return until;
}

async function unsuspend(phone) {
  await User.updateOne({ phone }, { suspendedUntil: null, suspendReason: null });
}

/** Delete the account and keep the number from coming back. */
async function ban(phone, { reason, by }, io) {
  await BannedNumber.updateOne(
    { hash: User.hashPhone(phone) },
    { $setOnInsert: { reason: String(reason || "").slice(0, 300), by, at: new Date() } },
    { upsert: true },
  );
  gate.forget(phone);
  io?.in(`user:${phone}`).disconnectSockets(true);
  await deleteAccount(phone, io);
}

/** Forget push tokens; the app registers fresh ones on its next start. */
async function resetPush(phone) {
  await User.updateOne({ phone }, { $unset: { pushToken: 1, pushTokenMetadata: 1, voipToken: 1, voipTokenMetadata: 1 } });
}

/** A visible test push. Returns "sent", "no_token" or the error. */
async function testPush(user) {
  if (!user.pushToken) return "no_token";
  const [ticket] = await sendExpoPushes([
    {
      to: user.pushToken,
      sound: "default",
      title: "Call Me Maybe",
      body: "Test vom Support: Benachrichtigungen kommen bei dir an. 👍",
      data: { type: "support_test" },
    },
  ]);
  if (!ticket) return "invalid_token";
  return ticket.status === "ok" ? "sent" : ticket.details?.error || ticket.message || "error";
}

/**
 * Apply a moderator's decision on a report. Returns how many open reports it
 * settled. (A ban deletes the account, and with it the reports about it; the
 * audit log keeps the decision.)
 */
async function resolveReport(report, { action, days, note }, admin, io) {
  const done = { status: "resolved", resolution: action, resolvedBy: admin.email, resolvedAt: new Date() };
  // A ban or suspension settles every open report against that person
  const filter = ["ban", "suspend"].includes(action)
    ? { reported: report.reported, status: "open" }
    : report.momentId && action !== "dismiss"
      ? { momentId: report.momentId, status: "open" }
      : { _id: report._id };
  const { modifiedCount } = await Report.updateMany(filter, done);

  const reason = note || `Meldung: ${report.reason}`;
  if (action === "hide_moment" && report.momentId) await CallMoment.updateOne({ _id: report.momentId }, { hidden: true });
  if (action === "delete_moment" && report.momentId) await CallMoment.deleteOne({ _id: report.momentId });
  if (action === "suspend") await suspend(report.reported, { days, reason }, io);
  if (action === "ban") await ban(report.reported, { reason, by: admin.email }, io);
  return modifiedCount;
}

module.exports = { maskPhone, endSessions, suspend, unsuspend, ban, resetPush, testPush, resolveReport, MAX_SUSPEND_DAYS };
