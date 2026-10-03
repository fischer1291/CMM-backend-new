/**
 * The launch gate in the admin console (plan 2.7, lib/launchChecklist.js):
 * everyone reads the checklist with its automatic and manual ticks; owners
 * tick or untick the manual ones, each change audited as launch_checklist.
 * Paid reach (MarketingSpend provider "media") waits until all are done.
 * Mounted like routes/adminWeekly.js.
 */
const express = require("express");
const { requireAdmin, audit } = require("../lib/adminAuth");
const launchChecklist = require("../lib/launchChecklist");

module.exports = () => {
  const router = express.Router();

  // GET /admin/launch-checklist → { complete, items: [{ key, label, kind, done, at, by, note, detail }] }
  router.get("/admin/launch-checklist", requireAdmin("viewer"), async (req, res) => {
    try {
      res.json({ success: true, ...(await launchChecklist.status()) });
    } catch (err) {
      console.error("❌ launch checklist:", err.message);
      res.status(500).json({ success: false, error: "server_error" });
    }
  });

  // PUT /admin/launch-checklist/:key { done, note? }: manual items only
  router.put("/admin/launch-checklist/:key", requireAdmin("owner"), async (req, res) => {
    const result = await launchChecklist.setManual(req.params.key, req.body || {}, req.admin.email);
    if (result.error) return res.status(result.error === "unknown_item" ? 404 : 400).json({ success: false, error: result.error });
    await audit(req, "launch_checklist", { meta: { key: req.params.key, done: result.item.done, note: result.item.note } });
    res.json({ success: true, ...(await launchChecklist.status()) });
  });

  return router;
};
