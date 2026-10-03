/**
 * Crash reports without a tracking SDK: the app sends uncaught JavaScript
 * errors here (also before sign-in), the admin console lists them grouped.
 * Native crashes come from Xcode Organizer / App Store Connect.
 */
const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const ClientError = require("../models/ClientError");
const { acceptToken } = require("../lib/auth");
const opsCounters = require("../lib/opsCounters");

const MAX_VERSIONS = 10;
const UPDATE = /^(embedded|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const clean = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** Group key: the message without numbers and the first app frame of the stack. */
function keyOf(message, stack) {
  const frame = stack.split("\n").find((l) => l.trim() && !l.includes(message)) || "";
  const norm = (s) => s.replace(/\d+/g, "#").replace(/https?:\S+/g, "").trim();
  return crypto.createHash("sha256").update(`${norm(message)}|${norm(frame)}`).digest("hex").slice(0, 32);
}

module.exports = () => {
  const router = express.Router();
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => req.auth?.phone || ipKeyGenerator(req.ip),
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  // POST /diagnostics/errors { message, stack?, fatal?, version?, update?, platform? }
  router.post("/diagnostics/errors", limit, async (req, res) => {
    const message = clean(req.body?.message, 500).trim();
    if (!message) return res.status(400).json({ success: false });
    const stack = clean(req.body?.stack, 4000);
    const version = clean(req.body?.version, 20).replace(/[^\w .()-]/g, "").trim();
    const platform = ["ios", "android", "web"].includes(req.body?.platform) ? req.body.platform : null;
    // Which JavaScript ran: an EAS update id (a UUID) or "embedded"; anything else is dropped
    const update = typeof req.body?.update === "string" && UPDATE.test(req.body.update) ? req.body.update.toLowerCase() : null;
    const now = new Date();
    // The route is public (crashes before sign-in count too), but only a
    // signed-in app may mark an error fatal: a fatal error alerts the owner
    // (lib/alerts.js), and that must not be reachable for anyone with curl
    const header = req.headers.authorization || "";
    const reporter = header.startsWith("Bearer ") ? await acceptToken(header.slice(7)).catch(() => null) : null;
    await ClientError.updateOne(
      { key: keyOf(message, stack) },
      {
        $setOnInsert: { message, stack, platform, firstAt: now },
        $set: { lastAt: now, ...(req.body?.fatal === true && reporter ? { fatal: true } : {}) },
        $inc: { count: 1 },
        ...(version || update ? { $addToSet: { ...(version ? { versions: version } : {}), ...(update ? { updates: update } : {}) } } : {}),
      },
      { upsert: true },
    );
    // Keep the version and update lists short: the newest ones
    for (const list of ["versions", "updates"]) {
      await ClientError.updateOne(
        { key: keyOf(message, stack), [`${list}.${MAX_VERSIONS}`]: { $exists: true } },
        { $push: { [list]: { $each: [], $slice: -MAX_VERSIONS } } },
      );
    }
    // Per day, for the alert "three times yesterday's errors" (lib/alerts.js)
    opsCounters.count("clientErrors", now).catch((err) => console.error("❌ opsCounters:", err.message));
    res.json({ success: true });
  });

  return router;
};

module.exports.keyOf = keyOf;
