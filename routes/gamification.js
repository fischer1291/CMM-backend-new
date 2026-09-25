/**
 * Schedules, personal talk-time stats (+ opt-in sharing) and nudges.
 * All endpoints need a token: they are new, so no legacy clients exist.
 */
const express = require("express");
const User = require("../models/User");
const Nudge = require("../models/Nudge");
const { normalizePhone, regionOf } = require("../lib/phone");
const { parseSchedule, nextSlot } = require("../lib/schedule");
const { statsFor, sharedView, canView } = require("../lib/stats");
const { isValidTimezone } = require("../lib/localTime");
const { notify } = require("../lib/notify");
const { badgesOf, CATEGORIES, newlyEarned, seenState, nextUp, friendshipOf } = require("../lib/badges");
const { isBlocked } = require("../lib/relations");
const { coMembersOf } = require("../lib/circles");
const { nextNudgeAllowed, VISIBLE_MS } = require("../lib/nudges");

const MAX_NUDGES_PER_DAY = 20;
const MAX_SHARED_WITH = 200;

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ success: false, error: "Authentication required" });
  next();
}

const scheduleOf = (user) => ({
  enabled: !!user.schedule?.enabled,
  timezone: user.schedule?.timezone || null,
  slots: (user.schedule?.slots || []).map(({ day, start, end }) => ({ day, start, end })),
});

