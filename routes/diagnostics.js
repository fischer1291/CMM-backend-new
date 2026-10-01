/**
 * Crash reports without a tracking SDK: the app sends uncaught JavaScript
 * errors here (also before sign-in), the admin console lists them grouped.
 * Native crashes come from Xcode Organizer / App Store Connect.
 */
const crypto = require("crypto");
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const ClientError = require("../models/ClientError");
const opsCounters = require("../lib/opsCounters");

const MAX_VERSIONS = 10;
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

  // POST /diagnostics/errors { message, stack?, fatal?, version?, platform? }
  router.post("/diagnostics/errors", limit, async (req, res) => {
    const message = clean(req.body?.message, 500).trim();
    if (!message) return res.status(400).json({ success: false });
    const stack = clean(req.body?.stack, 4000);
    const version = clean(req.body?.version, 20).replace(/[^\w .()-]/g, "").trim();
    const platform = ["ios", "android", "web"].includes(req.body?.platform) ? req.body.platform : null;
    const now = new Date();
    await ClientError.updateOne(
      { key: keyOf(message, stack) },
      {
        $setOnInsert: { message, stack, platform, firstAt: now },
        $set: { lastAt: now, ...(req.body?.fatal === true ? { fatal: true } : {}) },
        $inc: { count: 1 },
        ...(version ? { $addToSet: { versions: version } } : {}),
      },
      { upsert: true },
    );
    // Keep the version list short: the newest ones
    await ClientError.updateOne(
      { key: keyOf(message, stack), [`versions.${MAX_VERSIONS}`]: { $exists: true } },
      { $push: { versions: { $each: [], $slice: -MAX_VERSIONS } } },
    );
    // Per day, for the alert "three times yesterday's errors" (lib/alerts.js)
    opsCounters.count("clientErrors", now).catch((err) => console.error("❌ opsCounters:", err.message));
    res.json({ success: true });
  });

  return router;
};

module.exports.keyOf = keyOf;
