const crypto = require("crypto");
const User = require("./models/User");
const Call = require("./models/Call");
const { authenticateSocket } = require("./lib/auth");
const { normalizePhone, regionOf } = require("./lib/phone");
const {
  sendVoipPushNotification,
  sendEnhancedCallNotification,
  sendCallEndNotification,
} = require("./lib/push");

// Agora allows up to 64 chars; the app uses "call_<uuid>"
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Every socket of a user joins this room (several devices, reconnects)
const roomOf = (phone) => `user:${phone}`;

async function isOnline(io, phone) {
  const sockets = await io.in(roomOf(phone)).fetchSockets();
  return sockets.length > 0;
}

/**
 * Wires call signaling. Authenticated sockets always act as the phone in their
 * token; payload phone numbers are only trusted from legacy (token-less)
 * clients while AUTH_REQUIRED is off.
 */
function registerSocketHandlers(io) {
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const self = (claimed) =>
      socket.data.phone ||
      normalizePhone(String(claimed || ""), undefined, { preferInternational: true });

    // Authenticated sockets are registered right away (also after reconnects)
    if (socket.data.phone) {
      socket.join(roomOf(socket.data.phone));
    }

    socket.on("register", (phone) => {
      const me = self(phone);
      if (!me) return;
      socket.data.registeredPhone = me;
      socket.join(roomOf(me));
      console.log(`📱 User registriert: ${me} → ${socket.id}`);
    });

    socket.on("callRequest", async (data = {}) => {
      const from = self(data.from);
      const to = normalizePhone(String(data.to || ""), regionOf(from));
      const { channel } = data;

      if (!from || !to || from === to || typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) {
        socket.emit("callFailed", { reason: "Invalid call request", target: data.to });
        return;
      }

      // One UUID per call, shared by socket event, VoIP push and CallKit
      const callId = crypto.randomUUID();
      console.log(`📞 Call request: ${from} -> ${to} (${channel}, ${callId})`);

      try {
        await Call.create({ callId, channel, caller: from, callee: to });
      } catch (error) {
        const reason = error.code === 11000 ? "Channel already in use" : "Server error";
        socket.emit("callFailed", { reason, target: to });
        return;
      }

      try {
        // Get caller's name for better UX
        const callerUser = await User.findOne({ phone: from });
        const callerName = callerUser?.name || from;

        // Try socket notification first (for online users)
        const targetOnline = await isOnline(io, to);
        if (targetOnline) {
          io.to(roomOf(to)).emit("incomingCall", {
            callId,
            from,
            channel,
            callerName,
            timestamp: Date.now(),
          });
        }

        // VoIP push (iOS, works in background); regular push as fallback
        let notificationSent = await sendVoipPushNotification(from, to, channel, callerName, callId);
        if (!notificationSent) {
          notificationSent = await sendEnhancedCallNotification(from, to, channel, callerName, callId);
        }

        if (!notificationSent && !targetOnline) {
          console.log(`❌ Failed to notify user: ${to} (no socket, VoIP, or push)`);
          socket.emit("callFailed", { reason: "User unreachable", target: to });
        }
      } catch (error) {
        console.error("❌ Error handling call request:", error.message);
        socket.emit("callFailed", { reason: "Server error", target: to });
      }
    });

    socket.on("acceptCall", async ({ from, to, channel } = {}) => {
      const callee = self(to);
      const caller = normalizePhone(String(from || ""), regionOf(callee));
      if (!callee || !caller) return;

      const call = await Call.findOneAndUpdate(
        { channel, caller, callee },
        { status: "accepted" },
        { new: true },
      ).catch(() => null);
      if (!call && socket.data.phone) return; // unknown call

      io.to(roomOf(caller)).emit("callAccepted", { channel, from: callee, timestamp: Date.now() });
    });

    socket.on("callEnded", async ({ from, to, channel } = {}) => {
      const me = self(from);
      const other = normalizePhone(String(to || ""), regionOf(me));
      if (!me || !other) return;

      // Authenticated clients may only end calls they take part in
      const call = await Call.findOneAndUpdate(
        {
          channel,
          $or: [
            { caller: me, callee: other },
            { caller: other, callee: me },
          ],
        },
        { status: "ended", endedAt: new Date() },
        { new: true },
      ).catch(() => null);
      if (!call && socket.data.phone) return;

      console.log(`📞 Call ended: ${me} -> ${other} (${channel})`);
      io.to(roomOf(other)).emit("callEnded", { from: me, channel });
      sendCallEndNotification(me, other, channel);
    });
  });
}

module.exports = { registerSocketHandlers, roomOf };
