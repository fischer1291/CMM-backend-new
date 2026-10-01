/**
 * Operations endpoints outside the app's token check: the backup workflow
 * (.github/workflows/db-backup.yml) reports a finished dump with its own key,
 * and the console reads the alert history (lib/alerts.js). Mounted in app.js
 * next to /healthz.
 */
const crypto = require("crypto");
const express = require("express");
const AppConfig = require("../models/AppConfig");
const { requireAdmin } = require("../lib/adminAuth");
const { resetOpsCache } = require("../lib/appConfig");
const alerts = require("../lib/alerts");

/** Bearer BACKUP_PING_KEY (at least 24 characters), compared in constant time as lib/marketing.js agentAuthorized. */
function backupAuthorized(header) {
  const key = process.env.BACKUP_PING_KEY;
  const given = /^Bearer (.+)$/.exec(String(header || ""))?.[1];
  if (!key || key.length < 24 || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

const router = express.Router();

// POST /ops/backup-done { bytes?, name? }: the dump is in the bucket. Feeds
// the alert backup_stale ("no dump for 8 days") and the console.
router.post("/ops/backup-done", async (req, res) => {
  if (!backupAuthorized(req.headers.authorization)) return res.status(401).json({ success: false, error: "unauthorized" });
  const bytes = Number.isInteger(req.body?.bytes) && req.body.bytes >= 0 ? req.body.bytes : null;
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 100) : null;
  const now = new Date();
  await AppConfig.updateOne({ key: "app" }, { $set: { "ops.lastBackupAt": now, "ops.lastBackupBytes": bytes, "ops.lastBackupName": name } }, { upsert: true });
  resetOpsCache();
  console.log(`💾 Backup gemeldet: ${name || "?"} (${bytes == null ? "?" : bytes} Bytes)`);
  res.json({ success: true, lastBackupAt: now });
});

// GET /admin/alerts: the last 50 alerts for the "Heute" tab
router.get("/admin/alerts", requireAdmin("viewer"), async (req, res) => {
  res.json({ success: true, alerts: await alerts.recent(50) });
});

module.exports = router;
module.exports.backupAuthorized = backupAuthorized;
