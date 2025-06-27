const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const momentRoutes = require("./routes/moment");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const User = require("./models/User");

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

// Configure Cloudinary (add these to your environment variables)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // e.g., 'your-app-name'
  api_key: process.env.CLOUDINARY_API_KEY, // e.g., '123456789012345'
  api_secret: process.env.CLOUDINARY_API_SECRET, // e.g., 'abcdefghijklmnopqrstuvwxyz123'
});

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// New endpoint for avatar upload
app.post("/upload/avatar", upload.single("avatar"), async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Phone and avatar file required" });
    }

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            resource_type: "image",
            folder: "avatars", // Organize uploads in folders
            public_id: `avatar_${phone.replace("+", "")}`, // Unique filename
            overwrite: true, // Replace existing avatar
            transformation: [
              { width: 256, height: 256, crop: "fill", gravity: "face" }, // Auto-crop to face
              { quality: "auto", format: "auto" }, // Optimize file size
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        )
        .end(req.file.buffer);
    });

    // Update user in database with new avatar URL
    await User.findOneAndUpdate(
      { phone: phone },
      { avatarUrl: result.secure_url }, // This is the web URL!
      { upsert: true },
    );

    res.json({
      success: true,
      avatarUrl: result.secure_url,
      message: "Avatar uploaded successfully",
    });
  } catch (error) {
    console.error("Avatar upload error:", error);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

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

  socket.on("callEnded", ({ from, to, channel }) => {
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("callEnded", { from, channel });
      console.log(
        `📞 Call ended: ${from} ended call to ${to} (Channel: ${channel})`,
      );
    } else {
      console.log(`❌ User ${to} not connected for call end notification.`);
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
