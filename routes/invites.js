/**
 * The personal invite link (lib/invites.js). /einladung has no account, so
 * the visit counter is public and mounted before the token check in app.js;
 * joining through a code happens in routes/verify.js /check.
 */
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { countInviteVisit } = require("../lib/invites");

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  skip: () => process.env.NODE_ENV === "test",
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function publicRoutes() {
  const router = express.Router();

  // POST /invites/visit { code, platform: "ios" | "android" | "other" }: the
  // invite page was opened (a counter per day, code and platform, nothing
  // about the visitor). Unknown codes count too and answer valid: false.
  router.post("/invites/visit", limiter, async (req, res) => {
    try {
      const { counted, valid } = await countInviteVisit({ code: req.body?.code, platform: req.body?.platform });
      if (!counted) return res.status(400).json({ success: false, error: "invalid_code" });
      res.json({ success: true, valid });
    } catch (err) {
      console.error("❌ invite visit:", err.message);
      res.status(500).json({ success: false, error: "unavailable" });
    }
  });

  return router;
}

module.exports = { publicRoutes };
