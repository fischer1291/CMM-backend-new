/**
 * Support and moderation actions from the admin console. Each one works on a
 * user's phone number; the route writes the audit entry.
 *
 * Statement of reasons (DSA Art. 17, plan 2.7): a suspension and a hidden or
 * deleted moment open a support ticket (category "moderation") for the
 * person affected, with what was done, why (the reason typed in the
 * console), for how long, and how to object (by answering in that ticket),
 * plus the push support_reply. A ban deletes the account, so there is no one
 * to write to in the app; its reason stays in BannedNumber.reason.
 */
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");
const BannedNumber = require("../models/BannedNumber");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
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

const MAX_REASON = 300;
const cleanReason = (reason) => String(reason || "").trim().slice(0, MAX_REASON);

// What the statement says was done, and for how long
const MEASURES = {
  suspend: {
    what: () => "Wir haben dein Konto vorübergehend gesperrt. Solange kannst du dich nicht anmelden, und niemand kann dich anrufen.",
    span: (until, zone) => `Die Sperre endet am ${when(until, zone)} von selbst.`,
  },
  hide_moment: {
    what: () => "Wir haben einen Moment von dir ausgeblendet. Deine Freunde sehen ihn nicht mehr.",
    span: () => "Er bleibt ausgeblendet, bis wir anders entscheiden, zum Beispiel nach deinem Widerspruch.",
  },
  delete_moment: {
    what: () => "Wir haben einen Moment von dir gelöscht.",
    span: () => "Das ist dauerhaft, das Bild lässt sich nicht wiederherstellen.",
  },
};
const ACTIONS = Object.keys(MEASURES);

function when(date, zone) {
  const opts = { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return `${date.toLocaleString("de-DE", { ...opts, timeZone: zone || "Europe/Berlin" })} Uhr`;
  } catch {
    return `${date.toLocaleString("de-DE", { ...opts, timeZone: "Europe/Berlin" })} Uhr`;
  }
}

/** The text of the statement (German, for the person affected). */
function statementText(action, { reason, until, zone }) {
  const m = MEASURES[action];
  return [
    m.what(),
    `Grund: ${cleanReason(reason) || "Verstoß gegen unsere Nutzungsbedingungen"}`,
    m.span(until, zone),
    "Die Entscheidung hat ein Mensch aus unserem Team getroffen.",
    "Du kannst widersprechen: Antworte einfach hier. Wir sehen uns die Entscheidung dann noch einmal an.",
    // DSA Art. 17(3)(f): the redress routes beyond our own objection
    // (wording to be confirmed in the launch gate item lawyerReview)
    "Unabhängig davon kannst du dich an eine zertifizierte außergerichtliche Streitbeilegungsstelle wenden oder den Rechtsweg gehen.",
  ].join("\n\n");
}

/**
 * Write the statement of reasons to `phone` (action: suspend | hide_moment |
 * delete_moment): a ticket waiting for them, a socket event for open apps and
 * the push support_reply. Returns the ticket, or null when there is no such
 * account (a moment of someone already deleted). Never throws: the measure
 * itself is done either way.
 */
async function statementOfReasons(phone, { action, reason, until = null, by = null }, io) {
  try {
    if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
    // A moment without an author number: nobody to write to (and a query for
    // phone null would match any document without one)
    if (!phone) return null;
    const user = await User.findOne({ phone }, { phone: 1, timezone: 1 }).lean();
    if (!user) return null;
    const now = new Date();
    const ticket = await SupportTicket.create({
      phone,
      category: "moderation",
      status: "answered",
      unreadByUser: true,
      messages: [{ from: "support", text: statementText(action, { reason, until, zone: user.timezone }), by, at: now }],
      moderation: { action, until },
      createdAt: now,
      updatedAt: now,
    });
    io?.to(`user:${phone}`).emit("supportReply", { id: String(ticket._id) });
    await require("./notify").notify(phone, "support_reply", { moderation: true }).catch((err) => console.error("❌ statement push:", err.message));
    return ticket;
  } catch (err) {
    console.error("❌ statement of reasons:", err.message);
    return null;
  }
}

