const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const momentRoutes = require("./routes/moment");

// Agora Token-Builder importieren
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

dotenv.config();

const AGORA_APP_ID = "28a507f76f1a400ba047aa629af4b81d";
const AGORA_APP_CERTIFICATE = "3fc8e469e8b241d3866c6a77aaec81ec";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB verbinden
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB verbunden"))
  .catch((err) => console.error("❌ Fehler bei MongoDB:", err));

// Routen einbinden
app.use("/auth", require("./routes/auth"));
app.use("/contacts", require("./routes/contacts"));
app.use("/status", require("./routes/status")(io));
app.use("/verify", require("./routes/verify"));
app.use("/me", require("./routes/me"));
app.use("/moment", momentRoutes);

// 🎯 Token Server für Agora – korrekt mit buildTokenWithAccount
app.post("/rtcToken", (req, res) => {
  const { channelName, uid, role } = req.body;

  console.log("📥 Token-Request empfangen:", { channelName, uid, role });

  if (!channelName || uid === undefined) {
    console.warn("⚠️ Ungültige Anfrage – channelName oder uid fehlt");
    return res
      .status(400)
      .json({ error: "channelName und uid sind erforderlich" });
  }

  const tokenRole =
    role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  try {
    // 👇 Logging für Debug
    console.log("🔐 Erstelle Token mit:");
    console.log("   📡 App ID:", AGORA_APP_ID);
    console.log(
      "   🔑 App Cert:",
      AGORA_APP_CERTIFICATE.substring(0, 4) + "...",
    );
    console.log("   📺 Channel:", channelName);
    console.log("   👤 Account (userAccount):", uid);
    console.log("   🎭 Rolle:", tokenRole);
    console.log(
      "   🕒 Gültig bis:",
      new Date(privilegeExpiredTs * 1000).toISOString(),
    );

    // 🟢 WICHTIG: Token mit "Account" (nicht UID!) erzeugen
    const token = RtcTokenBuilder.buildTokenWithAccount(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      String(uid), // sicherstellen, dass es ein String ist
      tokenRole,
      privilegeExpiredTs,
    );

    console.log("✅ Token erfolgreich generiert");
    return res.json({ token });
  } catch (err) {
    console.error(
      "❌ Fehler beim Erstellen des Tokens:",
      err.message,
      err.stack,
    );
    return res.status(500).json({ error: "Token-Generierung fehlgeschlagen" });
  }
});

// 🔌 WebSocket Logic
const userSockets = new Map(); // phone => socket.id

io.on("connection", (socket) => {
  console.log("🔌 WebSocket verbunden:", socket.id);

  socket.on("register", (phone) => {
    userSockets.set(phone, socket.id);
    console.log(`📱 User registriert: ${phone} → ${socket.id}`);
  });

  socket.on("callRequest", ({ from, to, channel }) => {
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("incomingCall", { from, channel });
      console.log(
        `📞 Weiterleitung: ${from} ruft ${to} an (Channel: ${channel})`,
      );
    } else {
      console.log(`❌ User ${to} nicht verbunden.`);
    }
  });

  socket.on("acceptCall", ({ from, to, channel }) => {
    const targetSocketId = userSockets.get(from);
    if (targetSocketId) {
      io.to(targetSocketId).emit("startCall", { channel, from: to });
      console.log(
        `✅ Anruf angenommen von ${to}, Info an ${from} weitergeleitet`,
      );
    }
  });

  socket.on("disconnect", () => {
    for (let [phone, id] of userSockets.entries()) {
      if (id === socket.id) {
        userSockets.delete(phone);
        console.log(`❌ Disconnected: ${phone}`);
        break;
      }
    }
  });
});

// Start
const PORT = 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`),
);
