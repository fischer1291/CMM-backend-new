/**
 * App configuration (min version, banner, feature flags, plan limits, the
 * ops block with the SMS cost brakes, the goals the numbers are judged
 * against, the unit prices and fixed costs of plan 2.5) and the app version
 * each user runs (from the X-App-Version / X-App-Build / X-Platform headers).
 */
const AppConfig = require("../models/AppConfig");
const User = require("../models/User");

const VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;
const FLAG = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_FLAGS = 30;
// Sign-up SMS cost brakes (routes/verify.js): a global cap per day, a kill
// switch, and the countries we send to at all; alertPhone (E.164) gets an
// SMS for alerts of level error (lib/alerts.js), null means none;
// emergencyContact (an e-mail address) gets the dead-man mail when no owner
// acknowledged the daily push for 7 days (lib/adminPush.js), null means a
// push to the owners instead. The ops block also keeps lastBackupAt /
// lastBackupBytes from POST /ops/backup-done (routes/ops.js), which the
// console only reads. bankBalanceEurCents is the bank balance the owner
// types in by hand (the runway in lib/economics.js), with bankBalanceAt set
// on every change; null means unknown. Never sent to the app.
const DEFAULT_OPS = { smsPerDay: 100, smsPaused: false, smsRegions: ["DE", "AT", "CH"], alertPhone: null, emergencyContact: null, bankBalanceEurCents: null };
// |bank balance| in cents the console accepts (100 million euros)
const MAX_BANK_CENTS = 10_000_000_000;
const REGION = /^[A-Z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REGIONS = 50;
// Goals in percent (plan 1.12): activation within 7 days of the sign-ups of
// the last four weeks, and new people with at least three registered
// contacts. The morning push and the console show a traffic light against
// them; the marketing budget card turns red below the activation goal.
// Never sent to the app.
const DEFAULT_GOALS = { activationPct: 40, densityPct: 50 };
// Unit prices for the cost columns (plan 2.5, lib/metrics.js priceCosts).
// Every default is an ASSUMPTION from public price lists (2026), to be
// checked against the invoices on the 5th of each month; the console says
// "Annahme, gegen Rechnung prüfen". Agora bills in US dollars, so its two
// prices are US cents per 1,000 participant minutes, converted with
// eurPerUsd. All video counts as Agora's HD tier: 640×360 and 720p cost the
// same, there is no cheaper SD tier, so no quality report from the app is
// needed. appleCommissionPct is 15 with the Small Business Program, 30
// without. plusMonthlyEurCents / plusYearlyEurCents are list prices for the
// break-even before the first purchase; null means "take the last
// purchase". Only the prices the owner set are stored (null resets one to
// its default), so a corrected default here still reaches every key nobody
// checked yet. Never sent to the app.
const DEFAULT_PRICES = {
  smsEurCents: 8, // per started verification (Twilio Verify, DE)
  agoraAudioUsdCentsPer1000Min: 99,
  agoraVideoUsdCentsPer1000Min: 399,
  agoraFreeMinutesPerMonth: 10000,
  cloudinaryEurCentsPerUpload: 0, // free tier
  pushEurCentsPer1000: 0, // Expo push and APNs cost nothing per message
  appleCommissionPct: 15,
  eurPerUsd: 0.92,
  plusMonthlyEurCents: null,
  plusYearlyEurCents: null,
};
// Fixed costs: at most this many entries, service names up to 60
// characters, |monthlyEurCents| up to 100,000 € (credits are negative)
const MAX_FIXED_COSTS = 50;
const MAX_FIXED_CENTS = 10_000_000;
async function getConfig() {
  const c = (await AppConfig.findOne({ key: "app" }).lean()) || { minVersion: null, minBuild: null, updateUrl: null, banner: { enabled: false }, flags: {} };
  return {
    ...c,
    ops: { ...DEFAULT_OPS, ...(c.ops || {}) },
    goals: { ...DEFAULT_GOALS, ...(c.goals || {}) },
    prices: { ...DEFAULT_PRICES, ...(c.prices || {}) },
    fixedCosts: Array.isArray(c.fixedCosts) ? c.fixedCosts : [],
  };
}

/** The goals with defaults filled in. */
const goalsConfig = async () => (await getConfig()).goals;

/** The unit prices with defaults filled in (read once per counted day, no cache). */
async function pricesConfig() {
  const c = await AppConfig.findOne({ key: "app" }, { prices: 1 }).lean().catch(() => null);
  return { ...DEFAULT_PRICES, ...(c?.prices || {}) };
}

// Which price keys take what: [min, max, integer only]
const PRICE_RULES = {
  smsEurCents: [0, 10000, false],
  agoraAudioUsdCentsPer1000Min: [0, 100000, false],
  agoraVideoUsdCentsPer1000Min: [0, 100000, false],
  agoraFreeMinutesPerMonth: [0, 10_000_000, true],
  cloudinaryEurCentsPerUpload: [0, 10000, false],
  pushEurCentsPer1000: [0, 100000, false],
  appleCommissionPct: [0, 100, false],
  eurPerUsd: [0.01, 10, false],
  plusMonthlyEurCents: [1, 100000, true],
  plusYearlyEurCents: [1, 1000000, true],
};

/**
 * The stored price overrides after `given` (on top of `stored`, the
 * overrides saved so far), or null when a value is invalid. null removes
 * an override, so the key falls back to DEFAULT_PRICES.
 */
function validPrices(given, stored) {
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const out = { ...(stored || {}) };
  for (const [key, value] of Object.entries(given)) {
    const rule = PRICE_RULES[key];
    if (!rule) return null;
    if (value === null) {
      delete out[key];
      continue;
    }
    const [min, max, integer] = rule;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return null;
    out[key] = value;
  }
  return out;
}

/**
 * The fixed costs list as stored: [{ service, monthlyEurCents, note, until }],
 * or null when it is invalid. A credit (startup programme) is a negative
 * entry with an end date; `until` null means ongoing.
 */
function validFixedCosts(list) {
  if (!Array.isArray(list) || list.length > MAX_FIXED_COSTS) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const service = typeof item.service === "string" ? item.service.trim() : "";
    const cents = item.monthlyEurCents;
    if (!service || service.length > 60) return null;
    if (!Number.isInteger(cents) || Math.abs(cents) > MAX_FIXED_CENTS) return null;
    if (item.note != null && (typeof item.note !== "string" || item.note.length > 200)) return null;
    let until = null;
    if (item.until != null && item.until !== "") {
      until = new Date(item.until);
      if (isNaN(until)) return null;
    }
    out.push({ service, monthlyEurCents: cents, note: item.note ? item.note.trim() : "", until });
  }
  return out;
}

