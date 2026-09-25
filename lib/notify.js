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
const PushDecision = require("../models/PushDecision");
const { sendExpoPushes, Expo } = require("./push");
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
    urgent: true,
    // The open app shows a live banner instead (socket), see skipIfInApp
    skipIfInApp: true,
    // Only against rapid on/off/on; pushes happen only on a real switch anyway
    throttle: ({ phone }) => ({ key: `available:${phone}`, ms: 2 * MINUTE }),
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
    urgent: true,
    skipIfInApp: true,
    ttlSeconds: 20 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} würde gern mit dir sprechen 👋`,
      body: "Schalte dich erreichbar, wenn es dir passt.",
    }),
    url: () => "/",
  },
  contact_joined: {
    pref: null,
    social: true,
    channelId: "social",
    ttlSeconds: 3 * 24 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} ist jetzt dabei 🎉`,
      body: "Deine Einladung hat geklappt. Sag doch mal Hallo!",
    }),
    url: ({ phone }) => `/friend?phone=${encodeURIComponent(phone)}`,
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
  circle_invite: {
    pref: null,
    social: true,
    channelId: "social",
    ttlSeconds: 7 * 24 * 3600,
    content: ({ name, circleName }) => ({
      title: `${firstName(name)} lädt dich in ${circleName} ein`,
      body: "Tritt bei, dann seht ihr, wann ihr Zeit füreinander habt.",
    }),
    url: () => "/",
  },
  support_reply: {
    pref: null,
    social: false,
    channelId: "social",
    ttlSeconds: 7 * 24 * 3600,
    content: () => ({
      title: "Antwort vom Support",
      body: "Wir haben auf deine Nachricht geantwortet.",
    }),
    url: () => "/support",
  },
  room_open: {
    pref: "available",
    social: true,
    urgent: true,
    skipIfInApp: true,
    channelId: "availability",
    ttlSeconds: 30 * 60,
    throttle: ({ circleId }) => ({ key: `room:${circleId}`, ms: 30 * MINUTE }),
    content: ({ name, circleName }) => ({
      title: `${circleName}: Runde ist offen 🎙️`,
      body: `${firstName(name)} ist drin. Spring rein, wenn du magst.`,
    }),
    url: ({ circleId }) => `/circle?id=${circleId}`,
  },
  circle_ritual: {
    pref: null,
    social: false,
    skipAtNight: true,
    channelId: "availability",
    ttlSeconds: 60 * 60,
    content: ({ circleName }) => ({
      title: `${circleName}: eure Runde beginnt ✨`,
      body: "Euer fester Termin ist jetzt. Der Raum ist offen.",
    }),
    url: ({ circleId }) => `/circle?id=${circleId}`,
  },
  daily_moment: {
    pref: "dailyMoment",
    social: false,
    skipAtNight: true,
    channelId: "availability",
    categoryId: "daily_moment",
    ttlSeconds: 10 * 60,
    content: () => ({
      title: "⚡ Call Me Moment!",
      body: "Deine Leute haben jetzt 10 Minuten. Bist du dabei?",
    }),
    url: () => "/",
  },
  moment_consent: {
    pref: "moments",
    social: true,
    urgent: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} möchte einen Moment teilen ✨`,
      body: "Ein Bild aus eurem Gespräch. Schau es dir an und entscheide, ob es geteilt wird.",
    }),
    url: () => "/callmoments",
  },
  moment_approved: {
    pref: "moments",
    social: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} hat euren Moment freigegeben ✨`,
      body: "Eure Kontakte sehen ihn jetzt 24 Stunden lang.",
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

/**
 * App state per phone: Map phone -> "foreground" | "background"; phones
 * without a connected app are missing ("closed"). Wired to Socket.IO in
 * app.js (clients report "presence").
 */
let appStates = async () => new Map();
function setForegroundLookup(fn) {
  appStates = fn;
}

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
async function prepare(user, type, params, now = new Date(), inApp = false) {
  const spec = CATALOG[type];
  if (!spec) throw new Error(`Unknown push type ${type}`);
  if (!user?.pushToken) return { skipped: "no_token" };
  // Checked before throttling: a banner in the open app must not use it up
  if (spec.skipIfInApp && inApp) return { skipped: "in_app" };
  if (spec.pref && user.notificationPrefs?.[spec.pref] === false) return { skipped: "opted_out" };

  const quiet = isQuiet(user, now);
  if (quiet && (spec.social || spec.skipAtNight)) return { skipped: "quiet_hours" };

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
      // Timely types go out right away, the rest may be batched by the OS
      priority: spec.social && !spec.urgent ? "default" : "high",
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
  const states = await appStates(users.filter(Boolean).map((u) => u.phone)).catch(() => new Map());
  const appOf = (phone) => states.get(phone) || "closed";
  for (const user of users) {
    if (!user) {
      results.push({ skipped: "no_user" });
      continue;
    }
    const inApp = CATALOG[type].skipIfInApp && appOf(user.phone) === "foreground";
    const prepared = await prepare(user, type, params, now, inApp);
    results.push({ phone: user.phone, ...(prepared.skipped ? { skipped: prepared.skipped } : { sent: true }) });
    if (prepared.message) messages.push(prepared.message);
  }

  // Tickets come back in the order of the valid messages
  const ticketOf = new Map();
  if (messages.length) {
    const tickets = await sendExpoPushes(messages);
    messages.filter((m) => Expo.isExpoPushToken(m.to)).forEach((m, i) => ticketOf.set(m.to, tickets[i]));
  }

  const decisions = results
    .filter((r) => r.phone)
    .map((r) => {
      const user = users.find((u) => u?.phone === r.phone);
      const ticket = r.sent ? ticketOf.get(user.pushToken) : null;
      const failed = r.sent && ticket?.status !== "ok";
      return {
        to: r.phone,
        type,
        about: params.phone,
        result: r.sent ? (failed ? "failed" : "sent") : r.skipped,
        app: appOf(r.phone),
        ticketId: ticket?.id,
        delivery: failed ? ticket?.details?.error || ticket?.message || "error" : undefined,
        at: now,
      };
    });
  if (decisions.length) await PushDecision.insertMany(decisions).catch(() => {});
  return results;
}

const notify = async (recipient, type, params, options) => (await notifyMany([recipient], type, params, options))[0];

module.exports = { notify, notifyMany, isQuiet, setForegroundLookup, CATALOG, DAILY_SOCIAL_CAP };
