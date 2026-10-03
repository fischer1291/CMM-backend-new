/**
 * "Hilfe & Feedback" in the app: open a ticket, read answers, reply. While
 * an automatic outage banner is on (lib/statusBanner.js, plan 2.15), a new
 * ticket gets an immediate answer that names the outage (by "auto"); the
 * ticket stays open and still counts as waiting for a person.
 */
const express = require("express");
const mongoose = require("mongoose");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const SupportTicket = require("../models/SupportTicket");
const { activeOutage } = require("../lib/statusBanner");

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
});

/** The automatic answer while an outage banner is on (`text`: the banner's). */
const outageReply = (text) => `Danke für deine Nachricht! Gerade gibt es eine bekannte Störung: ${text} Wir melden uns, sobald sie behoben ist.`;
const AUTO = "auto";

const CATEGORY_LABEL = { bug: "Fehler", idea: "Idee", account: "Konto", other: "Sonstiges" };
/** Push to the console: a new ticket or a reply from the user. */
function tellSupport(ticket, message) {
  const first = ticket.messages.length <= 1;
  require("../lib/adminPush").tell("support", {
    title: first ? `Neue Support-Anfrage: ${CATEGORY_LABEL[ticket.category] || ticket.category}` : "Neue Antwort im Support",
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
    const open = await SupportTicket.countDocuments({ phone: req.auth.phone, status: { $ne: "closed" } });
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

module.exports = Object.assign(routes, { outageReply, AUTO });
