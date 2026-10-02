/**
 * Call lifecycle on the server. One Call document per call request:
 *
 *   ringing --accept--> accepted --end--> ended
 *   ringing --end by callee--> declined
 *   ringing --end by caller--> cancelled
 *   ringing --no answer in RING_TIMEOUT_MS--> missed
 *   (callee already in a call) --> busy, never rings
 *
 * Every transition is a conditional update on the current status, so
 * concurrent events (e.g. accept and timeout) can't both win.
 *
 * The ring timeout lives twice: as a process timer (fast path) and as
 * Call.ringUntil in the database, read by sweepStaleCalls on every leader
 * minute tick. A deploy or crash loses the timers; the next instance's sweep
 * ends those rings exactly like the timer would have.
 *
 * Both parties learn about the end through one event, "callEnded", with a
 * reason: declined | missed | cancelled | hangup | unavailable. Older app
 * versions only know "callEnded" and simply close the call.
 */
const crypto = require("crypto");
const User = require("../models/User");
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const { noteUnlockFor, MIN_SECONDS: MIN_UNLOCK_SECONDS } = require("./unlock");
const {
  sendVoipPushNotification,
  sendEnhancedCallNotification,
  sendCallEndNotification,
} = require("./push");
const { notify } = require("./notify");
const { answerBetween } = require("./nudges");
const { isBlocked, isConnected } = require("./relations");
const { flag } = require("./appConfig");
const opsCounters = require("./opsCounters");
const { noteFirstTalk } = require("./referral");
const { isPlus, videoAllowed } = require("./plan");

const RING_TIMEOUT_MS = 45 * 1000;
// A ringing/accepted call older than this is treated as dead (e.g. an app
// crashed mid-call) and no longer makes the user busy.
const STALE_RINGING_MS = 90 * 1000;
const STALE_ACCEPTED_MS = 2 * 60 * 60 * 1000;
// Longer "talks" are most likely a call nobody hung up; stats count at most this
const MAX_TALK_SECONDS = 4 * 60 * 60;
// Ended calls replayed to a device that connects right after (see onRegister)
const REPLAY_WINDOW_MS = 60 * 1000;
// After this many talks the app invites to a research call with the founder
const RESEARCH_INVITE_TALKS = 2;

const roomOf = (phone) => `user:${phone}`;

