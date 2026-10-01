/**
 * Waitlist (lib/waitlist.js). The landing page calls the public routes;
 * redeeming the code happens in the app, signed in.
 */
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const waitlist = require("../lib/waitlist");

const limiter = (limit) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

/** Before the app's token check: the landing page has no account. */
function publicRoutes() {
  const router = express.Router();

  // POST /waitlist { email, ref?, source?, campaign?, website? }
  router.post("/waitlist", limiter(10), async (req, res) => {
    // Honeypot: people don't fill in a hidden field, bots do
    if (req.body?.website) return res.json({ success: true });
    try {
      const result = await waitlist.signUp({
        email: req.body?.email,
        ref: req.body?.ref,
        source: req.body?.source,
        campaign: req.body?.campaign,
        ip: req.ip,
      });
      if (result.error) return res.status(400).json({ success: false, error: result.error });
      // The mail failed but the sign-up is kept: it goes out as soon as it can
      res.json({ success: true, ...(result.mailDelayed ? { mailDelayed: true } : {}) });
    } catch (err) {
      console.error("❌ waitlist signup:", err.message);
      res.status(err.message === "mail_not_configured" ? 503 : 500).json({ success: false, error: "unavailable" });
    }
  });

  // POST /waitlist/visit { source?, campaign?, ref? }: the landing page was opened
  // (a counter per day and source, nothing about the visitor)
  router.post("/waitlist/visit", limiter(120), async (req, res) => {
    try {
      await waitlist.countVisit({ source: req.body?.source, campaign: req.body?.campaign, ref: !!req.body?.ref });
    } catch (err) {
      console.error("❌ waitlist visit:", err.message);
    }
    res.status(204).end();
  });

  // POST /waitlist/event { step: "engaged" | "form" | "store", source?, campaign?, ref? }:
  // a step towards a sign-up, or the tap on a store button, on the landing
  // page (counters, like visits)
  router.post("/waitlist/event", limiter(120), async (req, res) => {
    const step = req.body?.step;
    if (!["engaged", "form", "store"].includes(step)) return res.status(400).json({ success: false, error: "invalid_step" });
    try {
      await waitlist.countStep(step, { source: req.body?.source, campaign: req.body?.campaign, ref: !!req.body?.ref });
    } catch (err) {
      console.error("❌ waitlist event:", err.message);
    }
    res.status(204).end();
  });

  // POST /waitlist/confirm { token }: the link in the confirmation mail
  router.post("/waitlist/confirm", limiter(60), async (req, res) => {
    const status = await waitlist.confirm(req.body?.token, req.ip);
    if (!status) return res.status(404).json({ success: false, error: "unknown_token" });
    res.json({ success: true, ...status, code: waitlist.showCode(status.code) });
  });

  // GET /waitlist/status/:code: place and confirmed friends (share page)
  router.get("/waitlist/status/:code", limiter(120), async (req, res) => {
    const status = await waitlist.status(req.params.code);
    if (!status) return res.status(404).json({ success: false, error: "unknown_code" });
    res.json({ success: true, ...status, code: waitlist.showCode(status.code) });
  });

  // POST /waitlist/unsubscribe { token } (link in the mail, via the landing page)
  // POST /waitlist/unsubscribe/:token (one-click from the mail client, RFC 8058)
  const unsubscribe = async (req, res) => {
    await waitlist.unsubscribe(req.params.token || req.body?.token);
    // Same answer either way: nothing to learn about who is on the list
    res.json({ success: true });
  };
  router.post("/waitlist/unsubscribe", limiter(60), unsubscribe);
  router.post("/waitlist/unsubscribe/:token", limiter(60), express.urlencoded({ extended: false, limit: "1kb" }), unsubscribe);

  return router;
}

/** After the token check: redeem the code in the app. */
function appRoutes(io) {
  const router = express.Router();
  // POST /me/waitlist/redeem { code }
  router.post("/me/waitlist/redeem", limiter(20), async (req, res) => {
    if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
    const result = await waitlist.redeem(req.auth.phone, req.body?.code, io);
    if (result.error) return res.status(result.error === "unknown_user" ? 404 : 400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });
  return router;
}

module.exports = { publicRoutes, appRoutes };