// Flags read on hot paths (every call request) come from a short cache
let flagsCached = null;
let flagsCachedAt = 0;

/** Current value of a feature flag, `fallback` when it isn't set (cached 30 s). */
async function flag(name, fallback = false) {
  if (!flagsCached || Date.now() - flagsCachedAt > 30 * 1000) {
    const c = await AppConfig.findOne({ key: "app" }, { flags: 1 }).lean().catch(() => null);
    flagsCached = Object.fromEntries(c?.flags instanceof Map ? c.flags : Object.entries(c?.flags || {}));
    flagsCachedAt = Date.now();
  }
  return typeof flagsCached[name] === "boolean" ? flagsCached[name] : fallback;
}

const resetFlagsCache = () => {
  flagsCached = null;
};

// The ops block is read on every /verify/start: same short cache
let opsCached = null;
let opsCachedAt = 0;

/** The SMS cost brakes with defaults filled in (cached 30 s). */
async function opsConfig() {
  if (!opsCached || Date.now() - opsCachedAt > 30 * 1000) {
    const c = await AppConfig.findOne({ key: "app" }, { ops: 1 }).lean().catch(() => null);
    opsCached = { ...DEFAULT_OPS, ...(c?.ops || {}) };
    opsCachedAt = Date.now();
  }
  return opsCached;
}

const resetOpsCache = () => {
  opsCached = null;
};

