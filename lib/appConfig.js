/**
 * App configuration (min version, banner, feature flags) and the app version
 * each user runs (from the X-App-Version / X-App-Build / X-Platform headers).
 */
const AppConfig = require("../models/AppConfig");
const User = require("../models/User");

const VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;
const FLAG = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_FLAGS = 30;

async function getConfig() {
  return (await AppConfig.findOne({ key: "app" }).lean()) || { minVersion: null, minBuild: null, updateUrl: null, banner: { enabled: false }, flags: {} };
}

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
        if (typeof fallback === "boolean") {
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
  await AppConfig.updateOne({ key: "app" }, { $set: update }, { upsert: true });
  require("./plan").resetLimitsCache();
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

module.exports = { getConfig, publicConfig, saveConfig, rememberApp, resetAppCache, versionSpread };
