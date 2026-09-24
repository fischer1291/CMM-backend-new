const { authenticateSocket } = require("./lib/auth");
const { normalizePhone, regionOf } = require("./lib/phone");

// Agora allows up to 64 chars; the app uses "call_<uuid>"
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Every socket of a user joins this room (several devices, reconnects)
const roomOf = (phone) => `user:${phone}`;

/**
 * Wires call signaling to the call service (lib/calls.js). Authenticated
 * sockets always act as the phone in their token; payload phone numbers are
 * only trusted from legacy (token-less) clients while AUTH_REQUIRED is off.
 */
function registerSocketHandlers(io, calls) {
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const self = (claimed) =>
      socket.data.phone ||
      normalizePhone(String(claimed || ""), undefined, { preferInternational: true });
    const other = (me, claimed) => normalizePhone(String(claimed || ""), regionOf(me));

    const register = (phone) => {
      socket.join(roomOf(phone));
      calls.onRegister(socket, phone).catch((err) => console.error("❌ onRegister:", err.message));
    };

    // Authenticated sockets are registered right away (also after reconnects)
    if (socket.data.phone) {
      socket.join(roomOf(socket.data.phone));
    }

    // The app reports whether it is in the foreground (AppState). Pushes
    // the app would show as a live banner are skipped for such users.
    socket.data.foreground = false;
    socket.on("presence", (data) => {
      socket.data.foreground = data?.foreground === true;
    });

    socket.on("register", (phone) => {
      const me = self(phone);
      if (me) register(me);
    });

    socket.on("callRequest", async (data = {}) => {
      const from = self(data.from);
      const to = other(from, data.to);
      const { channel } = data;

      if (!from || !to || from === to || typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) {
        socket.emit("callFailed", { reason: "invalid", target: data.to, channel });
        return;
      }

      try {
        const result = await calls.startCall({ from, to, channel, video: data.video !== false });
        if (!result.ok) {
          socket.emit("callFailed", { reason: result.reason, target: to, channel });
        }
      } catch (error) {
        console.error("❌ Error handling call request:", error.message);
        socket.emit("callFailed", { reason: "server_error", target: to, channel });
      }
    });

    socket.on("acceptCall", async ({ from, to, channel } = {}) => {
      const callee = self(to);
      const caller = other(callee, from);
      if (!callee || !caller || typeof channel !== "string") return;
      await calls.acceptCall({ callee, caller, channel }).catch((err) =>
        console.error("❌ acceptCall:", err.message),
      );
    });

    socket.on("callEnded", async ({ from, to, channel } = {}) => {
      const me = self(from);
      const peer = other(me, to);
      if (!me || !peer || typeof channel !== "string") return;
      await calls.endCall({ me, other: peer, channel }).catch((err) =>
        console.error("❌ endCall:", err.message),
      );
    });
  });
}

module.exports = { registerSocketHandlers, roomOf };
