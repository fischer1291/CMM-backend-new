/**
 * Admin console API (/admin/*). Sign-in with e-mail, password and TOTP; the
 * session lives in an HttpOnly cookie (lib/adminAuth.js). Mounted before the
 * app's token check, since the console has no app token.
 */
const express = require("express");
const QRCode = require("qrcode");
const { rateLimit } = require("express-rate-limit");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const User = require("../models/User");
const Room = require("../models/Room");
const Report = require("../models/Report");
const {
  hashPassword,
  checkPassword,
  strongEnough,
  newTotpSecret,
  checkTotp,
  otpauthUrl,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  audit,
  requireAdmin,
} = require("../lib/adminAuth");
const metrics = require("../lib/metrics");

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const me = (admin) => ({ email: admin.email, role: admin.role, lastLoginAt: admin.lastLoginAt });

module.exports = () => {
  const router = express.Router();

  // Few tries for anything that takes a password or code
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skip: () => process.env.NODE_ENV === "test",
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  router.use("/admin/auth", authLimit);

  // Is there an admin yet? The console shows setup or login.
  router.get("/admin/auth/state", async (req, res) => {
    const ready = await Admin.exists({ totpEnabled: true });
    res.json({ success: true, setupNeeded: !ready });
  });

  /**
   * First admin: only while none is set up, and only with ADMIN_API_KEY
   * (from Render). Returns the TOTP secret to scan; confirm with a code.
   */
  router.post("/admin/auth/setup", async (req, res) => {
    const { email, password, setupKey } = req.body || {};
    const key = process.env.ADMIN_API_KEY;
    if (!key || setupKey !== key) return res.status(403).json({ success: false, error: "wrong_setup_key" });
    if (await Admin.exists({ totpEnabled: true })) return res.status(409).json({ success: false, error: "already_set_up" });
    if (!EMAIL.test(String(email || ""))) return res.status(400).json({ success: false, error: "invalid_email" });
    if (!strongEnough(password)) return res.status(400).json({ success: false, error: "weak_password" });

    // An unfinished setup is simply replaced
    await Admin.deleteMany({ totpEnabled: false });
    const secret = newTotpSecret();
    const admin = await Admin.create({ email, passwordHash: hashPassword(password), totpSecret: secret, role: "owner" });
    const url = otpauthUrl(admin.email, secret);
    const qr = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } });
    await audit(req, "setup_started", { admin: admin.email });
    res.json({ success: true, secret, otpauth: url, qr });
  });

  router.post("/admin/auth/setup/confirm", async (req, res) => {
    const { email, password, code } = req.body || {};
    const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim(), totpEnabled: false });
    if (!admin || !checkPassword(password, admin.passwordHash)) {
      return res.status(401).json({ success: false, error: "invalid_credentials" });
    }
    const step = checkTotp(admin.totpSecret, code);
    if (step === null) return res.status(401).json({ success: false, error: "invalid_code" });
    admin.totpEnabled = true;
    admin.totpLastStep = step;
    admin.lastLoginAt = new Date();
    await admin.save();
    setSessionCookie(res, signSession(admin));
    await audit(req, "setup_done", { admin: admin.email });
    res.json({ success: true, admin: me(admin) });
  });

  router.post("/admin/auth/login", async (req, res) => {
    const { email, password, code } = req.body || {};
    const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim(), totpEnabled: true });
    const fail = async (error) => {
      if (admin) {
        admin.failedLogins += 1;
        if (admin.failedLogins >= MAX_FAILED) {
          admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
          admin.failedLogins = 0;
        }
        await admin.save();
      }
      await audit(req, "login_failed", { admin: String(email || "").slice(0, 100), meta: { error } });
      return res.status(401).json({ success: false, error: "invalid_credentials" });
    };
    if (!admin) return fail("unknown");
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      return res.status(429).json({ success: false, error: "locked", until: admin.lockedUntil });
    }
    if (!checkPassword(password, admin.passwordHash)) return fail("password");
    const step = checkTotp(admin.totpSecret, code);
    // A code works only once
    if (step === null || step <= admin.totpLastStep) return fail("code");

    admin.totpLastStep = step;
    admin.failedLogins = 0;
    admin.lockedUntil = null;
    admin.lastLoginAt = new Date();
    await admin.save();
    const token = signSession(admin);
    if (!token) return res.status(500).json({ success: false, error: "no_secret" });
    setSessionCookie(res, token);
    await audit(req, "login", { admin: admin.email });
    res.json({ success: true, admin: me(admin) });
  });

  router.post("/admin/auth/logout", requireAdmin(), async (req, res) => {
    clearSessionCookie(res);
    await audit(req, "logout");
    res.json({ success: true });
  });

  // Ends every session of this admin, e.g. after a lost laptop
  router.post("/admin/auth/logout-all", requireAdmin(), async (req, res) => {
    await Admin.updateOne({ _id: req.admin._id }, { $inc: { sessionVersion: 1 } });
    clearSessionCookie(res);
    await audit(req, "logout_all");
    res.json({ success: true });
  });

  router.get("/admin/me", requireAdmin(), (req, res) => {
    res.json({ success: true, admin: me(req.admin) });
  });

  // --- Numbers ---------------------------------------------------------------

  router.get("/admin/metrics", requireAdmin("viewer"), async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 180);
    try {
      const [series, now] = await Promise.all([
        metrics.series(days),
        Promise.all([
          Room.countDocuments({ active: true }),
          User.countDocuments({ isAvailable: true }),
          User.countDocuments({ pushToken: { $exists: true, $ne: null } }),
          User.countDocuments({ voipToken: { $exists: true, $ne: null } }),
          Report.countDocuments({ status: "open" }),
        ]),
      ]);
      const [activeRooms, availableNow, pushTokens, voipTokens, openReports] = now;
      res.json({ success: true, zone: metrics.ZONE, series, now: { activeRooms, availableNow, pushTokens, voipTokens, openReports } });
    } catch (err) {
      console.error("❌ admin metrics:", err.message);
      res.status(500).json({ success: false });
    }
  });

  router.get("/admin/metrics/retention", requireAdmin("viewer"), async (req, res) => {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 2), 16);
    try {
      res.json({ success: true, cohorts: await metrics.retention(weeks) });
    } catch (err) {
      console.error("❌ admin retention:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // --- Audit log ---------------------------------------------------------------

  router.get("/admin/audit", requireAdmin("owner"), async (req, res) => {
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const query = before && !isNaN(before) ? { at: { $lt: before } } : {};
    const entries = await AdminAudit.find(query, { _id: 0, __v: 0 }).sort({ at: -1 }).limit(100).lean();
    res.json({ success: true, entries });
  });

  return router;
};