function createCallService(io, { ringTimeoutMs = RING_TIMEOUT_MS } = {}) {
  const ringTimers = new Map(); // callId -> timeout

  const clearRingTimer = (callId) => {
    clearTimeout(ringTimers.get(callId));
    ringTimers.delete(callId);
  };

  /** Atomically move a call from one status to another; null if it wasn't in `from`. */
  const transition = (filter, from, update) =>
    Call.findOneAndUpdate({ ...filter, status: { $in: [].concat(from) } }, update, { new: true });

  async function isBusy(phone) {
    const now = Date.now();
    const active = await Call.findOne({
      $and: [
        { $or: [{ caller: phone }, { callee: phone }] },
        {
          $or: [
            { status: "ringing", createdAt: { $gt: new Date(now - STALE_RINGING_MS) } },
            { status: "accepted", acceptedAt: { $gt: new Date(now - STALE_ACCEPTED_MS) } },
          ],
        },
      ],
    });
    return !!active;
  }

  async function isOnline(phone) {
    const sockets = await io.in(roomOf(phone)).fetchSockets();
    return sockets.length > 0;
  }

  /**
   * Start a call. Returns { ok, reason?, call?, videoDowngraded? }. Notifies
   * the callee by socket, VoIP push and/or regular push. A video call whose
   * caller may not use video (plan limit `video`: false, or this month's
   * video minutes used up) starts as audio, and the result says
   * videoDowngraded: "plan_limit". With the default limits (video true for
   * both plans) nothing changes.
   */
  async function startCall({ from, to, channel, video = true }) {
    const callId = crypto.randomUUID();
    let videoDowngraded = null;

    // Blocked either way: looks like the person just isn't reachable
    if (await isBlocked(from, to)) {
      return { ok: false, reason: "unreachable" };
    }

    // Strangers can't ring anyone: both must know each other (address book
    // match on both sides, an invite, or a shared circle). The flag
    // calls_strict_contacts=false switches the check off during a rollout.
    if ((await flag("calls_strict_contacts", true)) && !(await isConnected(from, to))) {
      opsCounters.count("callsRejectedNotConnected").catch((err) => console.error("❌ opsCounters:", err.message));
      return { ok: false, reason: "not_connected" };
    }

    if (video && !(await videoAllowed(from))) {
      video = false;
      videoDowngraded = "plan_limit";
    }

    if (await isBusy(to)) {
      await Call.create({ callId, channel, caller: from, callee: to, status: "busy", endedAt: new Date() });
      return { ok: false, reason: "busy" };
    }

    let call;
    try {
      call = await Call.create({ callId, channel, caller: from, callee: to, video, ringUntil: new Date(Date.now() + ringTimeoutMs) });
    } catch (error) {
      return { ok: false, reason: error.code === 11000 ? "channel_in_use" : "server_error" };
    }
    const callerUser = await User.findOne({ phone: from }, "name");
    const callerName = callerUser?.name || from;

    const targetOnline = await isOnline(to);
    if (targetOnline) {
      io.to(roomOf(to)).emit("incomingCall", { callId, from, channel, callerName, hasVideo: video, timestamp: Date.now() });
    }

    // VoIP push (iOS, works in background); regular push as fallback
    let notified = await sendVoipPushNotification(from, to, channel, callerName, callId, video);
    if (!notified) {
      notified = await sendEnhancedCallNotification(from, to, channel, callerName, callId, video);
    }

    if (!notified && !targetOnline) {
      await transition({ callId }, "ringing", { status: "missed", endedAt: new Date() });
      return { ok: false, reason: "unreachable", call };
    }
    // Milestone: the caller's first call that actually rang somebody (socket
    // or push went out); never overwritten
    await User.updateOne({ phone: from, "milestones.firstCallAt": null }, { $set: { "milestones.firstCallAt": call.createdAt || new Date() } });

    ringTimers.set(
      callId,
      setTimeout(() => {
        missCall(callId).catch((err) => console.error("❌ missCall:", err.message));
      }, ringTimeoutMs).unref(),
    );
    return videoDowngraded ? { ok: true, call, videoDowngraded } : { ok: true, call };
  }

  /**
   * Nobody answered in time: both sides hear callEnded/missed, the callee
   * gets the missed-call push. Called by the ring timer and by the sweep
   * (`endedAt` = the deadline that passed). Returns the call or null when it
   * was no longer ringing.
   */
  async function missCall(callId, endedAt = new Date()) {
    clearRingTimer(callId);
    const call = await transition({ callId }, "ringing", { status: "missed", endedAt });
    if (!call) return null;

    io.to(roomOf(call.caller)).emit("callEnded", { from: call.callee, channel: call.channel, reason: "missed" });
    io.to(roomOf(call.callee)).emit("callEnded", { from: call.caller, channel: call.channel, reason: "missed" });
    sendCallEndNotification(call.caller, call.callee, call.channel);

    const caller = await User.findOne({ phone: call.caller }, "name");
    await notify(call.callee, "missed_call", { phone: call.caller, name: caller?.name });
    return call;
  }

  /** The callee answered. */
  async function acceptCall({ callee, caller, channel }) {
    const call = await transition({ channel, caller, callee }, "ringing", {
      status: "accepted",
      acceptedAt: new Date(),
    });
    if (!call) {
      // Too late (cancelled/missed): make the callee's device hang up
      io.to(roomOf(callee)).emit("callEnded", { from: caller, channel, reason: "unavailable" });
      return null;
    }
    clearRingTimer(call.callId);
    io.to(roomOf(caller)).emit("callAccepted", { channel, from: callee, timestamp: Date.now() });
    // They're talking: open nudges between them are answered
    answerBetween(caller, callee).catch((err) => console.error("❌ answerBetween:", err.message));
    return call;
  }

  /** Keep an answered call for talk-time stats. */
  async function recordTalk(call) {
    if (!call.acceptedAt || !call.endedAt) return;
    const seconds = Math.min(Math.round((call.endedAt - call.acceptedAt) / 1000), MAX_TALK_SECONDS);
    if (seconds <= 0) return;
    await Talk.updateOne(
      { callId: call.callId },
      { $setOnInsert: { participants: [call.caller, call.callee], startedAt: call.acceptedAt, seconds } },
      { upsert: true },
    );
    // Talking unlocks the day's moments (and counts for the streak)
    if (seconds >= MIN_UNLOCK_SECONDS) await noteUnlockFor([call.caller, call.callee], "talk", call.endedAt);
    await noteFirstTalk([call.caller, call.callee], call.acceptedAt, io);
    await noteResearchInvite([call.caller, call.callee], call.endedAt);
  }

  /**
   * `me` ends the call with `other`. What that means depends on the state:
   * ringing + caller = cancelled, ringing + callee = declined,
   * accepted = ended. Returns the updated call or null.
   */
  async function endCall({ me, other, channel }) {
    const now = new Date();
    const asCaller = { channel, caller: me, callee: other };
    const asCallee = { channel, caller: other, callee: me };

    let call = await transition(asCaller, "ringing", { status: "cancelled", endedAt: now });
    if (call) {
      clearRingTimer(call.callId);
      io.to(roomOf(other)).emit("callEnded", { from: me, channel, reason: "cancelled" });
      sendCallEndNotification(me, other, channel);
      return call;
    }

    call = await transition(asCallee, "ringing", { status: "declined", endedAt: now });
    if (call) {
      clearRingTimer(call.callId);
      io.to(roomOf(other)).emit("callEnded", { from: me, channel, reason: "declined" });
      return call;
    }

    call =
      (await transition(asCaller, "accepted", { status: "ended", endedAt: now })) ||
      (await transition(asCallee, "accepted", { status: "ended", endedAt: now }));
    if (call) {
      io.to(roomOf(other)).emit("callEnded", { from: me, channel, reason: "hangup" });
      sendCallEndNotification(me, other, channel);
      recordTalk(call).catch((err) => console.error("❌ recordTalk:", err.message));
    }
    return call;
  }

  /**
   * A device of `phone` just connected. If a call to it was cancelled or
   * missed moments ago (e.g. the app was woken by a VoIP push and is still
   * starting), tell it now so CallKit stops ringing.
   */
  async function onRegister(socket, phone) {
    const recent = await Call.find({
      callee: phone,
      status: { $in: ["cancelled", "missed"] },
      endedAt: { $gt: new Date(Date.now() - REPLAY_WINDOW_MS) },
    });
    for (const call of recent) {
      socket.emit("callEnded", { from: call.caller, channel: call.channel, reason: call.status });
    }
  }

  /**
   * The safety net under the process timers, run at startup and on every
   * leader minute tick: a call still ringing past its deadline (ringUntil, or
   * for documents from before that field existed, STALE_RINGING_MS after it
   * started) is missed exactly like the timer does it, with callEnded to both
   * rooms and the missed-call push. An accepted call nobody hung up for
   * STALE_ACCEPTED_MS is ended as of that limit and counted as a talk
   * (recordTalk caps the time); nobody is told, those devices are long gone.
   * Returns the number of calls it ended. Idempotent: every change is a
   * conditional transition, so a timer or a second sweep finds nothing left.
   */
  async function sweepStaleCalls(now = new Date()) {
    let count = 0;
    const overdue = await Call.find(
      {
        status: "ringing",
        $or: [{ ringUntil: { $lte: now } }, { ringUntil: null, createdAt: { $lt: new Date(now.getTime() - STALE_RINGING_MS) } }],
      },
      { callId: 1, ringUntil: 1 },
    ).lean();
    for (const { callId, ringUntil } of overdue) {
      if (await missCall(callId, ringUntil || now)) count++;
    }

    const hung = await Call.find({ status: "accepted", acceptedAt: { $lt: new Date(now.getTime() - STALE_ACCEPTED_MS) } }, { callId: 1, acceptedAt: 1 }).lean();
    for (const { callId, acceptedAt } of hung) {
      const call = await transition({ callId }, "accepted", { status: "ended", endedAt: new Date(acceptedAt.getTime() + STALE_ACCEPTED_MS) });
      if (!call) continue;
      count++;
      await recordTalk(call);
    }
    return count;
  }

  return { startCall, acceptCall, endCall, onRegister, sweepStaleCalls, missCall, recordTalk };
}

