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

const DEFAULT_LIMITS = {
  free: { circles: 3, circleMembers: 12, roomParticipants: 6, roomMinutes: 60, memoriesDays: 30, hdVideo: false },
  plus: { circles: 20, circleMembers: 50, roomParticipants: 12, roomMinutes: null, memoriesDays: null, hdVideo: true },
};

// Never beyond what the system handles
const HARD = { circles: 20, circleMembers: 50, roomParticipants: 16 };

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

/** Error for the app: which limit, and whether Plus would lift it. */
function limitError(limit, value, plusValue) {
  return { success: false, error: "plan_limit", limit, value, plus: plusValue == null || plusValue > value ? plusValue ?? "unlimited" : null };
}

module.exports = { DEFAULT_LIMITS, HARD, limits, resetLimitsCache, isPlus, planOf, planOfPhone, limitError };
