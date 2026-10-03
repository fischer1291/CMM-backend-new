/**
 * Outage banner from alerts (plan 2.15): people should learn about an
 * outage from a calm line at the top of the app (and on wannayap.app, which
 * reads the same GET /app-config), not from an error dialog. An alert rule
 * in lib/alerts.js with `userFacing: { text }` calls syncBanner on every
 * run: while it fires, AppConfig.banner is switched on with that text and
 * source "alert:<tag>"; once the rule reads null again, the banner is
 * switched off, but only while that source is still on it.
 *
 * A banner set by hand always wins: an automatic banner only takes a banner
 * that is off or expired, and is never written over one the owner set or
 * changed (lib/appConfig.js saveConfig sets source null). Both steps are a
 * single conditional update on banner.source, so a console save in between
 * can't be lost. Each change goes out as the socket event appConfig with the
 * public config, as PUT /admin/config does; app.js hands over io.
 *
 * banner.muted lists the sources the owner silenced by taking an automatic
 * banner over or switching it off (with every rule of the same text, so
 * push_failures doesn't bring back what push_credentials' banner said).
 * Switching a banner on never clears it; releaseMutes() drops a source once
 * no rule of its text fires any more (lib/alerts.js applyBanners).
 */
const AppConfig = require("../models/AppConfig");

let io = null;
/** The Socket.IO server the change goes out over (app.js createApp). */
const setIo = (server) => {
  io = server;
};

const PREFIX = "alert:";
const sourceOf = (tag) => `${PREFIX}${tag}`;
/** The tag of an automatic banner's source, or null for one set by hand. */
const tagOf = (source) => (typeof source === "string" && source.startsWith(PREFIX) ? source.slice(PREFIX.length) : null);

// Off: muted stays, it outlives the banner it silenced
const OFF = { "banner.enabled": false, "banner.text": "", "banner.level": "info", "banner.until": null, "banner.source": null };

/** Whether `banner` (as stored) shows right now. */
const isActive = (banner, now = new Date()) => !!(banner?.enabled && banner.text && (!banner.until || new Date(banner.until) > now));

async function broadcast() {
  if (!io) return;
  try {
    io.emit("appConfig", await require("./appConfig").publicConfig());
  } catch (err) {
    console.error("❌ banner broadcast:", err.message);
  }
}

/**
 * Switch the automatic banner of `tag` on (firing, with `text`) or off.
 * Returns true when the banner changed (and the change went out).
 */
async function syncBanner(tag, firing, { text, now = new Date() } = {}) {
  const source = sourceOf(tag);
  let res;
  if (firing) {
    const line = String(text || "").trim().slice(0, 200);
    if (!line) throw new Error(`statusBanner: no text for ${tag}`);
    // The config document may not exist yet on a fresh database
    await AppConfig.updateOne({ key: "app" }, { $setOnInsert: { updatedAt: now } }, { upsert: true });
    res = await AppConfig.updateOne(
      {
        key: "app",
        "banner.muted": { $ne: source },
        // Off, without text, expired, or already ours: never a banner that shows by hand
        $or: [{ "banner.enabled": { $ne: true } }, { "banner.text": { $in: ["", null] } }, { "banner.until": { $lte: now } }, { "banner.source": source }],
      },
      { $set: { "banner.enabled": true, "banner.text": line, "banner.level": "warning", "banner.until": null, "banner.source": source } },
    );
  } else {
    res = await AppConfig.updateOne({ key: "app", "banner.source": source }, { $set: OFF });
  }
  if (!res.modifiedCount) return false;
  console.log(firing ? `📣 Störungs-Banner an (Alarm ${tag})` : `📣 Störungs-Banner aus (Alarm ${tag} vorbei)`);
  await broadcast();
  return true;
}

/**
 * The outage the owner silenced is over: drop every muted source not in
 * `keep` (the sources whose rules, or rules of the same text, still fire),
 * so the next outage may switch the banner on again.
 */
async function releaseMutes(keep = []) {
  const res = await AppConfig.updateOne({ key: "app", "banner.muted.0": { $exists: true } }, { $pull: { "banner.muted": { $nin: keep } } });
  return res.modifiedCount > 0;
}

/** Whether two banners (as stored or as the console sends them) show the same. */
const sameBanner = (a = {}, b = {}) =>
  !!a?.enabled === !!b?.enabled && (a?.text || "") === (b?.text || "") && (a?.level || "info") === (b?.level || "info") && +new Date(a?.until || 0) === +new Date(b?.until || 0);

/** The text of the automatic banner showing right now, or null (none, or one set by hand). */
async function activeOutage(now = new Date()) {
  const c = await AppConfig.findOne({ key: "app" }, { banner: 1 }).lean();
  return isActive(c?.banner, now) && tagOf(c.banner.source) ? { tag: tagOf(c.banner.source), text: c.banner.text } : null;
}

module.exports = { setIo, syncBanner, releaseMutes, activeOutage, sameBanner, sourceOf, tagOf, isActive, PREFIX };
