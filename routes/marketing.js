/**
 * Marketing agent and ad approvals (lib/marketing.js).
 *
 * agentRoutes: the daily agent (Bearer MARKETING_AGENT_KEY) reads the numbers,
 * adds drafts and uploads their videos. adminRoutes: the console lists the
 * drafts; owners approve, reject and mark them as posted.
 */
const express = require("express");
const marketing = require("../lib/marketing");
const { requireAdmin, audit } = require("../lib/adminAuth");

function agentRoutes() {
  const router = express.Router();
  const agentOnly = (req, res, next) =>
    marketing.agentAuthorized(req.headers.authorization) ? next() : res.status(401).json({ success: false, error: "unauthorized" });

  router.get("/marketing/context", agentOnly, async (req, res) => {
    res.json({ success: true, ...(await marketing.context()) });
  });

  // POST /marketing/drafts { campaign, template, title, idea, content, seconds, captions, hashtags, model }
  router.post("/marketing/drafts", agentOnly, async (req, res) => {
    const result = await marketing.createDraft(req.body);
    if (result.error) return res.status(result.error === "campaign_taken" ? 409 : 400).json({ success: false, error: result.error });
    res.status(201).json({ success: true, draft: result.draft });
  });

  // PUT /marketing/drafts/:id/video, body: the MP4 (Content-Type: video/mp4)
  router.put(
    "/marketing/drafts/:id/video",
    agentOnly,
    express.raw({ type: "video/mp4", limit: "40mb" }),
    async (req, res) => {
      try {
        const result = await marketing.attachVideo(req.params.id, req.body);
        if (result.error) return res.status(result.error === "not_found" ? 404 : 400).json({ success: false, error: result.error });
        res.json({ success: true, draft: result.draft });
      } catch (err) {
        console.error("❌ marketing video upload:", err.message);
        res.status(502).json({ success: false, error: "upload_failed" });
      }
    },
  );

  // After a run: mail the owners if something waits for approval
  router.post("/marketing/notify", agentOnly, async (req, res) => {
    res.json({ success: true, ...(await marketing.notifyOwners()) });
  });

  return router;
}

function adminRoutes() {
  const router = express.Router();

  router.get("/admin/marketing/drafts", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, ...(await marketing.list(String(req.query.status || "pending"))) });
  });

  // POST /admin/marketing/drafts/:id/decision { action: approve|reject, feedback? }
  router.post("/admin/marketing/drafts/:id/decision", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.decide(req.params.id, req.body?.action, req.admin.email, req.body?.feedback);
    if (result.error) return res.status(result.error === "invalid_action" ? 400 : 409).json({ success: false, error: result.error });
    await audit(req, `ad_${req.body.action === "approve" ? "approved" : "rejected"}`, { target: result.draft.campaign });
    res.json({ success: true, draft: result.draft });
  });

  // POST /admin/marketing/drafts/:id/posted { platform: instagram|tiktok, posted: true|false }
  router.post("/admin/marketing/drafts/:id/posted", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.markPosted(req.params.id, req.body?.platform, req.body?.posted !== false);
    if (result.error) return res.status(result.error === "invalid_platform" ? 400 : 409).json({ success: false, error: result.error });
    res.json({ success: true, draft: result.draft });
  });

  return router;
}

module.exports = { agentRoutes, adminRoutes };
