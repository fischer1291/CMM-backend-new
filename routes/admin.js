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
const mongoose = require("mongoose");
const Talk = require("../models/Talk");
const Call = require("../models/Call");
const Circle = require("../models/Circle");
const Block = require("../models/Block");
const CallMoment = require("../models/CallMoment");
const PushDecision = require("../models/PushDecision");
const ActiveDay = require("../models/ActiveDay");
const { deleteAccount, exportAccount } = require("../lib/account");
const SupportTicket = require("../models/SupportTicket");
const appConfig = require("../lib/appConfig");
const plan = require("../lib/plan");
const { INTEREST } = require("./plus");
const { notify } = require("../lib/notify");
const moderation = require("../lib/moderation");
const { deleteMoment } = require("../lib/moments");
const { maskPhone } = moderation;
const { shiftDateKey } = require("../lib/localTime");
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
  INVITE_DAYS,
  newInviteToken,
  hashInviteToken,
  inviteExpiry,
  findByInviteToken,
} = require("../lib/adminAuth");
const metrics = require("../lib/metrics");
const ClientError = require("../models/ClientError");
const waitlist = require("../lib/waitlist");
const WaitlistEntry = require("../models/WaitlistEntry");
const mailer = require("../lib/mailer");

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const me = (admin) => ({ email: admin.email, role: admin.role, lastLoginAt: admin.lastLoginAt });

