/**
 * Alerts: every disturbance reaches the owner by push first, not by ticket
 * (plan 1.10). alert(tag, text) goes out at most once an hour per tag, and
 * while the text stays the same only once a day (most rules look at a whole
 * day's counters, so an unchanged state must not page the owner every hour),
 * over the console's "alerts" push (lib/adminPush.js), as a mail to every
 * owner (lib/mailer.js) and, for level "error", as an SMS to
 * AppConfig.ops.alertPhone (lib/twilio.js). The debounce is a document per
 * tag (models/AlertState.js), so a new leader after a deploy doesn't send the
 * same alarm again. runRules(now) checks RULES and alerts on every hit;
 * index.js runs it as a leader job every 30 minutes after the metrics
 * snapshots. Some tags are raised outside RULES, where the event happens:
 * pepper_changed (lib/pseudonyms.js), sentry_fatal (routes/webhooks.js). The
 * table of tags and what to do is in the README ("Alerts") and
 * CMM/docs/RUNBOOK.md.
 */
const AlertState = require("../models/AlertState");
const Admin = require("../models/Admin");
const PushDecision = require("../models/PushDecision");
const DailyMoment = require("../models/DailyMoment");
const ClientError = require("../models/ClientError");
const AdDraft = require("../models/AdDraft");
const MarketingChannel = require("../models/MarketingChannel");
const MetricsDaily = require("../models/MetricsDaily");
const adminPush = require("./adminPush");
const mailer = require("./mailer");
const { sendSms, smsConfigured } = require("./twilio");
const opsCounters = require("./opsCounters");
const { failuresOf } = require("./paywall");
const { lastTickAt } = require("./leader");
const { overdueTickets } = require("./today");
const { getConfig } = require("./appConfig");
const { localParts, shiftDateKey } = require("./localTime");
const { MAX_TICK_AGE_MS, STARTUP_GRACE_SEC } = require("./health");

const ZONE = "Europe/Berlin";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Same tag at most once per hour, with an unchanged text once a day
const COOLDOWN_MS = HOUR;
const REPEAT_MS = DAY;
const nf = new Intl.NumberFormat("de-DE");
const pct = (part, whole) => Math.round((100 * part) / whole);
const fmt = (d) => new Intl.DateTimeFormat("de-DE", { timeZone: ZONE, dateStyle: "short", timeStyle: "short" }).format(d);

/**
 * Send one alert unless the same tag went out within the last hour, or with
 * the same text within the last day. Returns true when it was sent. The
 * check and the booking are one conditional upsert (as lib/leader.js
 * holdLease): two leaders can't both send it.
 */
