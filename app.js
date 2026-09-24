const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { Server } = require("socket.io");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const User = require("./models/User");
const Call = require("./models/Call");
const { authenticate, actingPhone } = require("./lib/auth");
const { agoraCredentials, buildRtcToken } = require("./lib/agora");
const { Expo, voipProviders } = require("./lib/push");
const { registerSocketHandlers } = require("./socket");
const { createCallService, historyEntry } = require("./lib/calls");
const { setForegroundLookup } = require("./lib/notify");
const { isValidTimezone } = require("./lib/localTime");
const { normalizePhone, regionOf } = require("./lib/phone");

function createApp({ ringTimeoutMs } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  const calls = createCallService(io, { ringTimeoutMs });
  // Routes that aren't built with io (e.g. verify) reach it here
  app.set("io", io);

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  // Render sits behind a proxy; needed for correct client IPs in rate limits
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      skip: () => process.env.NODE_ENV === "test",
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );

  // Public routes
  app.use("/verify", require("./routes/verify"));

  app.get("/api/push-health", async (req, res) => {
    try {
      const activeTokens = await User.countDocuments({ pushToken: { $exists: true } });
      res.json({
        success: true,
        activeTokens,
        voipConfigured: !!voipProviders.production,
        authConfigured: !!process.env.JWT_SECRET,
        authRequired: process.env.AUTH_REQUIRED === "true",
        // Only whether the certificate comes from the environment, never the value
        agoraCertificateFromEnv: !agoraCredentials().usingLegacyCertificate,
        // Which commit is deployed (set by Render)
        version: (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ success: false });
    }
  });

  // Everything below knows the requesting user (req.auth) or is legacy
  app.use(authenticate);

  app.use("/auth", require("./routes/auth"));
  app.use("/contacts", require("./routes/contacts"));
  app.use("/status", require("./routes/status")(io));
  app.use("/me", require("./routes/me"));
  app.use("/moment", require("./routes/moment")(io));
  app.use("/moment", require("./routes/reactions"));
  app.use(require("./routes/gamification")(io));
  app.use(require("./routes/notifications"));
  app.use(require("./routes/account")(io));
  app.use(require("./routes/social")(io));
  app.use(require("./routes/daily")(io));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  app.post("/upload/avatar", upload.single("avatar"), async (req, res) => {
    const phone = actingPhone(req, res, req.body?.phone);
    if (!phone) return;
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Avatar image required" });
    }

    try {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              resource_type: "image",
              folder: "avatars",
              public_id: `avatar_${phone.replace("+", "")}`,
              overwrite: true,
              transformation: [
                { width: 256, height: 256, crop: "fill", gravity: "face" },
                { quality: "auto", format: "auto" },
              ],
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
          )
          .end(req.file.buffer);
      });

      await User.updateOne({ phone }, { avatarUrl: result.secure_url });
      res.json({ success: true, avatarUrl: result.secure_url });
    } catch (error) {
      console.error("Avatar upload error:", error.message);
      res.status(500).json({ success: false, message: "Upload failed" });
    }
  });

  // A moment's picture: stored on Cloudinary, the moment keeps only the URL
  app.post("/upload/moment", upload.single("image"), async (req, res) => {
    if (!req.auth) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Image required" });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              resource_type: "image",
              folder: "moments",
              public_id: `moment_${req.auth.phone.replace("+", "")}_${Date.now()}`,
              transformation: [{ width: 1080, crop: "limit" }, { quality: "auto", format: "jpg" }],
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
          )
          .end(req.file.buffer);
      });
      res.json({ success: true, url: result.secure_url });
    } catch (error) {
      console.error("Moment upload error:", error.message);
      res.status(500).json({ success: false, error: "Upload failed" });
    }
  });

  // Agora token. Authenticated users only get tokens for their own account
  // and for channels of calls they take part in.
  app.post("/rtcToken", async (req, res) => {
    const { channelName, uid, role } = req.body || {};
    if (typeof channelName !== "string" || !channelName || uid === undefined) {
      return res.status(400).json({ error: "channelName und uid sind erforderlich" });
    }

    if (req.auth) {
      const account = req.auth.phone.replace(/^\+/, "");
      if (String(uid) !== account) {
        return res.status(403).json({ error: "uid does not match token" });
      }
      const call = await Call.findOne({
        channel: channelName,
        $or: [{ caller: req.auth.phone }, { callee: req.auth.phone }],
      });
      if (!call) {
        return res.status(403).json({ error: "Not a participant of this call" });
      }
    }

    // The callee only fetches a token after answering. Treat that as the
    // answer too, so a lost acceptCall socket event can't let the ring
    // timeout end a call that is already connected.
    const requester = req.auth?.phone || `+${String(uid).replace(/^\+/, "")}`;
    const ringing = await Call.findOne({ channel: channelName, callee: requester, status: "ringing" });
    if (ringing) {
      await calls.acceptCall({ callee: ringing.callee, caller: ringing.caller, channel: channelName });
    }

    try {
      res.json({ token: buildRtcToken(channelName, uid, role) });
    } catch (err) {
      console.error("❌ Fehler beim Erstellen des Tokens:", err.message);
      res.status(500).json({ error: "Token-Generierung fehlgeschlagen" });
    }
  });

  app.post("/user/push-token", async (req, res) => {
    const phone = actingPhone(req, res, req.body?.userPhone);
    if (!phone) return;
    const { token, deviceId, platform, timezone } = req.body;
    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({ success: false, message: "Invalid Expo push token" });
    }
    const zone = isValidTimezone(timezone) ? { timezone } : {};

    try {
      // One device = one user: remove this token from anyone else
      await User.updateMany({ pushToken: token, phone: { $ne: phone } }, { $unset: { pushToken: 1 } });
      const user = await User.findOneAndUpdate(
        { phone },
        {
          pushToken: token,
          pushTokenMetadata: { deviceId, platform, registeredAt: new Date(), lastValidated: new Date() },
          lastOnline: new Date(),
          ...zone,
        },
        { new: true },
      );
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error registering push token:", error.message);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.post("/user/voip-token", async (req, res) => {
    const phone = actingPhone(req, res, req.body?.userPhone);
    if (!phone) return;
    const { voipToken, deviceId, platform } = req.body;
    if (typeof voipToken !== "string" || !/^[a-f0-9]{32,200}$/i.test(voipToken)) {
      return res.status(400).json({ success: false, message: "Invalid voipToken" });
    }

    try {
      // A device belongs to one logged-in user: remove this token from anyone
      // else, otherwise their calls would keep ringing on this device.
      await User.updateMany(
        { voipToken, phone: { $ne: phone } },
        { $unset: { voipToken: 1, voipTokenMetadata: 1 } },
      );

      // The learned APNs environment is kept unless the token itself changed
      const existing = await User.findOne({ phone }, "voipToken");
      if (!existing) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      const update = {
        $set: {
          voipToken,
          "voipTokenMetadata.deviceId": deviceId,
          "voipTokenMetadata.platform": platform,
          "voipTokenMetadata.registeredAt": new Date(),
          lastOnline: new Date(),
        },
      };
      if (existing.voipToken !== voipToken) {
        update.$unset = { "voipTokenMetadata.environment": 1 };
      }
      await User.updateOne({ phone }, update);
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error registering VoIP token:", error.message);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // Call history of the authenticated user
  app.get("/calls", async (req, res) => {
    if (!req.auth) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const phone = req.auth.phone;
    try {
      const list = await Call.find({ $or: [{ caller: phone }, { callee: phone }] })
        .sort({ createdAt: -1 })
        .limit(limit);
      res.json({ success: true, calls: list.map((c) => historyEntry(c, phone)) });
    } catch (error) {
      res.status(500).json({ success: false, error: "Anrufe konnten nicht geladen werden" });
    }
  });

  // POST /calls/end { channel, other }: decline, cancel or hang up over HTTP.
  // Same as the socket event, but works when the app was just woken in the
  // background (e.g. declined on the lock screen) and has no socket yet.
  app.post("/calls/end", async (req, res) => {
    if (!req.auth) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    const { channel } = req.body || {};
    const other = normalizePhone(String(req.body?.other || ""), regionOf(req.auth.phone));
    if (typeof channel !== "string" || !channel || !other) {
      return res.status(400).json({ success: false, error: "channel and other required" });
    }
    try {
      const call = await calls.endCall({ me: req.auth.phone, other, channel });
      // Already over (e.g. ended by the socket event first) is fine too
      res.json({ success: true, status: call?.status ?? null });
    } catch (error) {
      console.error("❌ /calls/end:", error.message);
      res.status(500).json({ success: false, error: "Call could not be ended" });
    }
  });

  registerSocketHandlers(io, calls);
  setForegroundLookup(async (phones) => {
    const states = new Map();
    if (!phones.length) return states;
    const sockets = await io.in(phones.map((p) => `user:${p}`)).fetchSockets();
    for (const s of sockets) {
      if (!s.data.phone) continue;
      // Any device in the foreground counts
      if (s.data.foreground) states.set(s.data.phone, "foreground");
      else if (!states.has(s.data.phone)) states.set(s.data.phone, "background");
    }
    return states;
  });

  return { app, server, io, calls };
}

module.exports = { createApp };
