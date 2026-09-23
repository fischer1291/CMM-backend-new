require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const momentRoutes = require("./routes/moment");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const User = require("./models/User");
const reactionRoutes = require("./routes/reactions");
const { Expo } = require("expo-server-sdk");
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN, // Optional but recommended
  useFcmV1: true, // Use the newer FCM v1 API
});

// Agora Token-Builder importieren
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const apn = require("node-apn");

// VoIP push configuration
// One provider per APNs environment: development builds get sandbox tokens,
// TestFlight/App Store/ad-hoc builds get production tokens.
const voipProviders = { production: null, sandbox: null };
const VOIP_TOPIC = process.env.VOIP_TOPIC || "com.schly21.kontaktlisteapp.voip";

// Initialize VoIP push provider (iOS only)
function initializeVoipPush() {
  try {
    // Check if VoIP credentials are available
    if (
      process.env.VOIP_KEY_CONTENT &&
      process.env.VOIP_KEY_ID &&
      process.env.VOIP_TEAM_ID
    ) {
      const token = {
        key: process.env.VOIP_KEY_CONTENT.replace(/\\n/g, "\n"),
        keyId: process.env.VOIP_KEY_ID,
        teamId: process.env.VOIP_TEAM_ID,
      };
      voipProviders.production = new apn.Provider({ token, production: true });
      voipProviders.sandbox = new apn.Provider({ token, production: false });

      console.log("✅ VoIP push providers initialized (production + sandbox)");
      console.log("   - Environment:", process.env.NODE_ENV);
      console.log("   - Key ID:", process.env.VOIP_KEY_ID);
      console.log("   - Team ID:", process.env.VOIP_TEAM_ID);
    } else {
      console.log("⚠️ VoIP push not configured - missing credentials");
      console.log(
        "   - VOIP_KEY_CONTENT:",
        process.env.VOIP_KEY_CONTENT ? "Set" : "Missing",
      );
      console.log(
        "   - VOIP_KEY_ID:",
        process.env.VOIP_KEY_ID ? "Set" : "Missing",
      );
      console.log(
        "   - VOIP_TEAM_ID:",
        process.env.VOIP_TEAM_ID ? "Set" : "Missing",
      );
    }
  } catch (error) {
    console.error("❌ Failed to initialize VoIP push:", error.message);
  }
}

// Call this on startup
initializeVoipPush();

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

/**
 * Enhanced push token registration - update your existing endpoint
 */
