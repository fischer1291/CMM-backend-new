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
 * Both parties learn about the end through one event, "callEnded", with a
 * reason: declined | missed | cancelled | hangup | unavailable. Older app
 * versions only know "callEnded" and simply close the call.
 */
const crypto = require("crypto");
const User = require("../models/User");
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const {
  sendVoipPushNotification,
  sendEnhancedCallNotification,
  sendCallEndNotification,
} = require("./push");
const { notify } = require("./notify");
const { answerBetween } = require("./nudges");
const { isBlocked } = require("./relations");

const RING_TIMEOUT_MS = 45 * 1000;
// A ringing/accepted call older than this is treated as dead (e.g. an app
// crashed mid-call) and no longer makes the user busy.
const STALE_RINGING_MS = 90 * 1000;
const STALE_ACCEPTED_MS = 2 * 60 * 60 * 1000;
// Longer "talks" are most likely a call nobody hung up; stats count at most this
const MAX_TALK_SECONDS = 4 * 60 * 60;
// Ended calls replayed to a device that connects right after (see onRegister)
const REPLAY_WINDOW_MS = 60 * 1000;

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
   * Start a call. Returns { ok, reason?, call? }. Notifies the callee by
   * socket, VoIP push and/or regular push.
   */
  async function startCall({ from, to, channel, video = true }) {
    const callId = crypto.randomUUID();

    // Blocked either way: looks like the person just isn't reachable
    if (await isBlocked(from, to)) {
      return { ok: false, reason: "unreachable" };
    }

    if (await isBusy(to)) {
      await Call.create({ callId, channel, caller: from, callee: to, status: "busy", endedAt: new Date() });
      return { ok: false, reason: "busy" };
    }

    let call;
    try {
      call = await Call.create({ callId, channel, caller: from, callee: to, video });
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

    ringTimers.set(
      callId,
      setTimeout(() => {
        missCall(callId).catch((err) => console.error("❌ missCall:", err.message));
      }, ringTimeoutMs).unref(),
    );
    return { ok: true, call };
  }

  /** Nobody answered in time. */
  async function missCall(callId) {
    ringTimers.delete(callId);
    const call = await transition({ callId }, "ringing", { status: "missed", endedAt: new Date() });
    if (!call) return;

    io.to(roomOf(call.caller)).emit("callEnded", { from: call.callee, channel: call.channel, reason: "missed" });
    io.to(roomOf(call.callee)).emit("callEnded", { from: call.caller, channel: call.channel, reason: "missed" });
    sendCallEndNotification(call.caller, call.callee, call.channel);

    const caller = await User.findOne({ phone: call.caller }, "name");
    await notify(call.callee, "missed_call", { phone: call.caller, name: caller?.name });
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

  /** On startup: calls left ringing by a previous process are missed. */
  async function sweepStaleCalls() {
    const result = await Call.updateMany(
      { status: "ringing", createdAt: { $lt: new Date(Date.now() - STALE_RINGING_MS) } },
      { status: "missed", endedAt: new Date() },
    );
    return result.modifiedCount;
  }

  return { startCall, acceptCall, endCall, onRegister, sweepStaleCalls, missCall, recordTalk };
}

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
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt || null,
    endedAt: call.endedAt || null,
    durationSec,
  };
}

module.exports = { createCallService, historyEntry, RING_TIMEOUT_MS };
