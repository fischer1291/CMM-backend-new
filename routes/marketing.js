/**
 * Marketing agent and ad approvals (lib/marketing.js).
 *
 * agentRoutes: the daily agent (Bearer MARKETING_AGENT_KEY) reads the numbers,
 * reserves budget before each paid call (lib/marketingBudget.js), adds drafts
 * and uploads their videos and reference images. adminRoutes: the console
 * lists drafts, budget and characters; owners approve, reject, mark as
 * posted, set the budget and choose the reference images.
 */
const express = require("express");
const marketing = require("../lib/marketing");
const budget = require("../lib/marketingBudget");
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

  // --- Budget: reserve before every paid call, settle or release after ---
  router.get("/marketing/budget", agentOnly, async (req, res) => {
    res.json({ success: true, budget: await budget.status() });
  });

  // POST /marketing/budget/reserve { provider, purpose, estimateEur, campaign?, note? }
  router.post("/marketing/budget/reserve", agentOnly, async (req, res) => {
    const result = await budget.reserve(req.body || {});
    if (result.error === "budget_exceeded") return res.status(402).json({ success: false, error: result.error, budget: result.budget });
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.status(201).json({ success: true, ...result.reservation });
  });

  // POST /marketing/budget/:id/settle { costEur }
  router.post("/marketing/budget/:id/settle", agentOnly, async (req, res) => {
    const result = await budget.settle(req.params.id, req.body?.costEur);
    if (result.error) return res.status(result.error === "not_reserved" ? 409 : 400).json({ success: false, error: result.error });
    res.json({ success: true, budget: await budget.status() });
  });

  router.post("/marketing/budget/:id/release", agentOnly, async (req, res) => {
    const result = await budget.release(req.params.id);
    if (result.error) return res.status(409).json({ success: false, error: result.error });
    res.json({ success: true, budget: await budget.status() });
  });

  // --- Characters: keep them in sync, upload reference image proposals ---
  router.get("/marketing/characters", agentOnly, async (req, res) => {
    res.json({ success: true, characters: await marketing.listCharacters() });
  });

  // PUT /marketing/characters/:key { name, summary }
  router.put("/marketing/characters/:key", agentOnly, async (req, res) => {
    const result = await marketing.upsertCharacter(req.params.key, req.body || {});
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, character: result.character });
  });

  // POST /marketing/characters/:key/candidates, body: the image (image/png or image/jpeg)
  router.post(
    "/marketing/characters/:key/candidates",
    agentOnly,
    express.raw({ type: ["image/png", "image/jpeg"], limit: "8mb" }),
    async (req, res) => {
      try {
        const result = await marketing.addCandidate(req.params.key, req.body);
        if (result.error) return res.status(result.error === "not_found" ? 404 : 400).json({ success: false, error: result.error });
        res.status(201).json({ success: true, character: result.character });
      } catch (err) {
        console.error("❌ marketing character upload:", err.message);
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

  router.get("/admin/marketing/budget", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, ...(await budget.overview()) });
  });

  // PUT /admin/marketing/budget { dailyEur, weeklyEur }
  router.put("/admin/marketing/budget", requireAdmin("owner"), async (req, res) => {
    const result = await budget.setCaps(req.body || {}, req.admin.email);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    await audit(req, "marketing_budget_set", { meta: { dailyEur: result.budget.dailyEur, weeklyEur: result.budget.weeklyEur } });
    res.json({ success: true, budget: result.budget });
  });

  router.get("/admin/marketing/characters", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, characters: await marketing.listCharacters() });
  });

  // POST /admin/marketing/characters/:key/choose { url }
  router.post("/admin/marketing/characters/:key/choose", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.chooseCharacterImage(req.params.key, req.body?.url);
    if (result.error) return res.status(result.error === "not_found" ? 404 : 400).json({ success: false, error: result.error });
    await audit(req, "marketing_character_chosen", { target: req.params.key });
    res.json({ success: true, character: result.character });
  });

  // POST /admin/marketing/characters/:key/redo { feedback? }: new proposals on the next run
  router.post("/admin/marketing/characters/:key/redo", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.requestNewImages(req.params.key, req.body?.feedback);
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, character: result.character });
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