/** What the app gets: only what's active. */
async function publicConfig(now = new Date()) {
  const c = await getConfig();
  const banner = c.banner?.enabled && c.banner.text && (!c.banner.until || new Date(c.banner.until) > now) ? { text: c.banner.text, level: c.banner.level || "info", until: c.banner.until || null } : null;
  return {
    minVersion: c.minVersion || null,
    minBuild: c.minBuild || null,
    updateUrl: c.updateUrl || null,
    banner,
    flags: Object.fromEntries(c.flags instanceof Map ? c.flags : Object.entries(c.flags || {})),
  };
}

/** Validate and save the admin's changes. Returns an error code or the config. */
async function saveConfig(input, by) {
  const update = { updatedBy: by, updatedAt: new Date() };
  if ("minVersion" in input) {
    if (input.minVersion !== null && !VERSION.test(String(input.minVersion))) return { error: "invalid_version" };
    update.minVersion = input.minVersion;
  }
  if ("minBuild" in input) {
    const b = input.minBuild === null ? null : Number(input.minBuild);
    if (b !== null && !(Number.isInteger(b) && b > 0 && b < 100000)) return { error: "invalid_build" };
    update.minBuild = b;
  }
  if ("updateUrl" in input) {
    if (input.updateUrl !== null && !/^https:\/\/[^\s]{4,300}$/.test(String(input.updateUrl))) return { error: "invalid_url" };
    update.updateUrl = input.updateUrl;
  }
  if ("banner" in input) {
    const b = input.banner || {};
    const text = String(b.text || "").trim().slice(0, 200);
    if (b.enabled && !text) return { error: "banner_text_required" };
    const until = b.until ? new Date(b.until) : null;
    if (until && isNaN(until)) return { error: "invalid_date" };
    update.banner = { enabled: !!b.enabled, text, level: b.level === "warning" ? "warning" : "info", until };
  }
  if ("limits" in input) {
    const { DEFAULT_LIMITS, HARD } = require("./plan");
    const out = {};
    for (const plan of ["free", "plus"]) {
      const given = input.limits?.[plan] || {};
      out[plan] = {};
      for (const [key, value] of Object.entries(given)) {
        if (!(key in DEFAULT_LIMITS[plan])) return { error: "invalid_limits" };
        const fallback = DEFAULT_LIMITS[plan][key];
        if (key === "video") {
          // true: video as asked · false: audio only · n: n video minutes a month (lib/plan.js)
          if (typeof value !== "boolean" && !(Number.isInteger(value) && value >= 1 && value <= 100000)) return { error: "invalid_limits" };
        } else if (typeof fallback === "boolean") {
          if (typeof value !== "boolean") return { error: "invalid_limits" };
        } else if (value === null) {
          // null = no limit, only where the default allows it (minutes, days)
          if (!["roomMinutes", "memoriesDays"].includes(key)) return { error: "invalid_limits" };
        } else if (!Number.isInteger(value) || value < 1 || (HARD[key] && value > HARD[key]) || value > 100000) {
          return { error: "invalid_limits" };
        }
        out[plan][key] = value;
      }
    }
    update.limits = out;
  }
  if ("flags" in input) {
    const entries = Object.entries(input.flags || {});
    if (entries.length > MAX_FLAGS || entries.some(([k, v]) => !FLAG.test(k) || typeof v !== "boolean")) return { error: "invalid_flags" };
    update.flags = Object.fromEntries(entries);
  }
  if ("ops" in input) {
    const given = input.ops || {};
    const current = (await getConfig()).ops;
    const out = { ...current };
    for (const [key, value] of Object.entries(given)) {
      if (key === "smsPerDay") {
        if (!Number.isInteger(value) || value < 1 || value > 100000) return { error: "invalid_ops" };
      } else if (key === "smsPaused") {
        if (typeof value !== "boolean") return { error: "invalid_ops" };
      } else if (key === "smsRegions") {
        if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REGIONS || value.some((r) => !REGION.test(r))) return { error: "invalid_ops" };
      } else if (key === "alertPhone") {
        if (value !== null && !(typeof value === "string" && require("./phone").normalizePhone(value))) return { error: "invalid_ops" };
      } else if (key === "emergencyContact") {
        if (value !== null && !(typeof value === "string" && EMAIL.test(value.trim()) && value.trim().length <= 200)) return { error: "invalid_ops" };
      } else if (key === "bankBalanceEurCents") {
        if (value !== null && !(Number.isInteger(value) && Math.abs(value) <= MAX_BANK_CENTS)) return { error: "invalid_ops" };
        if (value !== current.bankBalanceEurCents) out.bankBalanceAt = value === null ? null : new Date();
      } else {
        return { error: "invalid_ops" };
      }
      out[key] = key === "smsRegions" ? [...new Set(value)] : key === "alertPhone" && value ? require("./phone").normalizePhone(value) : key === "emergencyContact" && value ? value.trim().toLowerCase() : value;
    }
    update.ops = out;
  }
  if ("goals" in input) {
    const given = input.goals || {};
    const out = { ...(await getConfig()).goals };
    for (const [key, value] of Object.entries(given)) {
      if (!(key in DEFAULT_GOALS) || !Number.isInteger(value) || value < 1 || value > 100) return { error: "invalid_goals" };
      out[key] = value;
    }
    update.goals = out;
  }
  if ("prices" in input) {
    const stored = await AppConfig.findOne({ key: "app" }, { prices: 1 }).lean();
    const out = validPrices(input.prices, stored?.prices);
    if (!out) return { error: "invalid_prices" };
    update.prices = out;
  }
  if ("fixedCosts" in input) {
    const out = validFixedCosts(input.fixedCosts);
    if (!out) return { error: "invalid_fixed_costs" };
    update.fixedCosts = out;
  }
  await AppConfig.updateOne({ key: "app" }, { $set: update }, { upsert: true });
  require("./plan").resetLimitsCache();
  resetFlagsCache();
  resetOpsCache();
  return { config: await publicConfig() };
}