module.exports = (io) => {
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

  // Is there an admin yet? The console shows setup or login. An admin with a
  // pending invitation counts (the only owner after reset-admin-totp.js):
  // they continue via their link, not via the first-time setup.
  const anyAdmin = () => Admin.exists({ $or: [{ totpEnabled: true }, { inviteTokenHash: { $ne: null } }] });
  router.get("/admin/auth/state", async (req, res) => {
    res.json({ success: true, setupNeeded: !(await anyAdmin()) });
  });

  const qrOf = (url) => QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } });

  // GET /admin/auth/invite/:token: whom a setup link is for, so the console can
  // greet them; 404 once it is used up or expired
  router.get("/admin/auth/invite/:token", async (req, res) => {
    const admin = await findByInviteToken(req.params.token);
    if (!admin) return res.status(404).json({ success: false, error: "invite_invalid" });
    res.json({ success: true, email: admin.email, role: admin.role, invitedBy: admin.invitedBy, expiresAt: admin.inviteExpiresAt });
  });

  /**
   * First admin: only while none is set up, and only with ADMIN_API_KEY
   * (from Render). Returns the TOTP secret to scan; confirm with a code.
   *
   * With `inviteToken` instead (an invitation from POST /admin/admins or a
   * reset by scripts/reset-admin-totp.js): sets the password and a fresh TOTP
   * secret of that admin, whatever other admins exist. The token stays valid
   * until the code is confirmed, so an interrupted setup can start over.
   */
  router.post("/admin/auth/setup", async (req, res) => {
    const { email, password, setupKey, inviteToken } = req.body || {};
    if (!strongEnough(password)) return res.status(400).json({ success: false, error: "weak_password" });
    if (inviteToken) {
      const invited = await findByInviteToken(inviteToken);
      if (!invited) return res.status(404).json({ success: false, error: "invite_invalid" });
      invited.passwordHash = hashPassword(password);
      invited.totpSecret = newTotpSecret();
      invited.totpEnabled = false;
      await invited.save();
      const url = otpauthUrl(invited.email, invited.totpSecret);
      await audit(req, "setup_started", { admin: invited.email, meta: { invited: true } });
      return res.json({ success: true, email: invited.email, secret: invited.totpSecret, otpauth: url, qr: await qrOf(url) });
    }
    const key = process.env.ADMIN_API_KEY;
    if (!key || setupKey !== key) return res.status(403).json({ success: false, error: "wrong_setup_key" });
    if (await anyAdmin()) return res.status(409).json({ success: false, error: "already_set_up" });
    if (!EMAIL.test(String(email || ""))) return res.status(400).json({ success: false, error: "invalid_email" });

    // An unfinished setup is simply replaced (not a pending invitation)
    await Admin.deleteMany({ totpEnabled: false, inviteTokenHash: null });
    const secret = newTotpSecret();
    const admin = await Admin.create({ email, passwordHash: hashPassword(password), totpSecret: secret, role: "owner" });
    const url = otpauthUrl(admin.email, secret);
    await audit(req, "setup_started", { admin: admin.email });
    res.json({ success: true, email: admin.email, secret, otpauth: url, qr: await qrOf(url) });
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
    // An invited (or reset) admin is live from here; the setup link is spent
    admin.active = true;
    admin.inviteTokenHash = null;
    admin.inviteExpiresAt = null;
    await admin.save();
    setSessionCookie(res, signSession(admin));
    await audit(req, "setup_done", { admin: admin.email });
    res.json({ success: true, admin: me(admin) });
  });

  router.post("/admin/auth/login", async (req, res) => {
    const { email, password, code } = req.body || {};
    const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim(), totpEnabled: true, active: { $ne: false } });
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

  // --- Passkeys: Face ID / Touch ID instead of password and code (lib/adminPasskeys.js)
  const passkeys = require("../lib/adminPasskeys");
  const PASSKEY_ERRORS = { expired: 400, invalid: 400, unknown: 401, exists: 409, too_many: 409, locked: 429 };

  router.post("/admin/auth/passkey/options", async (req, res) => {
    res.json({ success: true, options: await passkeys.loginOptions() });
  });

  router.post("/admin/auth/passkey/login", async (req, res) => {
    const result = await passkeys.login(req.body?.response);
    if (result.error) {
      await audit(req, "login_failed", { meta: { error: `passkey_${result.error}` } });
      return res.status(PASSKEY_ERRORS[result.error] || 400).json({ success: false, error: result.error === "locked" ? "locked" : "passkey_failed" });
    }
    const token = signSession(result.admin);
    if (!token) return res.status(500).json({ success: false, error: "no_secret" });
    setSessionCookie(res, token);
    await audit(req, "login_passkey", { admin: result.admin.email });
    res.json({ success: true, admin: me(result.admin) });
  });

  router.get("/admin/passkeys", requireAdmin(), (req, res) => {
    res.json({ success: true, passkeys: passkeys.list(req.admin), rpId: passkeys.rp().rpID });
  });

  // POST /admin/passkeys/options { code }: adding one needs a fresh code from the authenticator app
  router.post("/admin/passkeys/options", requireAdmin(), authLimit, async (req, res) => {
    const admin = await Admin.findById(req.admin._id);
    const step = checkTotp(admin.totpSecret, req.body?.code);
    if (step === null || step <= admin.totpLastStep) {
      await audit(req, "passkey_code_failed");
      return res.status(401).json({ success: false, error: "invalid_code" });
    }
    admin.totpLastStep = step;
    await admin.save();
    res.json({ success: true, options: await passkeys.registrationOptions(admin) });
  });

  // POST /admin/passkeys { response }: what navigator.credentials.create returned
  router.post("/admin/passkeys", requireAdmin(), async (req, res) => {
    const result = await passkeys.register(req.admin, req.body?.response, req.get("user-agent"));
    if (result.error) return res.status(PASSKEY_ERRORS[result.error] || 400).json({ success: false, error: `passkey_${result.error}` });
    await audit(req, "passkey_added");
    res.json({ success: true, passkeys: passkeys.list(result.admin) });
  });

  router.delete("/admin/passkeys/:id", requireAdmin(), async (req, res) => {
    if (!(await passkeys.remove(req.admin, req.params.id))) return res.status(404).json({ success: false, error: "not_found" });
    await audit(req, "passkey_removed");
    res.json({ success: true, passkeys: passkeys.list(await Admin.findById(req.admin._id)) });
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

  // --- Push to the console on the phone (lib/adminPush.js) ----------------------
  const adminPush = require("../lib/adminPush");
  const NOTIFY_KEYS = ["approvals", "posting", "support", "reports", "daily", "alerts"];
  const pushView = async (admin) => ({
    publicKey: (await adminPush.vapid()).publicKey,
    // Only what this role gets at all
    kinds: NOTIFY_KEYS.filter((k) => adminPush.KINDS[k].includes(admin.role)),
    notify: { ...Object.fromEntries(NOTIFY_KEYS.map((k) => [k, admin.notify?.[k] !== false])), dailyHour: admin.notify?.dailyHour ?? 20 },
    devices: (await adminPush.devices(admin)).map((d) => ({ device: d.device, createdAt: d.createdAt, lastSentAt: d.lastSentAt, endpoint: d.endpoint })),
  });

  router.get("/admin/push", requireAdmin(), async (req, res) => {
    res.json({ success: true, ...(await pushView(req.admin)) });
  });

  // POST /admin/push/subscribe { subscription }: what PushManager.subscribe returned
  router.post("/admin/push/subscribe", requireAdmin(), async (req, res) => {
    const result = await adminPush.subscribe(req.admin, req.body?.subscription, req.get("user-agent"));
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    await audit(req, "push_subscribed");
    res.json({ success: true, ...(await pushView(req.admin)) });
  });

  router.post("/admin/push/unsubscribe", requireAdmin(), async (req, res) => {
    await adminPush.unsubscribe(req.admin, req.body?.endpoint);
    res.json({ success: true, ...(await pushView(req.admin)) });
  });

  // PUT /admin/push/settings { approvals, posting, support, reports, daily: bool, dailyHour: 0–23 }
  router.put("/admin/push/settings", requireAdmin(), async (req, res) => {
    const set = {};
    for (const k of NOTIFY_KEYS) if (typeof req.body?.[k] === "boolean") set[`notify.${k}`] = req.body[k];
    if (req.body?.dailyHour !== undefined) {
      const h = Number(req.body.dailyHour);
      if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ success: false, error: "invalid_hour" });
      set["notify.dailyHour"] = h;
    }
    const admin = await Admin.findByIdAndUpdate(req.admin._id, set, { new: true });
    res.json({ success: true, ...(await pushView(admin)) });
  });

  router.post("/admin/push/test", requireAdmin(), async (req, res) => {
    const delivered = await adminPush.sendTo(req.admin, { title: "Mitteilungen sind an", body: "So sieht eine Mitteilung der Wanna yap?-Konsole aus.", url: "#notify", tag: "test" });
    res.json({ success: true, delivered });
  });

  // --- Numbers ---------------------------------------------------------------

  // Today so far next to the same weekday last week, and what is waiting
  router.get("/admin/today", requireAdmin("viewer"), async (req, res) => {
    try {
      const data = await require("../lib/today").todayNumbers();
      // Viewers see numbers, not the queues
      if (req.admin.role === "viewer") data.todo = null;
      else if (req.admin.role !== "owner") data.todo.approvals = null;
      res.json({ success: true, ...data });
    } catch (err) {
      console.error("❌ admin today:", err.message);
      res.status(500).json({ success: false });
    }
  });

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

  // Unit economics (plan 2.5, lib/economics.js): costs, contribution, break-even, runway
  router.get("/admin/economics", requireAdmin("viewer"), async (req, res) => {
    try {
      const s = await require("../lib/economics").summary();
      // The bank balance stays with the owners (as alertPhone); the runway is for everyone
      if (req.admin.role !== "owner" && s.bankBalanceEurCents != null) s.bankBalanceEurCents = "•••";
      res.json({ success: true, ...s });
    } catch (err) {
      console.error("❌ admin economics:", err.message);
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

  // Onboarding steps by sign-up week (lib/metrics.js funnel, from User.milestones)
  router.get("/admin/metrics/funnel", requireAdmin("viewer"), async (req, res) => {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 2), 16);
    try {
      res.json({ success: true, steps: metrics.FUNNEL_STEPS.map(([name]) => name), weeks: await metrics.funnel(weeks) });
    } catch (err) {
      console.error("❌ admin funnel:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // App errors (routes/diagnostics.js), most recent first
  router.get("/admin/errors", requireAdmin("viewer"), async (req, res) => {
    const errors = await ClientError.find({}, { _id: 0, __v: 0 }).sort({ lastAt: -1 }).limit(50).lean();
    res.json({ success: true, errors });
  });

  // --- Waitlist (lib/waitlist.js) ----------------------------------------------

  router.get("/admin/waitlist", requireAdmin("viewer"), async (req, res) => {
    const waitingForMail = await WaitlistEntry.countDocuments({ status: "pending", confirmMailAt: null });
    res.json({ success: true, mailConfigured: mailer.configured(), mail: { ...mailer.status(), waitingForMail }, goal: waitlist.REFERRAL_GOAL, ...(await waitlist.overview()) });
  });

  // Confirmed addresses as CSV, e.g. for a newsletter tool. Owner only, audited.
  // The other exports (metrics, plus, marketing-spend, support) live in
  // routes/adminExport.js under GET /admin/export/:name.csv, same dialect.
  router.get("/admin/waitlist/export", requireAdmin("owner"), async (req, res) => {
    const entries = await WaitlistEntry.find({ status: "confirmed" }).sort({ confirmedAt: 1 }).lean();
    await audit(req, "waitlist_exported", { meta: { count: entries.length } });
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["email", "bestaetigt", "quelle", "kampagne", "empfohlen_von", "code", "eingeloest"],
      ...entries.map((e) => [e.email, e.confirmedAt?.toISOString(), e.source, e.campaign, e.referredBy, e.code, e.claimedAt ? "ja" : "nein"]),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="warteliste-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\uFEFF${rows.map((r) => r.map(cell).join(";")).join("\n")}`);
  });

  // Can the backend sign in at the SMTP server? Owner only, nothing is sent.
  router.post("/admin/mail/check", requireAdmin("owner"), async (req, res) => {
    const result = await mailer.check();
    res.json({ success: true, ...result, mail: mailer.status() });
  });

  // The launch mail to one address first. Owner only.
  router.post("/admin/waitlist/test-mail", requireAdmin("owner"), async (req, res) => {
    try {
      const result = await waitlist.sendTestLaunchMail(req.body?.email);
      if (result.error) return res.status(400).json({ success: false, error: result.error });
      await audit(req, "waitlist_test_mail");
      res.json({ success: true });
    } catch (err) {
      res.status(503).json({ success: false, error: err.message === "mail_not_configured" ? "mail_not_configured" : "send_failed", reason: err.reason || null });
    }
  });

  // Release day: the launch mail to everyone confirmed. Owner only, typed
  // confirmation; sending runs in the background (index.js) and only once.
  router.post("/admin/waitlist/launch", requireAdmin("owner"), async (req, res) => {
    if (req.body?.confirm !== "STARTEN") return res.status(400).json({ success: false, error: "confirm_required" });
    if (!mailer.configured()) return res.status(503).json({ success: false, error: "mail_not_configured" });
    const { state, already } = await waitlist.startLaunch(req.admin.email);
    if (!already) await audit(req, "waitlist_launch_started");
    res.json({ success: true, already: !!already, launch: state });
  });

  // --- Daily push acknowledged (plan 1.8) ----------------------------------------

  // POST /admin/daily/ack: the console calls it when the morning push's link
  // (#ack) is opened. A sign of life for the dead-man rule (lib/adminPush.js)
  router.post("/admin/daily/ack", requireAdmin(), async (req, res) => {
    const lastAckAt = new Date();
    await Admin.updateOne({ _id: req.admin._id }, { lastAckAt });
    res.json({ success: true, lastAckAt });
  });

  // --- Team: the other admins (owner only, plan 1.8) -----------------------------

  const ROLES = ["owner", "support", "viewer"];
  const ROLE_LABEL = { owner: "Owner", support: "Support", viewer: "Nur lesen" };
  const consoleUrl = () => `${(process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "")}/console/`;
  const teamItem = (a, self) => ({
    id: String(a._id),
    email: a.email,
    role: a.role,
    active: a.active !== false,
    totpEnabled: !!a.totpEnabled,
    passkeys: (a.passkeys || []).length,
    lastLoginAt: a.lastLoginAt || null,
    lastAckAt: a.lastAckAt || null,
    // Set up not finished: the invitation is still open (or has run out)
    invitePending: !a.totpEnabled && !!a.inviteTokenHash,
    inviteExpiresAt: !a.totpEnabled && a.inviteTokenHash ? a.inviteExpiresAt : null,
    invitedBy: a.invitedBy || null,
    createdAt: a.createdAt,
    me: String(a._id) === String(self._id),
  });
  // Owners who can actually sign in: at least one must always remain
  const activeOwners = () => Admin.countDocuments({ role: "owner", totpEnabled: true, active: { $ne: false } });

  async function findAdmin(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return null;
    }
    const target = await Admin.findById(req.params.id);
    if (!target) res.status(404).json({ success: false, error: "not_found" });
    return target;
  }

  router.get("/admin/admins", requireAdmin("owner"), async (req, res) => {
    const admins = await Admin.find({}).sort({ createdAt: 1 }).lean();
    res.json({ success: true, admins: admins.map((a) => teamItem(a, req.admin)), mailConfigured: mailer.configured() });
  });

  /**
   * POST /admin/admins { email, role }: invite someone. Creates an inactive
   * admin with a one-time setup link (7 days) and mails it; without SMTP_URL
   * (or when the mail fails) the link comes back in the answer for the owner to
   * pass on. Someone deactivated or not finished is simply invited again.
   */
  router.post("/admin/admins", requireAdmin("owner"), async (req, res) => {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const role = ROLES.includes(req.body?.role) ? req.body.role : null;
    if (!EMAIL.test(email)) return res.status(400).json({ success: false, error: "invalid_email" });
    if (!role) return res.status(400).json({ success: false, error: "invalid_role" });
    let target = await Admin.findOne({ email });
    if (target && target.active !== false && target.totpEnabled) return res.status(409).json({ success: false, error: "exists" });
    const token = newInviteToken();
    const fields = { role, active: false, totpEnabled: false, inviteTokenHash: hashInviteToken(token), inviteExpiresAt: inviteExpiry(), invitedBy: req.admin.email };
    if (target) {
      // A new start: old password, code and sessions are void
      Object.assign(target, fields, { passwordHash: hashPassword(newInviteToken()), totpSecret: newTotpSecret(), sessionVersion: target.sessionVersion + 1 });
      await target.save();
    } else {
      target = await Admin.create({ email, ...fields, passwordHash: hashPassword(newInviteToken()), totpSecret: newTotpSecret() });
    }
    const link = `${consoleUrl()}#setup/${token}`;
    let mailed = false;
    if (mailer.configured()) {
      try {
        await mailer.sendMail({
          to: email,
          subject: "Du bist zur Wanna yap?-Konsole eingeladen",
          text: `Hey!\n\n${req.admin.email} hat dich als „${ROLE_LABEL[role]}“ zur Admin-Konsole von Wanna yap? eingeladen.\n\nRichte dein Konto hier ein (Passwort und Authenticator-App; der Link gilt ${INVITE_DAYS} Tage):\n${link}\n\nDu kennst Wanna yap? nicht? Dann ignorier diese Mail einfach.\n\nWanna yap?`,
        });
        mailed = true;
      } catch (err) {
        console.error("❌ admin invite mail:", err.reason || err.message);
      }
    }
    await audit(req, "admin_invited", { target: email, meta: { role, mailed } });
    res.json({ success: true, admin: teamItem(target, req.admin), mailed, link: mailed ? null : link });
  });

  // PUT /admin/admins/:id { role }: never demote the last owner
  router.put("/admin/admins/:id", requireAdmin("owner"), async (req, res) => {
    const role = ROLES.includes(req.body?.role) ? req.body.role : null;
    if (!role) return res.status(400).json({ success: false, error: "invalid_role" });
    const target = await findAdmin(req, res);
    if (!target) return;
    if (target.role === "owner" && role !== "owner" && target.active !== false && target.totpEnabled && (await activeOwners()) <= 1) {
      return res.status(409).json({ success: false, error: "last_owner" });
    }
    const from = target.role;
    target.role = role;
    await target.save();
    // Two owners demoting each other at once: whoever saved second undoes it
    if (from === "owner" && role !== "owner" && (await activeOwners()) === 0) {
      target.role = "owner";
      await target.save();
      return res.status(409).json({ success: false, error: "last_owner" });
    }
    await audit(req, "admin_role", { target: target.email, meta: { from, to: role } });
    res.json({ success: true, admin: teamItem(target, req.admin) });
  });

  // DELETE /admin/admins/:id: deactivate (keeps the record), ends their sessions
  router.delete("/admin/admins/:id", requireAdmin("owner"), async (req, res) => {
    const target = await findAdmin(req, res);
    if (!target) return;
    if (String(target._id) === String(req.admin._id)) return res.status(400).json({ success: false, error: "self" });
    if (target.role === "owner" && target.active !== false && target.totpEnabled && (await activeOwners()) <= 1) {
      return res.status(409).json({ success: false, error: "last_owner" });
    }
    const wasActive = target.active !== false && target.totpEnabled;
    target.active = false;
    target.inviteTokenHash = null;
    target.inviteExpiresAt = null;
    target.sessionVersion += 1;
    await target.save();
    // Two owners deactivating each other at once: whoever saved second undoes it
    if (target.role === "owner" && wasActive && (await activeOwners()) === 0) {
      target.active = true;
      await target.save();
      return res.status(409).json({ success: false, error: "last_owner" });
    }
    await audit(req, "admin_deactivated", { target: target.email, meta: { role: target.role } });
    res.json({ success: true, admin: teamItem(target, req.admin) });
  });

  // --- Audit log ---------------------------------------------------------------

  router.get("/admin/audit", requireAdmin("owner"), async (req, res) => {
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const query = before && !isNaN(before) ? { at: { $lt: before } } : {};
    const entries = await AdminAudit.find(query, { _id: 0, __v: 0 }).sort({ at: -1 }).limit(100).lean();
    res.json({ success: true, entries });
  });

  // --- Users -------------------------------------------------------------------

  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const createdAt = (user) => user._id.getTimestamp();
  const listItem = (u) => ({
    id: String(u._id),
    name: u.name || "",
    avatarUrl: u.avatarUrl || null,
    phone: maskPhone(u.phone),
    createdAt: createdAt(u),
    lastOnline: u.lastOnline || null,
    isAvailable: !!u.isAvailable,
    platform: u.pushTokenMetadata?.platform || u.voipTokenMetadata?.platform || null,
    suspendedUntil: u.suspendedUntil && u.suspendedUntil > new Date() ? u.suspendedUntil : null,
  });

  async function findUser(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return null;
    }
    const user = await User.findById(req.params.id);
    if (!user) res.status(404).json({ success: false, error: "not_found" });
    return user;
  }

  // GET /admin/users?q=: by name or (part of the) number; newest without q
  router.get("/admin/users", requireAdmin("support"), async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 50);
    let filter = {};
    if (q) {
      const digits = q.replace(/[^\d]/g, "");
      filter =
        digits.length >= 4 && /^[+\d\s()/-]+$/.test(q)
          ? { phone: { $regex: escape(digits.replace(/^0+/, "")) } }
          : { name: { $regex: escape(q), $options: "i" } };
    }
    const users = await User.find(filter).sort({ _id: -1 }).limit(25).lean();
    if (q) await audit(req, "user_search", { meta: { length: q.length, results: users.length } });
    res.json({ success: true, users: users.map(listItem) });
  });

  router.get("/admin/users/:id", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    const phone = user.phone;
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const today = metrics.todayKey();
    const [circles, talks, calls, reportsAgainst, reportsBy, blockedBy, blocking, moments, decisions, activeDays] = await Promise.all([
      Circle.find({ "members.phone": phone }, { name: 1, emoji: 1, members: 1 }).lean(),
      Talk.aggregate([
        { $match: { startedAt: { $gte: since }, $or: [{ group: { $ne: true }, participants: phone }, { group: true, owner: phone }] } },
        { $group: { _id: "$group", n: { $sum: 1 }, seconds: { $sum: "$seconds" } } },
      ]),
      Call.aggregate([
        { $match: { createdAt: { $gte: since }, $or: [{ caller: phone }, { callee: phone }] } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
      Report.find({ reported: phone }).sort({ createdAt: -1 }).limit(20).lean(),
      Report.countDocuments({ reporter: phone }),
      Block.countDocuments({ blocked: phone }),
      Block.countDocuments({ blocker: phone }),
      CallMoment.countDocuments({ userPhone: phone }),
      PushDecision.find({ to: phone }).sort({ at: -1 }).limit(30).lean(),
      ActiveDay.find({ who: User.hmacPhone(phone), day: { $gte: shiftDateKey(today, -27) } }, { day: 1 }).lean(),
    ]);
    const talkBy = Object.fromEntries(talks.map((t) => [String(!!t._id), t]));
    await audit(req, "user_view", { target: String(user._id) });
    res.json({
      success: true,
      user: {
        ...listItem(user),
        timezone: user.timezone || null,
        app: user.app?.version ? user.app : null,
        plan: (await plan.planOf(user)).plan,
        plus: user.plus?.since || user.plus?.active ? { active: plan.isPlus(user), until: user.plus.until, since: user.plus.since, source: user.plus.source, productId: user.plus.productId } : null,
        plusInterest: user.plusInterest?.at ? user.plusInterest : null,
        research: user.research?.invitedAt ? user.research : null,
        mood: user.mood || null,
        suspendReason: user.suspendReason || null,
        tokensValidAfter: user.tokensValidAfter || null,
        contacts: user.contacts.length,
        invitesJoined: user.invitesJoined || 0,
        joinedViaInvite: !!user.joinedViaInvite,
        push: {
          expo: !!user.pushToken,
          expoRegisteredAt: user.pushTokenMetadata?.registeredAt || null,
          expoValidated: user.pushTokenMetadata?.lastValidated || null,
          voip: !!user.voipToken,
          voipEnvironment: user.voipTokenMetadata?.environment || null,
          prefs: user.notificationPrefs || null,
        },
        circles: circles.map((c) => ({ id: String(c._id), name: c.name, emoji: c.emoji, members: c.members.length })),
        last30: {
          talks: talkBy.false?.n || 0,
          talkMinutes: Math.round((talkBy.false?.seconds || 0) / 60),
          roomMinutes: Math.round((talkBy.true?.seconds || 0) / 60),
          calls: Object.fromEntries(calls.map((c) => [c._id, c.n])),
          activeDays: activeDays.map((d) => d.day).sort(),
        },
        safety: {
          reportsAgainst: reportsAgainst.map((r) => ({ id: String(r._id), reason: r.reason, note: r.note, status: r.status, resolution: r.resolution, createdAt: r.createdAt })),
          reportsBy,
          blockedBy,
          blocking,
          moments,
        },
        // "about" is a person: masked
        pushLog: decisions.map((d) => ({ type: d.type, result: d.result, app: d.app || null, delivery: d.delivery || null, about: maskPhone(d.about), at: d.at })),
      },
    });
  });

  router.post("/admin/users/:id/reveal", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await audit(req, "phone_revealed", { target: String(user._id) });
    res.json({ success: true, phone: user.phone });
  });

  router.post("/admin/users/:id/test-push", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    const result = await moderation.testPush(user);
    await audit(req, "test_push", { target: String(user._id), meta: { result } });
    res.json({ success: true, result });
  });

  router.post("/admin/users/:id/reset-push", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await moderation.resetPush(user.phone);
    await audit(req, "push_reset", { target: String(user._id) });
    res.json({ success: true });
  });

  router.post("/admin/users/:id/logout", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await moderation.endSessions(user.phone, io);
    await audit(req, "user_logged_out", { target: String(user._id) });
    res.json({ success: true });
  });

  router.post("/admin/users/:id/suspend", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    const days = Number(req.body?.days);
    if (!Number.isFinite(days) || days < 1 || days > moderation.MAX_SUSPEND_DAYS) {
      return res.status(400).json({ success: false, error: "invalid_days" });
    }
    const until = await moderation.suspend(user.phone, { days, reason: req.body?.reason }, io);
    await audit(req, "user_suspended", { target: String(user._id), meta: { days, reason: String(req.body?.reason || "").slice(0, 300) } });
    res.json({ success: true, suspendedUntil: until });
  });

  router.post("/admin/users/:id/unsuspend", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await moderation.unsuspend(user.phone);
    await audit(req, "user_unsuspended", { target: String(user._id) });
    res.json({ success: true });
  });

  // Delete the account and block the number. Owner only, typed confirmation.
  router.post("/admin/users/:id/ban", requireAdmin("owner"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (req.body?.confirm !== "SPERREN") return res.status(400).json({ success: false, error: "confirm_required" });
    await audit(req, "user_banned", { target: String(user._id), meta: { reason: String(req.body?.reason || "").slice(0, 300) } });
    await moderation.ban(user.phone, { reason: req.body?.reason, by: req.admin.email }, io);
    res.json({ success: true });
  });

  // Delete on request (e.g. by e-mail). Owner only, typed confirmation.
  router.post("/admin/users/:id/delete", requireAdmin("owner"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (req.body?.confirm !== "LÖSCHEN") return res.status(400).json({ success: false, error: "confirm_required" });
    await audit(req, "user_deleted", { target: String(user._id) });
    await deleteAccount(user.phone, io);
    res.json({ success: true });
  });

  // --- Reports -------------------------------------------------------------------

  const person = async (phone) => {
    const u = await User.findOne({ phone }, { name: 1, avatarUrl: 1, phone: 1 }).lean();
    return u ? { id: String(u._id), name: u.name || "", avatarUrl: u.avatarUrl || null, phone: maskPhone(phone) } : { id: null, name: "Gelöscht", phone: maskPhone(phone) };
  };

  router.get("/admin/reports", requireAdmin("support"), async (req, res) => {
    const status = req.query.status === "resolved" ? "resolved" : "open";
    const reports = await Report.find({ status }).sort(status === "open" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 }).limit(100).lean();
    const counts = await Report.aggregate([
      { $match: { reported: { $in: [...new Set(reports.map((r) => r.reported))] } } },
      { $group: { _id: "$reported", n: { $sum: 1 } } },
    ]);
    const against = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    const out = [];
    for (const r of reports) {
      const moment = r.momentId ? await CallMoment.findById(r.momentId, { screenshot: 1, note: 1, hidden: 1, mood: 1, timestamp: 1 }).lean() : null;
      out.push({
        id: String(r._id),
        reason: r.reason,
        note: r.note,
        status: r.status,
        resolution: r.resolution,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.resolvedAt,
        createdAt: r.createdAt,
        reporter: await person(r.reporter),
        reported: { ...(await person(r.reported)), reportsAgainst: against[r.reported] || 0 },
        moment: moment ? { screenshot: moment.screenshot, note: moment.note, mood: moment.mood, hidden: !!moment.hidden, at: moment.timestamp } : r.momentId ? { deleted: true } : null,
      });
    }
    res.json({ success: true, reports: out });
  });

  const ACTIONS = ["dismiss", "hide_moment", "delete_moment", "suspend", "ban"];
  router.post("/admin/reports/:id/resolve", requireAdmin("support"), async (req, res) => {
    const { action, days, note } = req.body || {};
    if (!ACTIONS.includes(action)) return res.status(400).json({ success: false, error: "invalid_action" });
    if (action === "ban" && req.admin.role !== "owner") return res.status(403).json({ success: false, error: "forbidden" });
    if (action === "suspend" && !(Number(days) >= 1 && Number(days) <= moderation.MAX_SUSPEND_DAYS)) {
      return res.status(400).json({ success: false, error: "invalid_days" });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, error: "invalid_id" });
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: "not_found" });
    if (report.status !== "open") return res.status(409).json({ success: false, error: "already_resolved" });
    await audit(req, "report_resolved", { target: String(report._id), meta: { action, days: days || null, note: String(note || "").slice(0, 300) } });
    const settled = await moderation.resolveReport(report, { action, days, note }, req.admin, io);
    res.json({ success: true, settled });
  });

  // Grant or take back Plus (testers, gifts, goodwill). Owner only.
  // { days: 30 } for a while, { days: null } without end, { revoke: true }
  router.post("/admin/users/:id/plus", requireAdmin("owner"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (req.body?.revoke) {
      if (user.plus?.source === "store" && plan.isPlus(user)) return res.status(409).json({ success: false, error: "store_subscription" });
      user.plus = { ...(user.plus?.toObject?.() || {}), active: false, until: new Date() };
    } else {
      const days = req.body?.days === null ? null : Number(req.body?.days);
      if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return res.status(400).json({ success: false, error: "invalid_days" });
      const now = new Date();
      user.plus = {
        ...(user.plus?.toObject?.() || {}),
        active: true,
        until: days ? new Date(now.getTime() + days * 24 * 3600 * 1000) : null,
        since: user.plus?.since || now,
        source: "admin",
      };
    }
    await user.save();
    io?.to(`user:${user.phone}`).emit("planChanged", {});
    await audit(req, req.body?.revoke ? "plus_revoked" : "plus_granted", { target: String(user._id), meta: { days: req.body?.days ?? null } });
    res.json({ success: true, plus: user.plus });
  });

  // The research call with this person took place (README "User research");
  // the thank-you is a Plus grant above. Set once, never overwritten.
  router.post("/admin/users/:id/research-done", requireAdmin("support"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (!user.research?.invitedAt) return res.status(409).json({ success: false, error: "not_invited" });
    if (!user.research.doneAt) {
      user.research.doneAt = new Date();
      await user.save();
    }
    await audit(req, "research_done", { target: String(user._id) });
    res.json({ success: true, research: user.research });
  });

  // Subscriptions and "Interesse zeigen" in numbers
  router.get("/admin/plus", requireAdmin("viewer"), async (req, res) => {
    const now = new Date();
    const activeQuery = { "plus.active": true, $or: [{ "plus.until": null }, { "plus.until": { $gt: now } }] };
    const [active, sandbox, bySource, byProduct, interested, features, recent, limits] = await Promise.all([
      User.countDocuments(activeQuery),
      // Testers with a sandbox purchase: Plus for them, but never paying
      User.countDocuments({ ...activeQuery, "plus.source": "sandbox" }),
      User.aggregate([{ $match: activeQuery }, { $group: { _id: "$plus.source", n: { $sum: 1 } } }]),
      User.aggregate([{ $match: { ...activeQuery, "plus.source": "store" } }, { $group: { _id: "$plus.productId", n: { $sum: 1 } } }]),
      User.countDocuments({ "plusInterest.at": { $ne: null } }),
      User.aggregate([{ $match: { "plusInterest.at": { $ne: null } } }, { $unwind: "$plusInterest.features" }, { $group: { _id: "$plusInterest.features", n: { $sum: 1 } } }]),
      User.countDocuments({ "plusInterest.at": { $gt: new Date(now - 7 * 24 * 3600 * 1000) } }),
      plan.limits(),
    ]);
    res.json({
      success: true,
      active,
      sandbox,
      bySource: Object.fromEntries(bySource.map((x) => [x._id || "unknown", x.n])),
      byProduct: Object.fromEntries(byProduct.map((x) => [x._id || "unknown", x.n])),
      interest: { total: interested, last7Days: recent, features: Object.fromEntries(INTEREST.map((f) => [f, features.find((x) => x._id === f)?.n || 0])) },
      limits,
      defaults: plan.DEFAULT_LIMITS,
      webhookConfigured: !!process.env.REVENUECAT_WEBHOOK_SECRET,
    });
  });

  // DSGVO: everything about a person as JSON (e.g. a request by e-mail)
  router.get("/admin/users/:id/export", requireAdmin("owner"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await audit(req, "user_exported", { target: String(user._id) });
    res.set("Content-Disposition", `attachment; filename="wanna-yap-export-${user._id}.json"`);
    res.json(await exportAccount(user.phone));
  });

  // --- Moments ------------------------------------------------------------------

  const MOMENT_FILTERS = {
    all: {},
    reported: null, // moments with open reports (below)
    hidden: { hidden: true },
    pending: { status: "pending" },
  };

  // GET /admin/moments?filter=all|reported|hidden|pending&user=<id>&before=<iso>
  router.get("/admin/moments", requireAdmin("support"), async (req, res) => {
    const filter = Object.hasOwn(MOMENT_FILTERS, req.query.filter) ? req.query.filter : "all";
    const query = { ...(MOMENT_FILTERS[filter] || {}) };
    if (filter === "reported") {
      query._id = { $in: await Report.distinct("momentId", { status: "open", momentId: { $ne: null } }) };
    }
    if (req.query.user) {
      if (!mongoose.isValidObjectId(req.query.user)) return res.status(400).json({ success: false, error: "invalid_id" });
      const u = await User.findById(req.query.user, { phone: 1 }).lean();
      if (!u) return res.json({ success: true, moments: [], counts: {} });
      query.$or = [{ userPhone: u.phone }, { targetPhone: u.phone }];
    }
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !isNaN(before)) query.timestamp = { $lt: before };

    const moments = await CallMoment.find(query).sort({ timestamp: -1 }).limit(60).lean();
    const ids = moments.map((m) => m._id);
    const reports = await Report.aggregate([
      { $match: { momentId: { $in: ids } } },
      { $group: { _id: "$momentId", total: { $sum: 1 }, open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } } } },
    ]);
    const reportsOf = Object.fromEntries(reports.map((r) => [String(r._id), r]));
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [last24h, hidden, pending, reported] = await Promise.all([
      CallMoment.countDocuments({ timestamp: { $gt: since } }),
      CallMoment.countDocuments({ hidden: true }),
      CallMoment.countDocuments({ status: "pending" }),
      Report.distinct("momentId", { status: "open", momentId: { $ne: null } }).then((r) => r.length),
    ]);
    if (req.query.user) await audit(req, "moments_of_user", { target: String(req.query.user) });
    res.json({
      success: true,
      counts: { last24h, hidden, pending, reported },
      moments: await Promise.all(
        moments.map(async (m) => ({
          id: String(m._id),
          screenshot: m.screenshot,
          note: m.note || "",
          mood: m.mood || null,
          callDuration: m.callDuration || null,
          status: m.status || "shared",
          hidden: !!m.hidden,
          reactions: m.totalReactions || 0,
          reports: reportsOf[String(m._id)] || { total: 0, open: 0 },
          author: await person(m.userPhone),
          target: await person(m.targetPhone),
          at: m.timestamp,
          sharedAt: m.sharedAt || null,
        })),
      ),
    });
  });

  async function findMoment(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return null;
    }
    const moment = await CallMoment.findById(req.params.id);
    if (!moment) res.status(404).json({ success: false, error: "not_found" });
    return moment;
  }

  const settleReports = (momentId, resolution, admin) =>
    Report.updateMany(
      { momentId, status: "open" },
      { status: "resolved", resolution, resolvedBy: admin.email, resolvedAt: new Date() },
    ).then((r) => r.modifiedCount);

  router.post("/admin/moments/:id/hide", requireAdmin("support"), async (req, res) => {
    const moment = await findMoment(req, res);
    if (!moment) return;
    await CallMoment.updateOne({ _id: moment._id }, { hidden: true });
    const settled = await settleReports(moment._id, "hide_moment", req.admin);
    await audit(req, "moment_hidden", { target: String(moment._id), meta: { settled } });
    res.json({ success: true, settled });
  });

  router.post("/admin/moments/:id/unhide", requireAdmin("support"), async (req, res) => {
    const moment = await findMoment(req, res);
    if (!moment) return;
    await CallMoment.updateOne({ _id: moment._id }, { hidden: false });
    await audit(req, "moment_unhidden", { target: String(moment._id) });
    res.json({ success: true });
  });

  // Deletes the picture at Cloudinary too
  router.post("/admin/moments/:id/delete", requireAdmin("support"), async (req, res) => {
    const moment = await findMoment(req, res);
    if (!moment) return;
    const settled = await settleReports(moment._id, "delete_moment", req.admin);
    await audit(req, "moment_deleted", { target: String(moment._id), meta: { author: maskPhone(moment.userPhone), settled } });
    await deleteMoment(moment);
    res.json({ success: true, settled });
  });

  // --- Support tickets ---------------------------------------------------------

  const ticketView = async (t, full = false) => {
    const u = await User.findOne({ phone: t.phone }, { name: 1, avatarUrl: 1, app: 1 }).lean();
    const last = t.messages[t.messages.length - 1];
    return {
      id: String(t._id),
      category: t.category,
      status: t.status,
      user: u ? { id: String(u._id), name: u.name || "", avatarUrl: u.avatarUrl || null, phone: maskPhone(t.phone) } : { id: null, name: "Gelöscht", phone: maskPhone(t.phone) },
      app: t.app || null,
      preview: last ? last.text.slice(0, 140) : "",
      lastFrom: last?.from || null,
      count: t.messages.length,
      messages: full ? t.messages : undefined,
      currentApp: full ? u?.app || null : undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  };

  router.get("/admin/tickets", requireAdmin("support"), async (req, res) => {
    const status = ["open", "answered", "closed"].includes(req.query.status) ? req.query.status : "open";
    const tickets = await SupportTicket.find({ status }).sort({ updatedAt: status === "open" ? 1 : -1 }).limit(100).lean();
    const counts = await SupportTicket.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    res.json({
      success: true,
      tickets: await Promise.all(tickets.map((t) => ticketView(t))),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  });

  async function findTicket(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return null;
    }
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) res.status(404).json({ success: false, error: "not_found" });
    return ticket;
  }

  router.get("/admin/tickets/:id", requireAdmin("support"), async (req, res) => {
    const ticket = await findTicket(req, res);
    if (!ticket) return;
    await audit(req, "ticket_view", { target: String(ticket._id) });
    res.json({ success: true, ticket: await ticketView(ticket.toObject(), true) });
  });

  router.post("/admin/tickets/:id/reply", requireAdmin("support"), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
    if (!text) return res.status(400).json({ success: false, error: "text_required" });
    const ticket = await findTicket(req, res);
    if (!ticket) return;
    ticket.messages.push({ from: "support", text, by: req.admin.email });
    ticket.status = req.body?.close ? "closed" : "answered";
    ticket.unreadByUser = true;
    ticket.updatedAt = new Date();
    await ticket.save();
    await audit(req, "ticket_reply", { target: String(ticket._id), meta: { close: !!req.body?.close } });
    io?.to(`user:${ticket.phone}`).emit("supportReply", { id: String(ticket._id) });
    await notify(ticket.phone, "support_reply", {}).catch(() => {});
    res.json({ success: true, ticket: await ticketView(ticket.toObject(), true) });
  });

  router.post("/admin/tickets/:id/status", requireAdmin("support"), async (req, res) => {
    const status = ["open", "closed"].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, error: "invalid_status" });
    const ticket = await findTicket(req, res);
    if (!ticket) return;
    ticket.status = status;
    ticket.updatedAt = new Date();
    await ticket.save();
    await audit(req, `ticket_${status}`, { target: String(ticket._id) });
    // Open apps show the new state right away
    io?.to(`user:${ticket.phone}`).emit("supportReply", { id: String(ticket._id), status });
    res.json({ success: true });
  });

  // --- App configuration ----------------------------------------------------------

  router.get("/admin/config", requireAdmin("viewer"), async (req, res) => {
    const [config, spread] = await Promise.all([appConfig.getConfig(), appConfig.versionSpread()]);
    const flags = config.flags instanceof Map ? Object.fromEntries(config.flags) : config.flags || {};
    // The owner's private alert number, emergency contact and bank balance stay with the owner; others see only whether one is set
    const hide = (v) => (v == null || v === "" ? null : "•••");
    const ops = req.admin.role === "owner" ? config.ops : { ...config.ops, alertPhone: hide(config.ops?.alertPhone), emergencyContact: hide(config.ops?.emergencyContact), bankBalanceEurCents: hide(config.ops?.bankBalanceEurCents) };
    res.json({ success: true, config: { ...config, flags, ops, _id: undefined, __v: undefined }, ...spread });
  });

  router.put("/admin/config", requireAdmin("owner"), async (req, res) => {
    const result = await appConfig.saveConfig(req.body || {}, req.admin.email);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    await audit(req, "config_changed", { meta: req.body });
    io?.emit("appConfig", result.config);
    res.json({ success: true, config: result.config });
  });

  return router;
};
