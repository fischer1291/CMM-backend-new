/**
 * All user-facing pushes (except the call itself, see lib/push.js) go
 * through this catalog. Each type defines its text, deep link, Android
 * channel, iOS category, lifetime and how it behaves at night:
 *
 * - the user can switch each social type off (notificationPrefs)
 * - quiet hours in the recipient's time zone: social pushes are skipped,
 *   missed calls arrive silently
 * - throttling per recipient and topic (PushLog), plus a daily cap on
 *   social pushes, so nobody gets flooded
 * - short TTLs: "Anna is available" is useless an hour later
 */
const User = require("../models/User");
const PushLog = require("../models/PushLog");
const { sendExpoPushes } = require("./push");
const { localParts } = require("./localTime");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAILY_SOCIAL_CAP = 10;

const firstName = (name) => (name || "").trim().split(/\s+/)[0] || "Ein Kontakt";

const CATALOG = {
  contact_available: {
    pref: "available",
    social: true,
    channelId: "availability",
    categoryId: "contact_available",
    ttlSeconds: 15 * 60,
    throttle: ({ phone }) => ({ key: `available:${phone}`, ms: 3 * HOUR }),
    content: ({ name }) => ({
      title: `${firstName(name)} ist erreichbar`,
      body: "Jetzt ist ein guter Moment für einen Anruf.",
    }),
    url: ({ phone }) => `/friend?phone=${encodeURIComponent(phone)}`,
  },
  nudge: {
    pref: "nudges",
    social: true,
    channelId: "social",
    categoryId: "nudge",
    ttlSeconds: 20 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} würde gern mit dir sprechen 👋`,
      body: "Schalte dich erreichbar, wenn es dir passt.",
    }),
    url: () => "/",
  },
  moment_shared: {
    pref: "moments",
    social: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    throttle: ({ phone }) => ({ key: `moment:${phone}`, ms: HOUR }),
    content: ({ name }) => ({
      title: `${firstName(name)} hat einen Moment geteilt ✨`,
      body: "Ein Bild aus eurem Gespräch. Schau es dir an.",
    }),
    url: () => "/callmoments",
  },
  missed_call: {
    pref: null, // always, but silent at night
    social: false,
    channelId: "missed-calls",
    categoryId: "missed_call",
    ttlSeconds: 24 * 3600,
    content: ({ name }) => ({
      title: "Verpasster Anruf",
      body: `${firstName(name)} hat versucht, dich zu erreichen.`,
    }),
    url: ({ phone }) => `/friend?phone=${encodeURIComponent(phone)}`,
  },
};

const DEFAULT_QUIET = { enabled: true, start: 22 * 60, end: 8 * 60 };

function isQuiet(user, now = new Date()) {
  const stored = user.notificationPrefs?.quietHours;
  const quiet = {
    enabled: stored?.enabled ?? DEFAULT_QUIET.enabled,
    start: stored?.start ?? DEFAULT_QUIET.start,
    end: stored?.end ?? DEFAULT_QUIET.end,
  };
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const { minutes } = localParts(now, user.timezone || user.schedule?.timezone);
  return quiet.start < quiet.end
    ? minutes >= quiet.start && minutes < quiet.end
    : minutes >= quiet.start || minutes < quiet.end; // over midnight
}

/**
 * The Expo message for `user`, or { skipped: reason }. Records throttling,
 * so only call it when the message will actually be sent.
 * `params`: { phone, name } of the person the push is about.
 */
async function prepare(user, type, params, now = new Date()) {
  const spec = CATALOG[type];
  if (!spec) throw new Error(`Unknown push type ${type}`);
  if (!user?.pushToken) return { skipped: "no_token" };
  if (spec.pref && user.notificationPrefs?.[spec.pref] === false) return { skipped: "opted_out" };

  const quiet = isQuiet(user, now);
  if (quiet && spec.social) return { skipped: "quiet_hours" };

  if (spec.social) {
    const today = await PushLog.countDocuments({ to: user.phone, sentAt: { $gt: new Date(now - 24 * HOUR) } });
    if (today >= DAILY_SOCIAL_CAP) return { skipped: "daily_cap" };

    const throttle = spec.throttle?.(params);
    try {
      await PushLog.create({
        to: user.phone,
        key: throttle?.key ?? `${type}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
        sentAt: now,
        expiresAt: new Date(now.getTime() + (throttle?.ms ?? 24 * HOUR)),
      });
    } catch (err) {
      if (err.code === 11000) return { skipped: "throttled" };
      throw err;
    }
  }

  const { title, body } = spec.content(params);
  return {
    message: {
      to: user.pushToken,
      title,
      body,
      sound: quiet ? undefined : "default",
      data: { type, phone: params.phone, url: spec.url(params) },
      channelId: spec.channelId,
      categoryId: spec.categoryId,
      ttl: spec.ttlSeconds,
      priority: spec.social ? "default" : "high",
      interruptionLevel: quiet ? "passive" : "active",
    },
  };
}

/** Send one catalog push to each recipient (User docs or phones). Returns per-recipient results. */
async function notifyMany(recipients, type, params, { now = new Date() } = {}) {
  const users = await Promise.all(
    recipients.map((r) => (typeof r === "string" ? User.findOne({ phone: r }) : r)),
  );
  const results = [];
  const messages = [];
  for (const user of users) {
    if (!user) {
      results.push({ skipped: "no_user" });
      continue;
    }
    const prepared = await prepare(user, type, params, now);
    results.push({ phone: user.phone, ...(prepared.skipped ? { skipped: prepared.skipped } : { sent: true }) });
    if (prepared.message) messages.push(prepared.message);
  }
  if (messages.length) await sendExpoPushes(messages);
  return results;
}

const notify = async (recipient, type, params, options) => (await notifyMany([recipient], type, params, options))[0];

module.exports = { notify, notifyMany, isQuiet, CATALOG, DAILY_SOCIAL_CAP };
