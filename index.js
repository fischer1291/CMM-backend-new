const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const momentRoutes = require("./routes/moment");

dotenv.config();

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
app.use("/status", require("./routes/status")(io)); // io wird übergeben
app.use("/verify", require("./routes/verify"));
app.use("/me", require("./routes/me"));
app.use("/moment", momentRoutes);

// 🔌 WebSocket Logic
const userSockets = new Map(); // phone => socket.id

io.on("connection", (socket) => {
  console.log("🔌 WebSocket verbunden:", socket.id);

  // Registrierung eines Nutzers mit seiner Telefonnummer
  socket.on("register", (phone) => {
    userSockets.set(phone, socket.id);
    console.log(`📱 User registriert: ${phone} → ${socket.id}`);
  });

  // Handle eingehenden Call-Request
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

  // Handle Anruf-Annahme durch angerufenen User
  socket.on("acceptCall", ({ from, to, channel }) => {
    const targetSocketId = userSockets.get(from);
    if (targetSocketId) {
      io.to(targetSocketId).emit("startCall", { channel, from: to });
      console.log(
        `✅ Anruf angenommen von ${to}, Info an ${from} weitergeleitet`,
      );
    }
  });

  // Optional: Handle Disconnect
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