module.exports = (io) => {
  const router = express.Router();
  router.use(["/me/schedule", "/me/stats", "/me/badges", "/me/showcase", "/stats", "/friends", "/nudge", "/nudges"], requireAuth);

  const me = (req) => User.findOne({ phone: req.auth.phone });

  // --- Schedule ---------------------------------------------------------

  router.get("/me/schedule", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, schedule: scheduleOf(user), next: nextSlot(user.schedule) });
  });

  router.put("/me/schedule", async (req, res) => {
    const { value, error } = parseSchedule(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const user = await User.findOneAndUpdate({ phone: req.auth.phone }, { schedule: value }, { new: true });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, schedule: scheduleOf(user), next: nextSlot(user.schedule) });
  });

  // --- Stats ------------------------------------------------------------

  router.get("/me/stats", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const timezone = isValidTimezone(req.query.tz) ? req.query.tz : undefined;
    try {
      const stats = await statsFor(user, { timezone });
      res.json({
        success: true,
        stats,
        sharing: {
          visibility: user.statsSharing?.visibility || "private",
          sharedWith: user.statsSharing?.sharedWith || [],
        },
      });
    } catch (err) {
      console.error("❌ stats:", err.message);
      res.status(500).json({ success: false, error: "Statistik konnte nicht geladen werden" });
    }
  });

  // --- Badge album ------------------------------------------------------

  // GET /me/badges: the album, what's new since last time, what's next
  router.get("/me/badges", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const badges = await badgesOf(user);
    // First visit: everything already earned counts as seen (no flood of celebrations)
    if (!user.badgeSeen) {
      await User.updateOne({ phone: user.phone }, { badgeSeen: seenState(badges) });
    }
    res.json({
      success: true,
      categories: CATEGORIES,
      badges,
      new: newlyEarned(badges, user.badgeSeen),
      nextUp: nextUp(badges),
      showcase: user.showcase || [],
    });
  });

  // POST /me/badges/seen: the new ones were celebrated
  router.post("/me/badges/seen", async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ success: false });
    await User.updateOne({ phone: user.phone }, { badgeSeen: seenState(await badgesOf(user)) });
    res.json({ success: true });
  });

  // PUT /me/showcase { ids }: up to three earned badges on show
  router.put("/me/showcase", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : null;
    if (!ids || ids.length > 3) return res.status(400).json({ success: false, error: "up to 3 ids" });
    const user = await me(req);
    const earned = new Set((await badgesOf(user)).filter((b) => b.earned).map((b) => b.id));
    if (!ids.every((id) => earned.has(id))) return res.status(400).json({ success: false, error: "not_earned" });
    await User.updateOne({ phone: user.phone }, { showcase: ids });
    res.json({ success: true, showcase: ids });
  });

  // GET /friends/:phone: what the two of you built together, and their showcase
  router.get("/friends/:phone", async (req, res) => {
    const viewer = req.auth.phone;
    const other = normalizePhone(req.params.phone, regionOf(viewer));
    const [meUser, them] = await Promise.all([me(req), other ? User.findOne({ phone: other }) : null]);
    if (!them || other === viewer || (await isBlocked(viewer, other))) {
      return res.status(404).json({ success: false, error: "not_found" });
    }
    const knows = meUser.contacts.includes(other) || (await coMembersOf(viewer)).has(other);
    if (!knows) return res.status(404).json({ success: false, error: "not_found" });

    const friendship = await friendshipOf(viewer, other, meUser.timezone || meUser.schedule?.timezone);
    let showcase = [];
    if (canView(them, viewer) && them.showcase?.length) {
      const theirs = await badgesOf(them);
      showcase = them.showcase
        .map((id) => theirs.find((b) => b.id === id && b.earned))
        .filter(Boolean)
        .map(({ id, title, icon, tierName }) => ({ id, title, icon, tierName }));
    }
    res.json({ success: true, ...friendship, showcase });
  });

  router.put("/me/stats/sharing", async (req, res) => {
    const { visibility, sharedWith = [] } = req.body || {};
    if (!["private", "contacts", "selected"].includes(visibility)) {
      return res.status(400).json({ success: false, error: "Invalid visibility" });
    }
    if (!Array.isArray(sharedWith) || sharedWith.length > MAX_SHARED_WITH) {
      return res.status(400).json({ success: false, error: "Invalid sharedWith" });
    }
    const region = regionOf(req.auth.phone);
    const phones = [...new Set(sharedWith.map((p) => normalizePhone(String(p), region)).filter(Boolean))];

    const user = await User.findOneAndUpdate(
      { phone: req.auth.phone },
      { statsSharing: { visibility, sharedWith: visibility === "selected" ? phones : [] } },
      { new: true },
    );
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, sharing: user.statsSharing });
  });

  // Someone else's stats, only if they chose to share them with the viewer
  router.get("/stats/:phone", async (req, res) => {
    const target = normalizePhone(req.params.phone, regionOf(req.auth.phone));
    const owner = target && (await User.findOne({ phone: target }));
    // Same answer for "unknown" and "not shared": no account enumeration
    if (!owner || !canView(owner, req.auth.phone)) {
      return res.status(403).json({ success: false, shared: false });
    }
    const stats = await statsFor(owner);
    stats.showcase = (owner.showcase || [])
      .map((id) => stats.badges.find((b) => b.id === id && b.earned))
      .filter(Boolean)
      .map(({ id, title, icon, tierName }) => ({ id, title, icon, tierName }));
    res.json({ success: true, shared: true, name: owner.name || "", stats: sharedView(stats) });
  });

  // --- Nudges -----------------------------------------------------------

  // POST /nudge { phone }: "I'd like to talk" to a contact who is offline
  router.post("/nudge", async (req, res) => {
    const from = req.auth.phone;
    const to = normalizePhone(String(req.body?.phone || ""), regionOf(from));
    if (!to || to === from) return res.status(400).json({ success: false, error: "invalid" });

    const [sender, target] = await Promise.all([User.findOne({ phone: from }), User.findOne({ phone: to })]);
    // Only people who have you in their address book can nudge you
    if (!sender || !target || !target.contacts.includes(from)) {
      return res.status(403).json({ success: false, error: "not_allowed" });
    }
    if (target.isAvailable) {
      return res.status(409).json({ success: false, error: "already_available" });
    }
    const today = await Nudge.countDocuments({ from, createdAt: { $gt: new Date(Date.now() - 24 * 3600 * 1000) } });
    if (today >= MAX_NUDGES_PER_DAY) {
      return res.status(429).json({ success: false, error: "too_many" });
    }
    // Same answer for "unanswered" and "dismissed": the sender isn't told
    const next = await nextNudgeAllowed(from, to);
    if (next.allowedAt) {
      return res.status(429).json({ success: false, error: next.reason, nextAllowedAt: next.allowedAt });
    }

    await Nudge.create({ from, to });
    io.to(`user:${to}`).emit("nudge", { from, name: sender.name || "", at: new Date() });
    const result = await notify(target, "nudge", { phone: from, name: sender.name });
    const after = await nextNudgeAllowed(from, to);
    res.json({ success: true, pushed: !!result.sent, nextAllowedAt: after.allowedAt });
  });

  // GET /nudges: open nudges for me (recent ones only), and when I may nudge
  // each person again
  router.get("/nudges", async (req, res) => {
    const phone = req.auth.phone;
    const now = new Date();
    const [received, sentTo] = await Promise.all([
      Nudge.find({ to: phone, status: "open", createdAt: { $gt: new Date(now - VISIBLE_MS) } })
        .sort({ createdAt: -1 })
        .lean(),
      Nudge.distinct("to", { from: phone }),
    ]);
    const senders = await User.find({ phone: { $in: received.map((n) => n.from) } }, "phone name").lean();
    const nameOf = new Map(senders.map((u) => [u.phone, u.name || ""]));
    const sent = [];
    for (const to of sentTo) {
      const { allowedAt } = await nextNudgeAllowed(phone, to, now);
      if (allowedAt) sent.push({ to, nextAllowedAt: allowedAt });
    }
    res.json({
      success: true,
      received: received.map((n) => ({ from: n.from, name: nameOf.get(n.from) || "", at: n.createdAt })),
      sent,
    });
  });

  // POST /nudges/dismiss { from? }: "Nicht jetzt" (all open nudges if no sender)
  router.post("/nudges/dismiss", async (req, res) => {
    const filter = { to: req.auth.phone, status: "open" };
    if (req.body?.from) {
      filter.from = normalizePhone(String(req.body.from), regionOf(req.auth.phone));
    }
    const result = await Nudge.updateMany(filter, { status: "dismissed", resolvedAt: new Date() });
    res.json({ success: true, dismissed: result.modifiedCount });
  });

  return router;
};
