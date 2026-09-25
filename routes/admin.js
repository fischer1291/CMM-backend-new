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
const { notify } = require("../lib/notify");
const moderation = require("../lib/moderation");
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
} = require("../lib/adminAuth");
const metrics = require("../lib/metrics");

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
      ActiveDay.find({ who: User.hashPhone(phone), day: { $gte: shiftDateKey(today, -27) } }, { day: 1 }).lean(),
    ]);
    const talkBy = Object.fromEntries(talks.map((t) => [String(!!t._id), t]));
    await audit(req, "user_view", { target: String(user._id) });
    res.json({
      success: true,
      user: {
        ...listItem(user),
        timezone: user.timezone || null,
        app: user.app?.version ? user.app : null,
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

  // DSGVO: everything about a person as JSON (e.g. a request by e-mail)
  router.get("/admin/users/:id/export", requireAdmin("owner"), async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    await audit(req, "user_exported", { target: String(user._id) });
    res.set("Content-Disposition", `attachment; filename="call-me-maybe-export-${user._id}.json"`);
    res.json(await exportAccount(user.phone));
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
    res.json({ success: true, config: { ...config, flags, _id: undefined, __v: undefined }, ...spread });
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
