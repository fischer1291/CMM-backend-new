/**
 * "Hilfe & Feedback" in the app: open a ticket, read answers, reply. While
 * an automatic outage banner is on (lib/statusBanner.js, plan 2.15), a new
 * ticket gets an immediate answer that names the outage (by "auto"); the
 * ticket stays open and still counts as waiting for a person.
 *
 * Plan 2.7 adds two things. The app also lists the statements of reasons
 * from lib/moderation.js (category "moderation", with `moderation`: the
 * measure and its end); the person objects by replying. And publicRoutes():
 * POST /reports/public, the report form on wannayap.app/melden for people
 * without an account (DSA Art. 16), before the app's token check.
 */
const express = require("express");
const mongoose = require("mongoose");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const SupportTicket = require("../models/SupportTicket");
const { activeOutage } = require("../lib/statusBanner");
const { normalizePhone } = require("../lib/phone");

const CATEGORIES = ["bug", "idea", "account", "other"];
const MAX_TEXT = 2000;
const MAX_OPEN = 5;

const text = (v) => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const clean = (v, max) => (typeof v === "string" ? v.replace(/[^\w .()-]/g, "").slice(0, max) : null);

const view = (t) => ({
  id: String(t._id),
  category: t.category,
  status: t.status,
  unread: !!t.unreadByUser,
  messages: t.messages.map(({ from, text: body, at }) => ({ from, text: body, at })),
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  closedAt: t.status === "closed" ? t.updatedAt : null,
  ...(t.category === "moderation" ? { moderation: { action: t.moderation?.action || null, until: t.moderation?.until || null } } : {}),
});

/** What the reporter of a public report gets to refer to it: the id's last 8 characters. */
const referenceOf = (id) => String(id).slice(-8).toUpperCase();

/** The automatic answer while an outage banner is on (`text`: the banner's). */
const outageReply = (text) => `Danke für deine Nachricht! Gerade gibt es eine bekannte Störung: ${text} Wir melden uns, sobald sie behoben ist.`;
const AUTO = "auto";

const CATEGORY_LABEL = { bug: "Fehler", idea: "Idee", account: "Konto", other: "Sonstiges" };
/** Push to the console: a new ticket or a reply from the user. */
function tellSupport(ticket, message) {
  const first = ticket.messages.length <= 1;
  require("../lib/adminPush").tell("support", {
    // A reply to a statement of reasons is an objection (DSA Art. 20): named
    // as one, so it does not wait behind ordinary replies
    title: first
      ? `Neue Support-Anfrage: ${CATEGORY_LABEL[ticket.category] || ticket.category}`
      : ticket.category === "moderation"
        ? "Widerspruch gegen eine Entscheidung"
        : "Neue Antwort im Support",
    body: message.length > 140 ? `${message.slice(0, 139)}…` : message,
    url: `#support/${ticket._id}`,
    tag: `support-${ticket._id}`,
  });
}

const routes = () => {
  const router = express.Router();
  const requireAuth = (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => req.auth?.phone || ipKeyGenerator(req.ip),
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  router.get("/support", requireAuth, async (req, res) => {
    const tickets = await SupportTicket.find({ phone: req.auth.phone }).sort({ updatedAt: -1 }).limit(20).lean();
    res.json({ success: true, tickets: tickets.map(view) });
  });

  // POST /support { category, message, app: { version, build, platform, os } }
  router.post("/support", requireAuth, limit, async (req, res) => {
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : null;
    const message = text(req.body?.message);
    if (!category || message.length < 3) return res.status(400).json({ success: false, error: "invalid" });
    // Statements of reasons wait for an answer that is optional: they don't count
    const open = await SupportTicket.countDocuments({ phone: req.auth.phone, status: { $ne: "closed" }, category: { $ne: "moderation" } });
    if (open >= MAX_OPEN) return res.status(429).json({ success: false, error: "too_many_open" });
    const app = req.body?.app || {};
    const outage = await activeOutage().catch(() => null);
    const now = new Date();
    const messages = [{ from: "user", text: message, at: now }];
    if (outage) messages.push({ from: "support", text: outageReply(outage.text), by: AUTO, at: new Date(now.getTime() + 1) });
    const ticket = await SupportTicket.create({
      phone: req.auth.phone,
      category,
      messages,
      app: { version: clean(app.version, 20), build: clean(app.build, 10), platform: clean(app.platform, 10), os: clean(app.os, 20) },
      unreadByUser: !!outage,
    });
    tellSupport(ticket, message);
    res.json({ success: true, ticket: view(ticket) });
  });

  router.post("/support/:id/reply", requireAuth, limit, async (req, res) => {
    const message = text(req.body?.message);
    if (!mongoose.isValidObjectId(req.params.id) || message.length < 1) return res.status(400).json({ success: false, error: "invalid" });
    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, phone: req.auth.phone },
      { $push: { messages: { from: "user", text: message } }, status: "open", unreadByUser: false, updatedAt: new Date() },
      { new: true },
    );
    if (!ticket) return res.status(404).json({ success: false, error: "not_found" });
    tellSupport(ticket, message);
    res.json({ success: true, ticket: view(ticket) });
  });

  // The user opened the answer
  router.post("/support/:id/read", requireAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false });
    await SupportTicket.updateOne({ _id: req.params.id, phone: req.auth.phone }, { unreadByUser: false });
    res.json({ success: true });
  });

  return router;
};

