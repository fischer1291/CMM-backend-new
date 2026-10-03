/**
 * Marketing agent and ad approvals (lib/marketing.js).
 *
 * agentRoutes: the daily agent (Bearer MARKETING_AGENT_KEY) reads the numbers,
 * reserves budget before each paid call (lib/marketingBudget.js), adds drafts
 * and uploads their videos and reference images, and reports every run
 * (POST /marketing/notify, plan 2.14: a failed one raises agent_failed). adminRoutes: the console
 * lists drafts, budget and characters; owners approve, reject, mark as
 * posted, set the budget and choose the reference images.
 */
const express = require("express");
const marketing = require("../lib/marketing");
const budget = require("../lib/marketingBudget");
const posting = require("../lib/socialPosting");
const { requireAdmin, audit } = require("../lib/adminAuth");

function agentRoutes() {
  const router = express.Router();
  const agentOnly = (req, res, next) =>
    marketing.agentAuthorized(req.headers.authorization) ? next() : res.status(401).json({ success: false, error: "unauthorized" });

  router.get("/marketing/context", agentOnly, async (req, res) => {
    res.json({ success: true, ...(await marketing.context()) });
  });

  // POST /marketing/drafts { campaign, template, title, idea, content, seconds, captions, hashtags, model, hookVariants? (strings; trimmed, cut to 120 characters, first 2 kept) }
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

  // POST /marketing/budget/reserve { provider: anthropic | google | media, purpose, estimateEur, campaign?, note? }
  router.post("/marketing/budget/reserve", agentOnly, async (req, res) => {
    const result = await budget.reserve(req.body || {});
    if (result.error === "budget_exceeded") return res.status(402).json({ success: false, error: result.error, budget: result.budget });
    // Paid reach before the launch gate is open (plan 2.7)
    if (result.error === "launch_checklist_incomplete") return res.status(403).json({ success: false, error: result.error });
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

  // At the end of every run (plan 2.14). POST /marketing/notify { failed?, step?, runUrl?, durationSec? }:
  // without failed, mail and push the owners if something waits for approval
  // ({ pending, mailed }); with failed: true, the alert agent_failed ({ alerted })
  router.post("/marketing/notify", agentOnly, async (req, res) => {
    res.json({ success: true, ...(await marketing.reportRun(req.body || {})) });
  });

  return router;
}

function adminRoutes() {
  const router = express.Router();

  // --- Posting channels (lib/socialPosting.js) ---
  router.get("/admin/marketing/channels", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, ...(await posting.channelStatus()) });
  });

  // POST /admin/marketing/channels/instagram { token }: the long-lived token from the Meta app dashboard
  router.post("/admin/marketing/channels/instagram", requireAdmin("owner"), async (req, res) => {
    const result = await posting.connectInstagram(req.body?.token, req.admin.email);
    if (result.error) return res.status(400).json({ success: false, error: result.error, message: result.message });
    await audit(req, "marketing_channel_connected", { target: "instagram" });
    res.json({ success: true, channel: result.channel });
  });

  // The TikTok login page to send the owner to
  router.get("/admin/marketing/channels/tiktok/connect", requireAdmin("owner"), async (req, res) => {
    const result = posting.tiktokAuthorizeUrl(String(req.admin._id));
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, url: result.url });
  });

  // PUT /admin/marketing/channels/tiktok { mode: inbox|direct, privacyLevel }
  router.put("/admin/marketing/channels/tiktok", requireAdmin("owner"), async (req, res) => {
    const result = await posting.setTiktok(req.body || {});
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    await audit(req, "marketing_tiktok_settings", { meta: { mode: result.channel.mode, privacyLevel: result.channel.privacyLevel } });
    res.json({ success: true, channel: result.channel });
  });

  router.delete("/admin/marketing/channels/:platform", requireAdmin("owner"), async (req, res) => {
    const result = await posting.disconnect(req.params.platform);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    await audit(req, "marketing_channel_disconnected", { target: req.params.platform });
    res.json({ success: true });
  });

  // TikTok sends the owner back here after login. No admin cookie arrives
  // (SameSite=Strict on a redirect from tiktok.com): the signed state proves
  // an owner started it in the console.
  router.get("/marketing/tiktok/callback", async (req, res) => {
    const result = await posting.finishTiktok({ code: req.query.code, state: req.query.state, error: req.query.error });
    res.redirect(302, `/console/?tiktok=${result.ok ? "ok" : result.error}#approvals`);
  });

  // POST /admin/marketing/drafts/:id/publish-now: post an approved draft right away (or retry)
  router.post("/admin/marketing/drafts/:id/publish-now", requireAdmin("owner"), async (req, res) => {
    const result = await posting.postNow(req.params.id);
    if (result.error) return res.status(409).json({ success: false, error: result.error });
    await audit(req, "ad_publish_now", { target: result.draft.campaign });
    // Posting takes minutes (the platforms process the video): it runs on in the background
    posting.runDue().catch((err) => console.error("❌ publish now:", err.message));
    res.status(202).json({ success: true });
  });

  router.get("/admin/marketing/drafts", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, ...(await marketing.list(String(req.query.status || "pending"))) });
  });

  // The agent at a glance (plan 2.14): { bioLink, bioSlug, bioWeek, runs, aiCostPerPostedVideoEur }
  router.get("/admin/marketing/agent", requireAdmin("viewer"), async (req, res) => {
    res.json({ success: true, ...(await marketing.agentOverview()) });
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
  // PUT /admin/marketing/drafts/:id/texts { captions: { instagram, tiktok }, hashtags }
  router.put("/admin/marketing/drafts/:id/texts", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.editTexts(req.params.id, req.body, req.admin.email);
    if (result.error) return res.status(result.error === "not_editable" || result.error === "already_posting" ? 409 : 400).json({ success: false, error: result.error });
    await audit(req, "ad_texts_edited", { target: result.draft.campaign });
    res.json({ success: true, draft: result.draft });
  });

  // POST /admin/marketing/drafts/:id/skip { platform }: not posted there after all
  router.post("/admin/marketing/drafts/:id/skip", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.skipPlatform(req.params.id, req.body?.platform);
    if (result.error) return res.status(result.error === "invalid_platform" ? 400 : 409).json({ success: false, error: result.error });
    await audit(req, "ad_platform_skipped", { target: result.draft.campaign, platform: req.body.platform });
    res.json({ success: true, draft: result.draft });
  });

  router.post("/admin/marketing/drafts/:id/posted", requireAdmin("owner"), async (req, res) => {
    const result = await marketing.markPosted(req.params.id, req.body?.platform, req.body?.posted !== false);
    if (result.error) return res.status(result.error === "invalid_platform" ? 400 : 409).json({ success: false, error: result.error });
    res.json({ success: true, draft: result.draft });
  });

  return router;
}

module.exports = { agentRoutes, adminRoutes };