// --- Which app version people run ------------------------------------------

const known = new Map();

/** Remember the version from the request headers (a write only on change). */
function rememberApp(phone, headers) {
  const version = String(headers["x-app-version"] || "").slice(0, 20);
  if (!phone || !VERSION.test(version)) return;
  const build = String(headers["x-app-build"] || "").replace(/[^\d]/g, "").slice(0, 8) || null;
  const platform = ["ios", "android"].includes(headers["x-platform"]) ? headers["x-platform"] : null;
  const os = String(headers["x-os-version"] || "").replace(/[^\w.]/g, "").slice(0, 20) || null;
  const key = `${version}|${build}|${platform}|${os}`;
  if (known.get(phone) === key) return;
  known.set(phone, key);
  if (known.size > 50_000) known.delete(known.keys().next().value);
  User.updateOne({ phone }, { app: { version, build, platform, os, seenAt: new Date() } }).catch(() => known.delete(phone));
}

const resetAppCache = () => known.clear();

// A language tag as the device sends it, e.g. "de-DE" or "en" (BCP 47)
const LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
/**
 * The device language from the first entry of the Accept-Language header
 * ("de-DE,de;q=0.9" → "de-DE"), or null; stored as User.locale only to
 * measure whether a translation is due (users.byLocale in lib/metrics.js).
 */
function localeOf(headers) {
  const first = String(headers?.["accept-language"] || "").split(",")[0].split(";")[0].trim();
  return first && first !== "*" && first.length <= 20 && LOCALE.test(first) ? first : null;
}

/** Users per app version (active in the last 30 days). */
async function versionSpread(now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const rows = await User.aggregate([
    { $match: { "app.seenAt": { $gte: since } } },
    { $group: { _id: { version: "$app.version", build: "$app.build", platform: "$app.platform" }, users: { $sum: 1 } } },
    { $sort: { users: -1 } },
  ]);
  const unknown = await User.countDocuments({ lastOnline: { $gte: since }, "app.seenAt": { $not: { $gte: since } } });
  return { versions: rows.map((r) => ({ ...r._id, users: r.users })), unknown };
}

module.exports = { getConfig, publicConfig, saveConfig, flag, resetFlagsCache, opsConfig, resetOpsCache, DEFAULT_OPS, goalsConfig, DEFAULT_GOALS, pricesConfig, DEFAULT_PRICES, MAX_FIXED_COSTS, rememberApp, resetAppCache, localeOf, versionSpread };