/**
 * The second talk is when someone has seen the app work: invite them to a
 * 15-minute research call (User.research.invitedAt, shown as a card by the
 * app). Counted on Talk documents like lib/stats.js does (1:1 talks with
 * the person, group rounds only their own record), so a talk recorded twice
 * (startup replay) still counts once and a round with three people is one
 * talk, not three. `>=` so that a person who got past two in a round or who
 * was active before this existed is asked on their next talk; the
 * conditional update sets invitedAt only once. People with an admin Plus
 * grant (testers, friends who have it anyway) are not asked: the thank-you
 * would mean nothing to them.
 */
async function noteResearchInvite(phones, at) {
  for (const phone of phones) {
    const talks = await Talk.countDocuments({ $or: [{ group: { $ne: true }, participants: phone }, { group: true, owner: phone }] });
    if (talks < RESEARCH_INVITE_TALKS) continue;
    const user = await User.findOne({ phone, "research.invitedAt": null }, { plus: 1 }).lean();
    if (!user || (isPlus(user) && user.plus.source === "admin")) continue;
    await User.updateOne({ phone, "research.invitedAt": null }, { $set: { "research.invitedAt": at || new Date() } });
  }
}

// Incoming calls that rang without being answered (the caller gave up, it
// timed out, or the callee was already in a call)
const MISSED = ["missed", "cancelled", "busy"];

/** Call history entry from the point of view of `phone`. */
function historyEntry(call, phone) {
  const outgoing = call.caller === phone;
  const durationSec =
    call.acceptedAt && call.endedAt ? Math.round((call.endedAt - call.acceptedAt) / 1000) : 0;
  return {
    callId: call.callId,
    direction: outgoing ? "outgoing" : "incoming",
    otherPhone: outgoing ? call.callee : call.caller,
    status: call.status,
    missed: !outgoing && MISSED.includes(call.status),
    video: call.video !== false,
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt || null,
    endedAt: call.endedAt || null,
    durationSec,
  };
}

module.exports = { createCallService, historyEntry, noteResearchInvite, MISSED, RING_TIMEOUT_MS, RESEARCH_INVITE_TALKS };
