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
const reactionRoutes = require("./routes/reactions");

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
app.use("/moment", reactionRoutes);

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

// Push token registration endpoint
app.post("/user/push-token", async (req, res) => {
  try {
    const { userPhone, token, deviceId, platform } = req.body;

    if (!userPhone || !token) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userPhone, token",
      });
    }

    // Validate the push token
    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Expo push token",
      });
    }

    // Update user's push token in database
    const user = await User.findOneAndUpdate(
      { phone: userPhone },
      {
        pushToken: token,
        lastOnline: new Date(),
      },
      { new: true, upsert: true },
    );

    console.log(
      `Push token registered for user ${userPhone}: ${token.substring(0, 20)}...`,
    );

    res.json({
      success: true,
      message: "Push token registered successfully",
    });
  } catch (error) {
    console.error("Error registering push token:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Debug endpoint to check user's push token
app.get("/user/push-token/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await User.findOne({ phone });

    if (user && user.pushToken) {
      res.json({
        success: true,
        hasToken: true,
        tokenPreview: user.pushToken.substring(0, 20) + "...",
        lastOnline: user.lastOnline,
      });
    } else {
      res.json({
        success: false,
        hasToken: false,
        message: "No push token found for this user",
      });
    }
  } catch (error) {
    console.error("Error fetching push token:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Function to send push notification for incoming calls
async function sendCallNotification(
  callerPhone,
  calleePhone,
  channel,
  callerName = null,
) {
  try {
    // Find the callee's push token
    const calleeUser = await User.findOne({ phone: calleePhone });

    if (!calleeUser || !calleeUser.pushToken) {
      console.log(`No push token found for user ${calleePhone}`);
      return false;
    }

    const { pushToken } = calleeUser;

    // Create the push notification message using the SAME format as status.js
    const message = {
      to: pushToken,
      sound: "default",
      title: callerName ? `${callerName} ruft dich an` : "Eingehender Anruf",
      body: callerName
        ? `${callerName} möchte mit dir sprechen`
        : `${callerPhone} ruft dich an`,
      data: {
        type: "incoming_call",
        callerPhone: callerPhone,
        channel: channel,
        callerName: callerName,
      },
      priority: "high",
      ttl: 30,
      badge: 1,
    };

    // Use the SAME HTTP method as status.js (not expo-server-sdk)
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([message]),
    });

    const result = await response.json();
    console.log("Push notification sent (HTTP method):", result);

    if (result.data && result.data[0] && result.data[0].status === "ok") {
      console.log("✅ Call notification sent successfully");
      return true;
    } else {
      console.log("❌ Call notification failed:", result);
      return false;
    }
  } catch (error) {
    console.error("Error sending call notification:", error);
    return false;
  }
}

// 🔌 WebSocket Logic
const userSockets = new Map(); // phone => socket.id

io.on("connection", (socket) => {
  console.log("🔌 WebSocket verbunden:", socket.id);

  socket.on("register", (phone) => {
    userSockets.set(phone, socket.id);
    console.log(`📱 User registriert: ${phone} → ${socket.id}`);
  });

  socket.on("callRequest", async (data) => {
    const { from, to, channel } = data;

    try {
      console.log(`Call request from ${from} to ${to} on channel ${channel}`);

      // Get caller's name for the notification
      let callerName = null;
      try {
        const callerUser = await User.findOne({ phone: from });
        if (callerUser && callerUser.name) {
          callerName = callerUser.name;
        }
      } catch (err) {
        console.log("Could not fetch caller name:", err);
      }

      // Always send push notification (like status notifications do)
      console.log(`Sending push notification to ${to}`);
      await sendCallNotification(from, to, channel, callerName);

      // Also send socket notification if connected
      const calleeSocket = userSockets.get(to);
      if (calleeSocket) {
        console.log(
          `User ${to} is also connected via socket, sending real-time notification`,
        );
        io.to(calleeSocket).emit("incomingCall", {
          from,
          channel,
          callerName,
        });
      } else {
        console.log(`User ${to} not connected via socket`);
      }

      console.log(
        `Call request processed for ${from} to ${to} on channel ${channel}`,
      );
    } catch (error) {
      console.error("Error handling call request:", error);
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
