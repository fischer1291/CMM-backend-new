/**
 * The campaigns tab of the admin console (plan 2.10, lib/acquisition.js):
 * the registered campaigns with their numbers per slug and the slugs nobody
 * registered (viewer and up), creating and editing them (owners, audited as
 * campaign_created / campaign_updated), and the QR code of a campaign's
 * store link (/k/<slug>) as SVG for flyers. Mounted like routes/adminExport.js.
 */
const express = require("express");
const Campaign = require("../models/Campaign");
const { requireAdmin, audit } = require("../lib/adminAuth");
const acquisition = require("../lib/acquisition");

module.exports = () => {
  const router = express.Router();

  // GET /admin/campaigns: { campaigns: [{ ...campaign, links, numbers }], unregistered, days, seedCampaign }
  router.get("/admin/campaigns", requireAdmin("viewer"), async (req, res) => {
    try {
      res.json({ success: true, ...(await acquisition.campaignNumbers()) });
    } catch (err) {
      console.error("❌ admin campaigns:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // POST /admin/campaigns { slug, channel, title?, startedAt?, endedAt?, budgetEurCents?, partner?, status?, notes? }
  router.post("/admin/campaigns", requireAdmin("owner"), async (req, res) => {
    const result = acquisition.validCampaign(req.body);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    try {
      const campaign = await Campaign.create({ ...result.fields, createdBy: req.admin.email });
      await audit(req, "campaign_created", { target: campaign.slug, meta: result.fields });
      res.json({ success: true, campaign: acquisition.plainCampaign(campaign.toObject()) });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ success: false, error: "slug_taken" });
      console.error("❌ campaign create:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // PUT /admin/campaigns/:slug { channel?, title?, …; the slug stays }
  router.put("/admin/campaigns/:slug", requireAdmin("owner"), async (req, res) => {
    const existing = await Campaign.findOne({ slug: String(req.params.slug) }).lean();
    if (!existing) return res.status(404).json({ success: false, error: "campaign_not_found" });
    if ("slug" in (req.body || {}) && req.body.slug !== existing.slug) return res.status(400).json({ success: false, error: "slug_fixed" });
    const result = acquisition.validCampaign(req.body, existing);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    try {
      const campaign = await Campaign.findOneAndUpdate({ slug: existing.slug }, { $set: result.fields }, { new: true, runValidators: true }).lean();
      await audit(req, "campaign_updated", { target: existing.slug, meta: result.fields });
      res.json({ success: true, campaign: acquisition.plainCampaign(campaign) });
    } catch (err) {
      console.error("❌ campaign update:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // GET /admin/campaigns/:slug/qr.svg: the QR code of https://wannayap.app/k/<slug>
  router.get("/admin/campaigns/:slug/qr.svg", requireAdmin("viewer"), async (req, res) => {
    const slug = acquisition.slugOf(req.params.slug);
    if (!slug || slug !== req.params.slug) return res.status(400).json({ success: false, error: "invalid_slug" });
    try {
      const svg = await acquisition.qrSvg(slug);
      res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="wannayap-${slug}.svg"`);
      res.send(svg);
    } catch (err) {
      console.error("❌ campaign qr:", err.message);
      res.status(500).json({ success: false });
    }
  });

  return router;
};
