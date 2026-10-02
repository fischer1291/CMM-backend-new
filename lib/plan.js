/**
 * Wanna yap+: what's free and what Plus adds. The conversation itself is
 * always free; nobody has to pay so that someone else can use something.
 *
 * - circles you *found* count against your limit; joining is never limited
 * - a circle's size and its rounds follow the plan of whoever founded it
 * - memories older than the free window stay stored and come back with Plus
 *
 * The limits live in the app config (admin console → App), so they can be
 * tuned without a deploy. Existing circles above a new limit stay as they are.
 */
const User = require("../models/User");
const { countLimitHit } = require("./paywall");

// momentsPerDay: moment pictures a person may upload per day (Europe/Berlin,
// /upload/moment in app.js), a brake on Cloudinary costs (plan 2.5).
// video: whether a 1:1 call the person starts may use video: true (as the
// app asks), false (always audio) or whole minutes of video a month, after
// which their calls start as audio (lib/calls.js startCall). The defaults
// keep today's behaviour; the switch to an audio default or a free video
// allowance is the owner's decision at the end of phase 2 (plan 2.5).
const DEFAULT_LIMITS = {
  free: { circles: 3, circleMembers: 12, roomParticipants: 6, roomMinutes: 60, memoriesDays: 30, hdVideo: false, rituals: 1, nudgeMessage: false, yearReview: false, appIcons: false, momentsPerDay: 30, video: true },
  plus: { circles: 20, circleMembers: 50, roomParticipants: 12, roomMinutes: null, memoriesDays: null, hdVideo: true, rituals: 3, nudgeMessage: true, yearReview: true, appIcons: true, momentsPerDay: 100, video: true },
};

// Never beyond what the system handles
const HARD = { circles: 20, circleMembers: 50, roomParticipants: 16, rituals: 3, momentsPerDay: 200 };

let cached = null;
let cachedAt = 0;

/** Limits per plan: defaults, overridden by the admin's app config. */
async function limits() {
  if (cached && Date.now() - cachedAt < 30 * 1000) return cached;
  const AppConfig = require("../models/AppConfig");
  const config = await AppConfig.findOne({ key: "app" }, { limits: 1 }).lean().catch(() => null);
  const merged = {};
  for (const plan of ["free", "plus"]) {
    merged[plan] = { ...DEFAULT_LIMITS[plan], ...(config?.limits?.[plan] || {}) };
    for (const [k, max] of Object.entries(HARD)) {
      if (merged[plan][k] != null) merged[plan][k] = Math.min(merged[plan][k], max);
    }
  }
  cached = merged;
  cachedAt = Date.now();
  return merged;
}

const resetLimitsCache = () => {
  cached = null;
};

/** Has `user` Plus right now? */
function isPlus(user, now = new Date()) {
  const p = user?.plus;
  return !!(p?.active && (!p.until || new Date(p.until) > now));
}

/** { plan, limits, plus } for a user object. */
async function planOf(user, now = new Date()) {
  const all = await limits();
  const plus = isPlus(user, now);
  return {
    plan: plus ? "plus" : "free",
    limits: all[plus ? "plus" : "free"],
    plus: plus ? { until: user.plus.until || null, source: user.plus.source || null, productId: user.plus.productId || null } : null,
  };
}

/** The plan of the person with this phone number. */
async function planOfPhone(phone, now = new Date()) {
  const user = await User.findOne({ phone }, { plus: 1 }).lean();
  return planOf(user, now);
}

/**
 * Error for the app: which limit, and whether Plus would lift it. Only
 * called for a refusal, so it also counts the hit (limitHit<Limit>, plan
 * 2.6a, MetricsDaily.plus.limitHits). A moment picture refused at
 * /upload/moment and again at /moment (the app's inline fallback) counts
 * twice; read momentsPerDay as attempts, not people.
 */
function limitError(limit, value, plusValue) {
  countLimitHit(limit);
  return { success: false, error: "plan_limit", limit, value, plus: plusValue == null || plusValue > value ? plusValue ?? "unlimited" : null };
}

/**
 * The momentsPerDay error for `phone`, or null while they may upload
 * another moment picture today (Europe/Berlin). Counted on the person's
 * CallMoments of the day: no extra data, and the app only uploads a picture
 * to post it right after. An upload that never becomes a moment is not
 * counted here; the day counter cloudinaryUploads (MetricsDaily.costs)
 * makes such a pattern visible. Count first, create after: two posts in
 * parallel at the last allowed one can both pass and end one above the
 * limit; accepted, the 200/24 h upload brake in app.js caps the cost.
 */
async function momentLimitError(phone, now = new Date()) {
  const { todayKey, dayRange } = require("./metrics");
  const CallMoment = require("../models/CallMoment");
  const [{ limits: mine }, all] = await Promise.all([planOfPhone(phone, now), limits()]);
  const [from, to] = dayRange(todayKey(now));
  const today = await CallMoment.countDocuments({ userPhone: phone, timestamp: { $gte: from, $lt: to } });
  return today >= mine.momentsPerDay ? limitError("momentsPerDay", mine.momentsPerDay, all.plus.momentsPerDay) : null;
}

/**
 * May a 1:1 call `phone` starts now use video? With the limit `video` true
 * for both plans (the default) nothing is read. A number is the person's
 * video minutes per calendar month (Europe/Berlin): the answered video
 * calls they started this month, as Talk seconds. Calls live 30 days, so on
 * the 31st of a month its first day may be missing; that errs towards video.
 */
async function videoAllowed(phone, now = new Date()) {
  const all = await limits();
  if (all.free.video === true && all.plus.video === true) return true;
  const { limits: mine } = await planOfPhone(phone, now);
  if (mine.video === true || mine.video == null) return true;
  if (mine.video === false) return false;
  const { todayKey, dayStart } = require("./metrics");
  const Call = require("../models/Call");
  const Talk = require("../models/Talk");
  const from = dayStart(`${todayKey(now).slice(0, 8)}01`);
  const calls = await Call.find({ caller: phone, video: { $ne: false }, acceptedAt: { $ne: null }, createdAt: { $gte: from } }, { callId: 1 }).lean();
  if (!calls.length) return true;
  const [used] = await Talk.aggregate([{ $match: { callId: { $in: calls.map((c) => c.callId) } } }, { $group: { _id: null, seconds: { $sum: "$seconds" } } }]);
  return (used?.seconds || 0) < mine.video * 60;
}

module.exports = { DEFAULT_LIMITS, HARD, limits, resetLimitsCache, isPlus, planOf, planOfPhone, limitError, countLimitHit, momentLimitError, videoAllowed };