// --- Reports from people without an account (plan 2.7) ------------------

const REPORT_TEXT = [10, 2000];
const MAX_HINT = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORT_LABEL = { harassment: "Belästigung", illegal: "Rechtswidriger Inhalt", spam: "Spam", other: "Sonstiges" };

/** The stored report from the form's body, or null when something is off. */
function publicReport(body) {
  const b = body || {};
  if (!SupportTicket.REPORT_CATEGORIES.includes(b.category)) return null;
  const message = typeof b.text === "string" ? b.text.trim() : "";
  if (message.length < REPORT_TEXT[0] || message.length > REPORT_TEXT[1]) return null;
  const given = (v) => v !== undefined && v !== null && v !== "";
  let reportedPhone = null;
  if (given(b.reportedPhone)) {
    // Typed by hand on the web: German numbers may come without +49
    reportedPhone = typeof b.reportedPhone === "string" && b.reportedPhone.length <= 40 ? normalizePhone(b.reportedPhone, "DE") : null;
    if (!reportedPhone) return null;
  }
  let email = null;
  if (given(b.reporterEmail)) {
    email = typeof b.reporterEmail === "string" ? b.reporterEmail.trim().toLowerCase() : "";
    if (email.length > 200 || !EMAIL.test(email)) return null;
  }
  let momentHint = null;
  if (given(b.momentHint)) {
    momentHint = typeof b.momentHint === "string" ? b.momentHint.trim() : "";
    if (momentHint.length > MAX_HINT) return null;
    momentHint = momentHint || null;
  }
  return { category: b.category, message, reportedPhone, email, momentHint };
}

/** Before the app's token check: the reporter has no account. */
function publicRoutes() {
  const router = express.Router();
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, error: "too_many_reports" },
  });

  // POST /reports/public { category: harassment | illegal | spam | other,
  // text (10–2000), reportedPhone?, reporterEmail?, momentHint? (≤ 200), website? }
  router.post("/reports/public", limit, async (req, res) => {
    // Honeypot: people don't fill in a hidden field, bots do; they get an
    // answer that looks like success
    if (req.body?.website) return res.json({ success: true, reference: referenceOf(new mongoose.Types.ObjectId()) });
    const report = publicReport(req.body);
    if (!report) return res.status(400).json({ success: false, error: "invalid_report" });
    const ticket = await SupportTicket.create({
      phone: null,
      category: "report",
      messages: [{ from: "user", text: report.message }],
      report: { category: report.category, reportedPhone: report.reportedPhone, momentHint: report.momentHint },
      email: report.email,
    });
    console.warn(`🚩 Public report (${report.category})`);
    require("../lib/adminPush").tell("reports", {
      title: `Neue Meldung ohne Konto: ${REPORT_LABEL[report.category]}`,
      body: report.message.length > 140 ? `${report.message.slice(0, 139)}…` : report.message,
      url: `#support/${ticket._id}`,
      tag: `support-${ticket._id}`,
    });
    res.json({ success: true, reference: referenceOf(ticket._id) });
  });

  return router;
}

module.exports = Object.assign(routes, { outageReply, AUTO, publicRoutes, referenceOf, REPORT_LABEL });
