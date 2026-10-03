/**
 * The weekly report in the admin console (plan 2.11, lib/weeklyReport.js):
 * reading it for a week with the acknowledgements given so far (viewer and
 * up), and the Monday review itself, acknowledged with the hours spent on
 * operations and up to three decisions (owners and support, audited as
 * weekly_ack). Mounted like routes/adminCampaigns.js.
 */
const express = require("express");
const WeeklyReview = require("../models/WeeklyReview");
const { requireAdmin, audit } = require("../lib/adminAuth");
const weeklyReport = require("../lib/weeklyReport");
const { isoWeek, shiftDateKey, weekKey } = require("../lib/localTime");

const HOUR_KEYS = ["alerts", "support", "approvals"];
const MAX_HOURS = 80;
const MAX_DECISIONS = 3;
const MAX_DECISION_LENGTH = 300;

/** One review as the console shows it. */
const reviewView = (r) => ({ email: r.email, hours: r.hours, decisions: r.decisions || [], ackAt: r.ackAt });

/**
 * The body of POST /admin/weekly/ack checked: { week, hours, decisions } or
 * { error }. hours: all three keys, numbers 0–80 (strings with a comma
 * work too), rounded to one decimal; decisions: up to three texts of at
 * most 300 characters, empty ones dropped.
 */
function validAck(body, now = new Date()) {
  const range = typeof body?.week === "string" ? weeklyReport.resolveWeek(body.week, now) : null;
  // The running week may be acknowledged too (the review can happen on a Sunday)
  const current = weekKey(now, "Europe/Berlin");
  const week = range?.week || (body?.week === isoWeek(current) ? body.week : null);
  if (!week) return { error: "invalid_week" };
  const given = body?.hours;
  if (!given || typeof given !== "object" || HOUR_KEYS.some((k) => given[k] === undefined || given[k] === null || given[k] === "")) return { error: "hours_required" };
  const hours = {};
  for (const k of HOUR_KEYS) {
    const n = typeof given[k] === "string" ? Number(given[k].trim().replace(",", ".")) : given[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_HOURS) return { error: "invalid_hours" };
    hours[k] = Math.round(n * 10) / 10;
  }
  const list = body?.decisions ?? [];
  if (!Array.isArray(list) || list.some((d) => typeof d !== "string")) return { error: "invalid_decisions" };
  const decisions = list.map((d) => d.trim()).filter(Boolean);
  if (decisions.length > MAX_DECISIONS || decisions.some((d) => d.length > MAX_DECISION_LENGTH)) return { error: "invalid_decisions" };
  return { week, hours, decisions };
}

module.exports = () => {
  const router = express.Router();

  // GET /admin/weekly?week=YYYY-Www (default: the last full week):
  // { report, reviews, previousWeek, nextWeek }
  router.get("/admin/weekly", requireAdmin("viewer"), async (req, res) => {
    const range = weeklyReport.resolveWeek(req.query.week);
    if (!range) return res.status(400).json({ success: false, error: "invalid_week" });
    try {
      const [report, reviews] = await Promise.all([weeklyReport.report(range.week), WeeklyReview.find({ week: range.week }).sort({ ackAt: 1 }).lean()]);
      const next = isoWeek(shiftDateKey(range.monday, 7));
      res.json({
        success: true,
        report,
        reviews: reviews.map(reviewView),
        previousWeek: isoWeek(shiftDateKey(range.monday, -7)),
        nextWeek: weeklyReport.resolveWeek(next) ? next : null,
      });
    } catch (err) {
      console.error("❌ admin weekly:", err.message);
      res.status(500).json({ success: false });
    }
  });

  // POST /admin/weekly/ack { week, hours: { alerts, support, approvals }, decisions: [≤ 3] }:
  // one review per week and admin; a second one replaces the first
  router.post("/admin/weekly/ack", requireAdmin("support"), async (req, res) => {
    const result = validAck(req.body);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    const { week, hours, decisions } = result;
    const ackAt = new Date();
    const save = () =>
      WeeklyReview.findOneAndUpdate({ week, admin: req.admin._id }, { $set: { email: req.admin.email, hours, decisions, ackAt } }, { upsert: true, new: true }).lean();
    // Two taps at once: the second upsert runs into the unique (week, admin) and updates instead
    const review = await save().catch((err) => (err.code === 11000 ? save() : Promise.reject(err)));
    await audit(req, "weekly_ack", { target: week, meta: { hours, decisions: decisions.length } });
    res.json({ success: true, review: { week, ...reviewView(review) } });
  });

  return router;
};

module.exports.validAck = validAck;
