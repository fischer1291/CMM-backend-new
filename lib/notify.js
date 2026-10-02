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
 * - lifecycle pushes (lib/lifecycle.js) have their own switch and cap: at
 *   most LIFECYCLE_CAP in seven days, a day apart, never at night, and none
 *   within a day of a contact_available push; a `transactional` one
 *   (trial_ending) keeps the switch and the night but skips the cap
 */
const User = require("../models/User");
const PushLog = require("../models/PushLog");
const PushDecision = require("../models/PushDecision");
const { sendExpoPushes, Expo } = require("./push");
const { localParts } = require("./localTime");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAILY_SOCIAL_CAP = 10;
// Lifecycle pushes per person in LIFECYCLE_WINDOW_MS (plan 2.3, an assumption)
const LIFECYCLE_CAP = 2;
const LIFECYCLE_WINDOW_MS = 7 * 24 * HOUR;
// Minimum distance between two lifecycle pushes to one person: two stages
// due at once (a day-3 hint and a Plus ending) never arrive together
const LIFECYCLE_SPACING_MS = 24 * HOUR;
const LIFECYCLE_KEY = /^lifecycle:/;

const firstName = (name) => (name || "").trim().split(/\s+/)[0] || "Ein Kontakt";

const COME_BACK = {
  title: "Lange nicht gehört 👋",
  body: "Deine Freunde sind noch da. Schau rein, wann jemand Zeit hat, ganz ohne Eile.",
};

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
    content: ({ name, message }) => ({
      title: `${firstName(name)} würde gern mit dir sprechen 👋`,
      body: message ? `„${message}“` : "Schalte dich erreichbar, wenn es dir passt.",
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
  referral_reward: {
    pref: null,
    social: false,
    channelId: "social",
    ttlSeconds: 3 * 24 * 3600,
    content: ({ days }) => ({
      title: `${days} Tage Wanna yap+ für dich 🎁`,
      body: "Drei Leute sind über deine Einladungen dazugekommen. Danke, dass du sie mitgebracht hast!",
    }),
    url: () => "/plus",
  },
  // Two-sided invite experiment (plan 2.12, lib/referral.js rewardPair):
  // both of a pair get it after their first talk; `name` is the other one
  referral_pair_reward: {
    pref: null,
    social: false,
    channelId: "social",
    ttlSeconds: 3 * 24 * 3600,
    content: ({ days, name }) => ({
      title: `${days} Tage Wanna yap+ für euch beide 🎁`,
      body: (name || "").trim() ? `Danke für euer erstes Gespräch: du und ${firstName(name)} habt jetzt beide Plus.` : "Danke für euer erstes Gespräch: ihr habt jetzt beide Plus.",
    }),
    url: () => "/plus",
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
    content: ({ circleName, label }) => ({
      title: `${circleName}: ${label ? `${label} beginnt` : "eure Runde beginnt"} ✨`,
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
      title: "⚡ Yap Moment!",
      body: "Deine Leute haben jetzt 10 Minuten. Bist du dabei?",
    }),
    url: () => "/",
  },
  moments_waiting: {
    pref: "moments",
    social: true,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 4 * 3600,
    // Once a day at most
    throttle: () => ({ key: "moments_waiting", ms: 20 * HOUR }),
    content: ({ count }) => ({
      title: count === 1 ? "Ein Moment wartet auf dich 🔒" : `${count} Moments warten auf dich 🔒`,
      body: "Ruf heute jemanden an oder sei beim Yap Moment dabei, dann siehst du sie.",
    }),
    url: () => "/callmoments",
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
  // --- Lifecycle (lib/lifecycle.js) ----------------------------------------
  // All with pref "lifecycle", not social, never at night, under their own
  // cap (prepare). params.lifecycleKey is the stage key the job claimed.
  invite_reminder: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 12 * 3600,
    content: ({ denied }) =>
      denied
        ? {
            title: "Deine Leute finden 👋",
            body: "Ohne Zugriff aufs Adressbuch geht es auch: Schick deinen Einladungslink an die, mit denen du gern sprichst.",
          }
        : {
            title: "Wer fehlt noch? 👋",
            body: "Lade zwei, drei Leute ein, mit denen du gern sprichst. Dann siehst du, wann sie Zeit haben.",
          },
    url: () => "/contacts",
  },
  first_call_hint: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 12 * 3600,
    content: ({ name }) => ({
      title: `${firstName(name)} ist auch hier`,
      body: "Ein kurzer Anruf reicht für den Anfang. Schau, wann es euch beiden passt.",
    }),
    url: ({ phone }) => `/friend?phone=${encodeURIComponent(phone)}`,
  },
  yap_moment_invite: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "availability",
    ttlSeconds: 60 * 60,
    content: ({ time }) => ({
      title: `Heute um ${time} ist Yap Moment ⚡`,
      body: "Dann haben alle 10 Minuten Zeit füreinander. Schau rein, wenn es dir passt.",
    }),
    url: () => "/",
  },
  friends_were_available: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 12 * 3600,
    // Without a contact who was available in those days: the come_back text
    content: ({ friends }) =>
      friends
        ? { title: "Deine Leute waren erreichbar", body: "In den letzten Tagen hatten Freunde von dir Zeit zum Reden. Schau rein, wenn dir danach ist." }
        : COME_BACK,
    url: () => "/",
  },
  come_back: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 12 * 3600,
    content: () => COME_BACK,
    url: () => "/",
  },
  come_back_30: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 12 * 3600,
    content: () => ({
      title: "Deine Leute sind noch da",
      body: "Wenn du mal Lust auf ein Gespräch hast, schau rein. Von uns aus kommt danach keine Erinnerung mehr.",
    }),
    url: () => "/",
  },
  week_open: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 6 * 3600,
    content: ({ streak }) => ({
      title: "Diese Woche ist noch offen",
      body: `Du hast ${streak} Wochen nacheinander mit jemandem gesprochen. Wenn du magst, ruf heute noch jemanden an.`,
    }),
    url: () => "/",
  },
  plus_expiring: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: ({ date }) => ({
      title: "Dein Wanna yap+ endet bald",
      body: `Dein geschenktes Plus läuft am ${date} aus. Wenn du magst, kannst du es danach weiter nutzen.`,
    }),
    url: () => "/plus?from=plus_expiring",
  },
  // Two days before a free trial turns into a paid plan (plan 2.6a). Like a
  // receipt, not a reminder: `transactional` keeps it out of the lifecycle
  // cap, the spacing and the contact_available precedence (no PushLog row
  // "lifecycle:..."), so nobody misses it because of a tip that came first;
  // the switch (pref lifecycle) and the quiet hours still hold. `when` is
  // "morgen", "übermorgen" or "am <date>" (lib/lifecycle.js).
  trial_ending: {
    pref: "lifecycle",
    lifecycle: true,
    transactional: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: ({ when }) => ({
      title: `Deine Probezeit endet ${when || "bald"}`,
      body: "Danach läuft Plus zum Preis aus dem App Store weiter. Kündigen geht jederzeit in den iPhone-Einstellungen.",
    }),
    url: () => "/plus?from=trial_ending",
  },
  // The app opens only its own routes (CMM services/notifications.ts
  // safeRoute), so the way to Apple's billing page is in the text
  billing_issue: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: () => ({
      title: "Deine Zahlung hat nicht geklappt",
      body: "Apple konnte Wanna yap+ nicht abbuchen. Schau in den Einstellungen deiner Apple-ID nach der Zahlungsmethode, dann läuft alles weiter.",
    }),
    url: () => "/plus?from=billing_issue",
  },
  plus_winback_3: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: () => ({
      title: "Dein Wanna yap+ ist abgelaufen",
      body: "Falls du es vermisst: Du kannst es jederzeit wieder aktivieren. Ganz wie du magst.",
    }),
    url: () => "/plus?from=plus_winback_3",
  },
  plus_winback_30: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 24 * 3600,
    content: () => ({
      title: "Lust auf Wanna yap+?",
      body: "Seit einem Monat ohne Plus. Wenn du magst, schau dir an, was es gerade gibt.",
    }),
    url: () => "/plus?from=plus_winback_30",
  },
  cancel_survey: {
    pref: "lifecycle",
    lifecycle: true,
    social: false,
    skipAtNight: true,
    channelId: "social",
    ttlSeconds: 3 * 24 * 3600,
    content: () => ({
      title: "Eine kurze Frage zu Wanna yap+",
      body: "Du hast dein Abo gekündigt. Magst du uns in einem Satz sagen, warum? Das hilft uns sehr.",
    }),
    url: () => "/plus?from=cancel",
  },
  // A sign-in from a device the account did not know (plan 2.9,
  // routes/verify.js): to the push token of the other device, before the
  // new one is stored. No switch (a security notice), not social, silent at
  // night like missed_call. `model` may be missing (older apps).
  new_device: {
    pref: null,
    social: false,
    channelId: "social",
    ttlSeconds: 3 * 24 * 3600,
    content: ({ model }) => ({
      title: "Neue Anmeldung",
      body: `Gerade hat sich ein Gerät${model ? ` (${model})` : ""} mit deiner Nummer angemeldet. Warst du das nicht? In den Einstellungen kannst du dich überall abmelden.`,
    }),
    url: () => "/settings",
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
    // The call list: who, when, and call back from there
    url: () => "/calls",
  },
};