/** The author of a moment (older moments store the number without "+"). */
const authorOf = (moment) => (moment?.userPhone ? (moment.userPhone.startsWith("+") ? moment.userPhone : `+${moment.userPhone}`) : null);

async function suspend(phone, { days, reason, by = null }, io, now = new Date()) {
  const span = Math.min(Math.max(Math.round(Number(days) || 0), 1), MAX_SUSPEND_DAYS);
  const until = new Date(now.getTime() + span * 24 * 3600 * 1000);
  await User.updateOne({ phone }, { suspendedUntil: until, suspendReason: cleanReason(reason) || null });
  await goOffline(phone, io);
  await endSessions(phone, io, now);
  await statementOfReasons(phone, { action: "suspend", reason, until, by }, io);
  return until;
}

/**
 * Hide a moment and tell its author why, once per hiding: hiding it again
 * writes nothing, while one hidden automatically after reports
 * (routes/social.js) gets its statement now that support decided.
 */
async function hideMoment(moment, { reason, by }, io, now = new Date()) {
  const { modifiedCount } = await CallMoment.updateOne({ _id: moment._id, hiddenNoticeAt: null }, { hidden: true, hiddenNoticeAt: now });
  if (!modifiedCount) {
    await CallMoment.updateOne({ _id: moment._id }, { hidden: true });
    return false;
  }
  await statementOfReasons(authorOf(moment), { action: "hide_moment", reason, by }, io);
  return true;
}

/** Show a hidden moment again; a later hiding writes a new statement. */
async function unhideMoment(moment) {
  await CallMoment.updateOne({ _id: moment._id }, { hidden: false, hiddenNoticeAt: null });
}

/**
 * Delete a moment (with its picture) and tell its author why. Only the call
 * that actually removed it writes the statement, so two moderators deleting
 * at once send one. Returns whether this call deleted it.
 */
async function removeMoment(moment, { reason, by }, io) {
  if (!(await require("./moments").deleteMoment(moment))) return false;
  await statementOfReasons(authorOf(moment), { action: "delete_moment", reason, by }, io);
  return true;
}

async function unsuspend(phone) {
  await User.updateOne({ phone }, { suspendedUntil: null, suspendReason: null });
}

/**
 * Delete the account and keep the number from coming back. No statement of
 * reasons in the app (the account is gone); BannedNumber.reason keeps why.
 */
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
      title: "Wanna yap?",
      body: "Test vom Support: Benachrichtigungen kommen bei dir an. 👍",
      data: { type: "support_test" },
    },
  ]);
  if (!ticket) return "invalid_token";
  return ticket.status === "ok" ? "sent" : ticket.details?.error || ticket.message || "error";
}

// models/Report.js reasons as the statement names them
const REPORT_REASONS = { spam: "Spam", harassment: "Belästigung", inappropriate: "unangemessener Inhalte", other: "eines Verstoßes" };

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

  // The reason: the moderator's note (required by the route for every
  // action that writes a statement), else the report's (a ban, kept in
  // BannedNumber.reason)
  const reason = cleanReason(note) || `Meldung wegen ${REPORT_REASONS[report.reason] || "eines Verstoßes"}`;
  const moment = report.momentId && ["hide_moment", "delete_moment"].includes(action) ? await CallMoment.findById(report.momentId) : null;
  if (action === "hide_moment" && moment) await hideMoment(moment, { reason, by: admin.email }, io);
  if (action === "delete_moment" && moment) await removeMoment(moment, { reason, by: admin.email }, io);
  if (action === "suspend") await suspend(report.reported, { days, reason, by: admin.email }, io);
  if (action === "ban") await ban(report.reported, { reason, by: admin.email }, io);
  return modifiedCount;
}

module.exports = { maskPhone, endSessions, suspend, unsuspend, ban, resetPush, testPush, resolveReport, statementOfReasons, statementText, hideMoment, unhideMoment, removeMoment, MAX_SUSPEND_DAYS, MAX_REASON };