async function alert(tag, text, { level = "warn", title, now = new Date() } = {}) {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(tag)) throw new Error(`alerts: invalid tag "${tag}"`);
  try {
    await AlertState.updateOne(
      {
        tag,
        $or: [
          { lastAt: { $exists: false } },
          { lastAt: { $lt: new Date(now.getTime() - REPEAT_MS) } },
          { lastAt: { $lt: new Date(now.getTime() - COOLDOWN_MS) }, lastText: { $ne: text } },
        ],
      },
      { $set: { lastAt: now, lastText: text, level }, $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (err) {
    // Within the hour, or the same text within the day: the upsert ran into the unique tag
    if (err.code === 11000) return false;
    throw err;
  }
  const heading = title || `Alarm: ${tag}`;
  const urgency = level === "error" ? "high" : "normal";
  try {
    await adminPush.notify("alerts", { title: heading, body: text, url: "#dashboard", tag: `alert-${tag}`, urgency });
  } catch (err) {
    console.error("❌ alert push:", err.message);
  }
  if (mailer.configured()) {
    const owners = await Admin.find({ role: "owner", totpEnabled: true, active: { $ne: false } }, { email: 1 }).lean();
    for (const owner of owners) {
      try {
        await mailer.sendMail({ to: owner.email, subject: `[Wanna yap?] ${heading}`, text: `${text}\n\nTag: ${tag} · Stufe: ${level} · ${fmt(now)}\nWas zu tun ist: docs/RUNBOOK.md, Abschnitt Alarme, im App-Repo.` });
      } catch (err) {
        console.error("❌ alert mail:", err.reason || err.message);
      }
    }
  }
  if (level === "error") {
    const { alertPhone } = (await getConfig()).ops;
    if (alertPhone && smsConfigured()) {
      try {
        await sendSms(alertPhone, `Wanna yap? ${heading}: ${text}`);
      } catch (err) {
        console.error("❌ alert sms:", err.message);
      }
    }
  }
  console.error(`🚨 alert ${tag} (${level}): ${text}`);
  return true;
}

// --- Rules ----------------------------------------------------------------------
// Each returns the alert text when it fires, otherwise null. Only data that
// exists today; thresholds are the plan's. `uptimeSec` is injectable for tests.

const todayKey = (now) => localParts(now, ZONE).dateKey;

const RULES = [
  {
    tag: "sms_failures",
    level: "error",
    title: "Anmelde-SMS schlagen fehl",
    async check(now) {
      const c = await opsCounters.countsOf(todayKey(now));
      const started = c.smsStarted || 0;
      const failed = c.smsFailed || 0;
      if (started < 5 || failed / started <= 0.2) return null;
      return `Heute ${failed} von ${started} Anmelde-SMS von Twilio abgelehnt (${pct(failed, started)} %).`;
    },
  },
  {
    tag: "push_failures",
    level: "warn",
    title: "Pushes kommen nicht an",
    async check(now) {
      // Only pushes we tried to send count: skips (prefs, quiet hours, cap) are no failures
      const rows = await PushDecision.find({ at: { $gte: new Date(now.getTime() - HOUR) }, result: { $in: ["sent", "failed"] } }, { result: 1, delivery: 1 }).lean();
      if (rows.length < 20) return null;
      const failed = rows.filter((r) => r.result === "failed" || (r.delivery && r.delivery !== "delivered")).length;
      if (failed / rows.length <= 0.1) return null;
      return `In der letzten Stunde sind ${failed} von ${rows.length} Pushes fehlgeschlagen (${pct(failed, rows.length)} %).`;
    },
  },
  {
    tag: "push_credentials",
    level: "error",
    title: "Push-Zugangsdaten abgelehnt",
    async check(now) {
      const n = (await opsCounters.countsOf(todayKey(now))).pushCredentialErrors || 0;
      return n > 0 ? `Apple oder Expo haben heute ${n}× unsere Push-Zugangsdaten abgelehnt (InvalidProviderToken, TopicDisallowed o. ä.). Niemand bekommt Pushes, bis der Schlüssel stimmt.` : null;
    },
  },
  {
    tag: "tick_late",
    level: "error",
    title: "Hintergrundjobs stehen",
    async check(now, { uptimeSec = process.uptime() } = {}) {
      // Right after a start (or a longer outage) the tick hasn't run yet; the
      // same grace /healthz gives itself
      if (uptimeSec < STARTUP_GRACE_SEC) return null;
      // The tick's own stamp: the other jobs under the lock (snapshots, the
      // waitlist batch every 15 s) keep lastRunAt fresh even while the tick fails
      const last = await lastTickAt("jobs");
      // No stamp at all after the grace: no job has ever finished on this leader
      if (!last) return `Seit dem Start vor ${Math.round(uptimeSec / 60)} Minuten hat kein Hintergrundjob abgeschlossen. Zeitpläne, Yap Moment und Rituale laufen nicht.`;
      if (now - last <= MAX_TICK_AGE_MS) return null;
      return `Der Minutentick lief zuletzt ${fmt(last)} (vor ${Math.round((now - last) / 60000)} Minuten). Zeitpläne, Yap Moment und Rituale laufen nicht.`;
    },
  },
  {
    tag: "moment_missing",
    level: "warn",
    title: "Yap Moment blieb aus",
    async check(now) {
      const { dateKey, minutes } = localParts(now, ZONE);
      if (minutes < 21 * 60 + 30) return null;
      const moment = await DailyMoment.findOne({ day: dateKey, zone: ZONE }, { sentAt: 1, at: 1 }).lean();
      if (!moment || moment.sentAt) return null;
      return `Der Yap Moment für Europe/Berlin (geplant ${fmt(moment.at)}) wurde heute nicht gesendet.`;
    },
  },
  {
    tag: "client_errors",
    level: "warn",
    title: "App-Fehler häufen sich",
    async check(now) {
      // An hour back, although the rules run every 30 minutes: the snapshots
      // before them take a while, and the debounce keeps it from doubling
      // Never the message itself: POST /diagnostics/errors is public, so its
      // text must not reach the owner's lock screen or inbox; the key is enough
      // to find it in the console
      const fresh = await ClientError.findOne({ fatal: true, firstAt: { $gte: new Date(now.getTime() - HOUR) } }, { key: 1, count: 1, platform: 1, firstAt: 1 }).lean();
      if (fresh) return `Neuer fataler App-Fehler (Schlüssel ${fresh.key.slice(0, 8)}, ${fresh.count}×${fresh.platform ? `, ${fresh.platform}` : ""}) seit ${fmt(fresh.firstAt)} (Konsole → Fehler).`;
      const [today, yesterday] = await Promise.all([opsCounters.countsOf(todayKey(now)), opsCounters.countsOf(shiftDateKey(todayKey(now), -1))]);
      const t = today.clientErrors || 0;
      const y = yesterday.clientErrors || 0;
      if (t < 10 || t <= 3 * y) return null;
      return `Heute ${t} gemeldete App-Fehler, gestern ${y} (Konsole → Fehler).`;
    },
  },
  {
    tag: "revenuecat",
    level: "error",
    title: "RevenueCat-Webhook hakt",
    async check(now) {
      const c = await opsCounters.countsOf(todayKey(now));
      const unknown = c.rcUnknownUser || 0;
      const unauthorized = c.rcUnauthorized || 0;
      if (!unknown && !unauthorized) return null;
      const parts = [];
      if (unauthorized) parts.push(`${unauthorized}× abgelehnt (Secret stimmt nicht)`);
      if (unknown) parts.push(`${unknown}× unbekannter Nutzer`);
      return `RevenueCat heute: ${parts.join(", ")}. Zahlende Kunden könnten ohne Plus dastehen.`;
    },
  },
  {
    tag: "purchase_failures",
    level: "warn",
    title: "Käufe in der App schlagen fehl",
    async check(now) {
      // The paywall's failure steps of today (POST /me/plus/funnel, lib/paywall.js);
      // a cancelled purchase is the person's choice and no failure
      const f = failuresOf(await opsCounters.countsOf(todayKey(now)));
      if (f.purchaseError + f.restoreError + f.offeringEmpty <= 3) return null;
      return `Heute ${f.purchaseError}× Kauf fehlgeschlagen, ${f.restoreError}× Wiederherstellen fehlgeschlagen, ${f.offeringEmpty}× kein Angebot geladen. Konsole → Plus, App Store Connect-Status und RevenueCat prüfen.`;
    },
  },
  {
    tag: "agent_silent",
    level: "warn",
    title: "Marketing-Agent schweigt",
    async check(now) {
      const last = await AdDraft.findOne({}, { createdAt: 1 }).sort({ createdAt: -1 }).lean();
      if (!last || now - last.createdAt <= 36 * HOUR) return null;
      return `Der letzte Werbe-Entwurf kam ${fmt(last.createdAt)}. GitHub pausiert den Cron nach 60 Tagen ohne Commit (Actions → marketing-agent → enable).`;
    },
  },
  {
    tag: "support_overdue",
    level: "warn",
    title: "Support-Ticket wartet seit über 24 h",
    async check(now) {
      // The same definition the morning push counts (lib/today.js)
      const overdue = await overdueTickets(now);
      if (!overdue.length) return null;
      return `${overdue.length} ${overdue.length === 1 ? "Ticket wartet" : "Tickets warten"} seit über 24 Stunden auf eine Antwort (Konsole → Support).`;
    },
  },
  {
    tag: "social_token",
    level: "warn",
    title: "Social-Token läuft ab",
    async check(now) {
      const channels = await MarketingChannel.find({ accessToken: { $ne: null } }).lean();
      const soon = channels.filter((c) => {
        // TikTok's access token is renewed hourly; its refresh token is the one that ends
        const until = c.refreshExpiresAt || c.expiresAt;
        return until && until - now < 7 * DAY;
      });
      if (!soon.length) return null;
      return soon.map((c) => `${c._id === "tiktok" ? "TikTok" : "Instagram"} bis ${fmt(c.refreshExpiresAt || c.expiresAt)}`).join(", ") + ". In der Konsole (Freigabe → Kanäle) neu verbinden.";
    },
  },
  {
    tag: "no_talks",
    level: "error",
    title: "Gestern kein einziges Gespräch",
    async check(now) {
      const y = await MetricsDaily.findOne({ day: shiftDateKey(todayKey(now), -1) }, { users: 1, talks: 1 }).lean();
      if (!y || (y.users?.dau || 0) <= 20 || (y.talks?.count || 0) !== 0) return null;
      return `Gestern waren ${nf.format(y.users.dau)} Leute aktiv, aber kein Gespräch kam zustande. Anrufzustellung (VoIP, Agora) prüfen.`;
    },
  },
  {
    tag: "backup_stale",
    level: "warn",
    title: "Letztes Backup ist alt",
    async check(now) {
      const { lastBackupAt } = (await getConfig()).ops;
      if (!lastBackupAt || now - new Date(lastBackupAt) <= 8 * DAY) return null;
      return `Der letzte Datenbank-Dump meldete sich ${fmt(new Date(lastBackupAt))}. GitHub → Actions → DB-Backup prüfen (pausiert nach 60 Tagen ohne Commit).`;
    },
  },
  {
    tag: "sms_cap",
    level: "warn",
    title: "SMS-Deckel fast erreicht",
    async check(now) {
      const [c, config] = await Promise.all([opsCounters.countsOf(todayKey(now)), getConfig()]);
      const started = c.smsStarted || 0;
      const cap = config.ops.smsPerDay;
      if (started < 0.8 * cap) return null;
      return `Heute ${started} von ${cap} Anmelde-SMS verschickt (${pct(started, cap)} %). Bei echtem Andrang Deckel erhöhen (Konsole → App → Betrieb), sonst SMS-Pumping vermuten.`;
    },
  },
  {
    tag: "gift_days",
    level: "warn",
    title: "Geschenk-Plus über dem Wochenbudget",
    async check(now) {
      // Today and the six days before: the day counters of lib/referral.js countGiftDays
      const today = todayKey(now);
      const days = await Promise.all(Array.from({ length: 7 }, (_, i) => opsCounters.countsOf(shiftDateKey(today, -i))));
      const by = (source) => days.reduce((sum, c) => sum + (c[`giftDays_${source}`] || 0), 0);
      const referral = by("referral");
      const waitlist = by("waitlist");
      const admin = by("admin");
      const total = referral + waitlist + admin;
      const budget = (await getConfig()).goals.giftDaysPerWeek;
      if (total <= budget) return null;
      return `In den letzten 7 Tagen ${nf.format(total)} Plus-Tage verschenkt (Einladungen ${nf.format(referral)}, Warteliste ${nf.format(waitlist)}, Konsole ${nf.format(admin)}), Budget ${nf.format(budget)} je Woche. Ansehen und Budget anpassen: Konsole → App → Ziele.`;
    },
  },
  {
    tag: "review_login",
    level: "warn",
    title: "Demo-Zugang für App Review",
    async check(now) {
      // The App Store review login signs in without SMS (routes/verify.js):
      // it should only exist while a review runs. Required lazily, the
      // route module pulls in Twilio and the invite code
      const { reviewLoginStatus, reviewUntil } = require("../routes/verify");
      const status = reviewLoginStatus(now);
      if (status === "on" && !reviewUntil()) return "Demo-Zugang ohne Ablaufdatum aktiv: REVIEW_UNTIL (JJJJ-MM-TT, letzter Tag) auf Render setzen oder REVIEW_PHONE und REVIEW_CODE entfernen.";
      if (status === "expired" && (process.env.REVIEW_PHONE || process.env.REVIEW_CODE)) return `Demo-Zugang abgelaufen: REVIEW_PHONE und REVIEW_CODE auf Render entfernen (REVIEW_UNTIL war ${reviewUntil()}).`;
      if (status === "invalid_until") return "REVIEW_UNTIL ist kein Datum (JJJJ-MM-TT), der Demo-Zugang ist deshalb aus. Auf Render korrigieren oder alle REVIEW_-Variablen entfernen.";
      return null;
    },
  },
];

/** Check every rule; returns the tags that were alerted (not the debounced ones). */
async function runRules(now = new Date(), { uptimeSec = process.uptime() } = {}) {
  const fired = [];
  for (const rule of RULES) {
    try {
      const text = await rule.check(now, { uptimeSec });
      if (text && (await alert(rule.tag, text, { level: rule.level, title: rule.title, now }))) fired.push(rule.tag);
    } catch (err) {
      console.error(`❌ alert rule ${rule.tag}:`, err.message);
    }
  }
  return fired;
}

/** The last `limit` alerts, newest first, for the console. */
const recent = (limit = 50) => AlertState.find({}, { _id: 0, __v: 0 }).sort({ lastAt: -1 }).limit(limit).lean();

module.exports = { alert, runRules, recent, RULES, COOLDOWN_MS, REPEAT_MS };