const LIFECYCLE_TYPES = Object.keys(CATALOG).filter((type) => CATALOG[type].lifecycle);

/**
 * Why no lifecycle push may go to `phone` now, or null: a contact_available
 * push in the last 24 hours (it has precedence: a friend who is free right
 * now beats any reminder), LIFECYCLE_CAP lifecycle pushes in the last seven
 * days (PushLog rows "lifecycle:<stage>", which live seven days), or one in
 * the last LIFECYCLE_SPACING_MS (also within the same tick: the row of the
 * first push exists before the next stage is tried).
 * Two instances deciding at the same moment could exceed the cap by one;
 * the leader lease makes that a deploy-overlap corner case.
 */
async function lifecycleHold(phone, now = new Date()) {
  const recentAvailable = await PushDecision.exists({ to: phone, type: "contact_available", result: "sent", at: { $gt: new Date(now - 24 * HOUR) } });
  if (recentAvailable) return "contact_available_first";
  const recent = await PushLog.find({ to: phone, key: LIFECYCLE_KEY, sentAt: { $gt: new Date(now - LIFECYCLE_WINDOW_MS) } }, { sentAt: 1 }).lean();
  if (recent.length >= LIFECYCLE_CAP) return "lifecycle_cap";
  return recent.some((row) => row.sentAt > new Date(now - LIFECYCLE_SPACING_MS)) ? "lifecycle_spacing" : null;
}

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

  // Transactional lifecycle types (trial_ending) are neither held nor counted
  if (spec.lifecycle && !spec.transactional) {
    const held = await lifecycleHold(user.phone, now);
    if (held) return { skipped: held };
    try {
      await PushLog.create({
        to: user.phone,
        key: `lifecycle:${params.lifecycleKey || type}`,
        sentAt: now,
        expiresAt: new Date(now.getTime() + LIFECYCLE_WINDOW_MS),
      });
    } catch (err) {
      // The same stage within seven days: already sent
      if (err.code === 11000) return { skipped: "throttled" };
      throw err;
    }
  }

  if (spec.social) {
    // Lifecycle rows have their own cap and do not use up the social one
    const today = await PushLog.countDocuments({ to: user.phone, key: { $not: LIFECYCLE_KEY }, sentAt: { $gt: new Date(now - 24 * HOUR) } });
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

/**
 * Send one catalog push to each recipient (User docs or phones). Returns
 * per-recipient results: { phone, sent: true, failed? } or { skipped }.
 */
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
      // The caller learns it too (lib/lifecycle.js gives a stage back);
      // no ticket at all means Expo was not reachable
      if (failed) r.failed = ticket ? ticket.details?.error || ticket.message || "error" : "no_ticket";
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

module.exports = { notify, notifyMany, isQuiet, setForegroundLookup, lifecycleHold, CATALOG, DAILY_SOCIAL_CAP, LIFECYCLE_CAP, LIFECYCLE_SPACING_MS, LIFECYCLE_TYPES };