app.post("/user/push-token", async (req, res) => {
  try {
    const { userPhone, token, deviceId, platform } = req.body;

    if (!userPhone || !token) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userPhone, token",
      });
    }

    // Validate the push token with enhanced checking
    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Expo push token format",
      });
    }

    // Update user's push token in database with additional metadata
    const user = await User.findOneAndUpdate(
      { phone: userPhone },
      {
        pushToken: token,
        pushTokenMetadata: {
          deviceId,
          platform,
          registeredAt: new Date(),
          lastValidated: new Date(),
        },
        lastOnline: new Date(),
      },
      { new: true, upsert: true },
    );

    console.log(
      `✅ Enhanced push token registered for ${userPhone}: ${token.substring(0, 20)}...`,
    );

    res.json({
      success: true,
      message: "Push token registered successfully",
      metadata: {
        platform,
        deviceId,
        registeredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("❌ Error registering push token:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/**
 * Register VoIP push token (iOS only)
 */
app.post("/user/voip-token", async (req, res) => {
  try {
    const { userPhone, voipToken, deviceId, platform } = req.body;

    if (!userPhone || !voipToken) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userPhone, voipToken",
      });
    }

    // A device belongs to one logged-in user: remove this token from anyone
    // else, otherwise their calls would keep ringing on this device.
    await User.updateMany(
      { voipToken, phone: { $ne: userPhone } },
      { $unset: { voipToken: 1, voipTokenMetadata: 1 } },
    );

    // Update user's VoIP token in database. The learned APNs environment is
    // kept unless the token itself changed.
    const existing = await User.findOne({ phone: userPhone }, "voipToken");
    const update = {
      $set: {
        voipToken: voipToken, // Store VoIP token separately
        "voipTokenMetadata.deviceId": deviceId,
        "voipTokenMetadata.platform": platform,
        "voipTokenMetadata.registeredAt": new Date(),
        lastOnline: new Date(),
      },
    };
    if (existing?.voipToken !== voipToken) {
      update.$unset = { "voipTokenMetadata.environment": 1 };
    }
    const user = await User.findOneAndUpdate({ phone: userPhone }, update, {
      new: true,
      upsert: true,
    });

    console.log(
      `✅ VoIP token registered for ${userPhone}: ${voipToken.substring(0, 20)}...`,
    );

    res.json({
      success: true,
      message: "VoIP token registered successfully",
    });
  } catch (error) {
    console.error("❌ Error registering VoIP token:", error);
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

/**
 * Health check endpoint for push notifications
 */
app.get("/api/push-health", async (req, res) => {
  try {
    const activeTokens = await User.countDocuments({
      pushToken: { $exists: true },
    });
    res.json({
      success: true,
      activeTokens,
      voipConfigured: !!voipProviders.production,
      sdkVersion: Expo.version,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send VoIP push notification for incoming call
 */
async function sendVoipPushNotification(
  callerPhone,
  calleePhone,
  channel,
  callerName,
  callId,
) {
  try {
    console.log(`📞 Attempting VoIP push: ${callerPhone} -> ${calleePhone}`);

    // Get callee's VoIP token
    const calleeUser = await User.findOne({ phone: calleePhone });
    if (!calleeUser || !calleeUser.voipToken) {
      console.log(`❌ No VoIP token found for user: ${calleePhone}`);
      return false;
    }

    // If VoIP is not configured, return false to fall back to regular push
    if (!voipProviders.production) {
      console.log(
        "⚠️ VoIP provider not configured, falling back to regular push",
      );
      return false;
    }

    const voipToken = calleeUser.voipToken;

    const buildNotification = () => {
      const notification = new apn.Notification();
      // VoIP notifications use a special topic: bundle ID + .voip
      notification.topic = VOIP_TOPIC;
      notification.pushType = "voip";
      // The app reports this to CallKit natively (AppDelegate.swift); callId
      // must match the socket event so both paths show the same call.
      notification.payload = {
        callId,
        callerPhone,
        calleePhone,
        channel,
        callerName: callerName || callerPhone,
        hasVideo: true,
        timestamp: Date.now(),
      };
      notification.priority = 10;
      notification.expiry = Math.floor(Date.now() / 1000) + 30;
      return notification;
    };

    // Try the environment that worked last time first; a token from the other
    // environment is rejected with BadDeviceToken.
    const known = calleeUser.voipTokenMetadata?.environment;
    const environments =
      known === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];

    for (const environment of environments) {
      const result = await voipProviders[environment].send(
        buildNotification(),
        voipToken,
      );

      if (result.sent && result.sent.length > 0) {
        if (known !== environment) {
          await User.updateOne(
            { phone: calleePhone },
            { "voipTokenMetadata.environment": environment },
          );
        }
        console.log(`✅ VoIP push sent (${environment}) to: ${calleePhone}`);
        return true;
      }

      const failure = result.failed && result.failed[0];
      const reason = failure?.response?.reason;
      console.error(`❌ VoIP push failed (${environment}):`, reason || failure?.error);

      if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
        continue; // wrong environment, try the other one
      }

      // 410 Unregistered: the token is no longer valid
      if (String(failure?.status) === "410" || reason === "Unregistered") {
        await User.updateOne(
          { phone: calleePhone },
          { $unset: { voipToken: 1, voipTokenMetadata: 1 } },
        );
        console.log(`🧹 Removed invalid VoIP token for user: ${calleePhone}`);
      }
      return false;
    }

    return false;
  } catch (error) {
    console.error("❌ Error sending VoIP push:", error);
    return false;
  }
}

/**
 * Enhanced push notification sending with proper error handling
 */
async function sendEnhancedCallNotification(
  callerPhone,
  calleePhone,
  channel,
  callerName,
  callId,
) {
  try {
    console.log(
      `📞 Sending enhanced call notification: ${callerPhone} -> ${calleePhone}`,
    );

    // Get callee's push token
    const calleeUser = await User.findOne({ phone: calleePhone });
    if (!calleeUser || !calleeUser.pushToken) {
      console.log(`❌ No push token found for user: ${calleePhone}`);
      return false;
    }

    const pushToken = calleeUser.pushToken;

    // Validate push token
    if (!Expo.isExpoPushToken(pushToken)) {
      console.log(`❌ Invalid push token for user: ${calleePhone}`);
      return false;
    }

    // Create enhanced notification message
    const message = {
      to: pushToken,
      sound: "default",
      title: `📞 ${callerName || callerPhone}`,
      body: "Videoanruf", // Simplified, consistent with frontend
      data: {
        type: "incoming_call",
        callId,
        callerPhone: callerPhone,
        calleePhone: calleePhone,
        channel: channel,
        callerName: callerName || callerPhone,
        hasVideo: true,
        timestamp: Date.now(),
      },
      categoryId: "incoming_call",
      priority: "high",
      ttl: 30,
      badge: 1,
      // Enhanced properties for better call experience
      android: {
        channelId: "incoming-calls",
        priority: "max",
        vibrate: [0, 250, 250, 250],
        color: "#FF0000",
        sticky: true,
        autoDismiss: false,
      },
      ios: {
        interruptionLevel: "active",
        relevanceScore: 1.0,
      },
    };

    // Send notification using expo-server-sdk
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];

    for (let chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error("❌ Error sending notification chunk:", error);
        return false;
      }
    }

    // Check for errors in tickets
    for (let ticket of tickets) {
      if (ticket.status === "error") {
        console.error("❌ Notification ticket error:", ticket.message);
        if (ticket.details && ticket.details.error === "DeviceNotRegistered") {
          // Remove invalid push token
          await User.findOneAndUpdate(
            { phone: calleePhone },
            { $unset: { pushToken: 1 } },
          );
          console.log(`🧹 Removed invalid push token for user: ${calleePhone}`);
        }
        return false;
      }
    }

    console.log(
      `✅ Enhanced call notification sent successfully to: ${calleePhone}`,
    );
    return true;
  } catch (error) {
    console.error("❌ Error in sendEnhancedCallNotification:", error);
    return false;
  }
}

/**
 * Send call end notification
 */
async function sendCallEndNotification(from, to, channel) {
  try {
    const calleeUser = await User.findOne({ phone: to });
    if (!calleeUser || !calleeUser.pushToken) return;

    const message = {
      to: calleeUser.pushToken,
      data: {
        type: "call_ended",
        channel: channel,
        from: from,
      },
      priority: "high",
    };

    await expo.sendPushNotificationsAsync([message]);
    console.log(`📞 Call end notification sent to: ${to}`);
  } catch (error) {
    console.error("❌ Error sending call end notification:", error);
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
    // One UUID per call, shared by socket event, VoIP push and CallKit
    const callId = crypto.randomUUID();
    console.log(`📞 Call request: ${from} -> ${to} (${channel}, ${callId})`);

    try {
      // Get caller's name for better UX
      const callerUser = await User.findOne({ phone: from });
      const callerName = callerUser?.name || from;

      // Try socket notification first (for online users)
      const targetSocketId = userSockets.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit("incomingCall", {
          callId,
          from,
          channel,
          callerName,
          timestamp: Date.now(),
        });
        console.log(`🔔 Socket notification sent to: ${to}`);
      }

      // Try VoIP push first (iOS only, works in background)
      let notificationSent = false;
      const voipSent = await sendVoipPushNotification(
        from,
        to,
        channel,
        callerName,
        callId,
      );

      if (voipSent) {
        console.log(`✅ VoIP push sent to: ${to}`);
        notificationSent = true;
      } else {
        // Fallback to regular push notification
        console.log(
          `⚠️ VoIP push failed/unavailable, using regular push for: ${to}`,
        );
        const pushSent = await sendEnhancedCallNotification(
          from,
          to,
          channel,
          callerName,
          callId,
        );
        notificationSent = pushSent;
      }

      if (!notificationSent && !targetSocketId) {
        console.log(
          `❌ Failed to notify user: ${to} (no socket, VoIP, or push)`,
        );
        socket.emit("callFailed", {
          reason: "User unreachable",
          target: to,
        });
      }
    } catch (error) {
      console.error("❌ Error handling call request:", error);
      socket.emit("callFailed", {
        reason: "Server error",
        target: to,
      });
    }
  });

  socket.on("acceptCall", ({ from, to, channel }) => {
    console.log(`📞 Call accepted: ${to} answered call from ${from} (${channel})`);

    const callerSocketId = userSockets.get(from);
    if (callerSocketId) {
      io.to(callerSocketId).emit("callAccepted", {
        channel,
        from: to,
        timestamp: Date.now()
      });
      console.log(`✅ Call accepted notification sent to caller: ${from}`);
    } else {
      console.log(`⚠️ Caller ${from} not connected via socket`);
    }
  });

  socket.on("callEnded", (data) => {
    const { from, to, channel } = data;
    console.log(`📞 Call ended: ${from} -> ${to} (${channel})`);

    // Notify the other party
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("callEnded", { from, channel });
    }

    // Send push notification to end call on remote device
    sendCallEndNotification(from, to, channel);
  });

  socket.on("disconnect", () => {
    // Remove user from socket map
    for (let [phone, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(phone);
        console.log(`📱 User disconnected: ${phone}`);
        break;
      }
    }
  });
});

// Export functions if using modules
module.exports = {
  sendEnhancedCallNotification,
  sendCallEndNotification,
};

// Start
const PORT = 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server läuft mit WebSocket auf Port ${PORT}`),
);
