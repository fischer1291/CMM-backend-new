/**
 * Push notifications to the admin console on the admins' phones (Web Push).
 * The console, added to the home screen, subscribes in its settings
 * (#notify); iOS allows this from 16.4 for home-screen web apps.
 *
 * What goes out, each switchable per admin (Admin.notify):
 * - approvals: new ad videos wait for approval (owners)
 * - posting: a video went out, a TikTok draft waits, posting failed (owners)
 * - support: a new support message (owners, support)
 * - reports: a new report (owners, support)
 * - daily: yesterday's numbers, the north star and, once subscriptions
 *   move, the Plus line (new, cancelled, MRR), every morning at the chosen
 *   hour (everyone); tapping it opens #ack, which the console turns into
 *   POST /admin/daily/ack (Admin.lastAckAt)
 * - alerts: something is broken, e.g. confirmation mails fail (owners)
 * - weekly: the weekly report, Monday from 08:00 (everyone; plan 2.11,
 *   lib/weeklyReport.js); tapping it opens #weekly, where owners and
 *   support acknowledge it with the hours spent on operations
 *
 * Dead-man rule (plan 1.8): no owner acknowledged the daily push or signed in
 * for 7 days → a mail to AppConfig.ops.emergencyContact pointing at
 * CMM/docs/EMERGENCY.md, or without one (or when the mail cannot go out) a
 * push to the owners; at most once per 7 days (deadManCheck, run by the job
 * leader in index.js). Plan 2.11 adds weekly_silent: the weekly report has
 * gone out for 14 days and no owner acknowledged one in that time.
 *
 * The VAPID key pair comes from ADMIN_PUSH_PUBLIC_KEY / ADMIN_PUSH_PRIVATE_KEY,
 * otherwise it is created once and kept in the database.
 */
const webpush = require("web-push");
const Admin = require("../models/Admin");
const AdDraft = require("../models/AdDraft");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const { AdminPushSubscription, AdminPushState } = require("../models/AdminPush");
const AlertState = require("../models/AlertState");
const { localParts } = require("./localTime");
const { plusMoved } = require("./metrics");

const ZONE = "Europe/Berlin";
const KINDS = {
  approvals: ["owner"],
  posting: ["owner"],
  support: ["owner", "support"],
  reports: ["owner", "support"],
  daily: ["owner", "support", "viewer"],
  alerts: ["owner"],
  weekly: ["owner", "support", "viewer"],
};
// Undelivered pushes expire: nobody needs yesterday's "new report" at noon
const TTL_SECONDS = 12 * 3600;

// Tests replace the sender
let send = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
function setSender(fn) {
  send = fn;
}

let keys;
async function vapid() {
  if (keys) return keys;
  if (process.env.ADMIN_PUSH_PUBLIC_KEY && process.env.ADMIN_PUSH_PRIVATE_KEY) {
    keys = { publicKey: process.env.ADMIN_PUSH_PUBLIC_KEY, privateKey: process.env.ADMIN_PUSH_PRIVATE_KEY };
    return keys;
  }
  const fresh = webpush.generateVAPIDKeys();
  // Two instances starting at once agree on whichever key pair was stored first
  await AdminPushState.updateOne({ _id: "vapid" }, { $setOnInsert: fresh }, { upsert: true });
  const stored = await AdminPushState.findById("vapid").lean();
  keys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
  return keys;
}

const contact = () => `mailto:${process.env.ADMIN_PUSH_CONTACT || "hallo@wannayap.app"}`;
const device = (ua = "") => (/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser");
const validEndpoint = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && url.length <= 1000;
  } catch {
    return false;
  }
};

/** Store a device's subscription (from PushManager.subscribe). Returns { ok } or { error }. */
async function subscribe(admin, sub, userAgent) {
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!validEndpoint(endpoint) || typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) {
    return { error: "invalid_subscription" };
  }
  await AdminPushSubscription.updateOne(
    { endpoint },
    { admin: admin._id, endpoint, keys: { p256dh, auth }, device: device(userAgent), $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}

async function unsubscribe(admin, endpoint) {
  await AdminPushSubscription.deleteOne({ admin: admin._id, endpoint: String(endpoint || "") });
}

const devices = (admin) => AdminPushSubscription.find({ admin: admin._id }).select("device createdAt lastSentAt endpoint").sort({ createdAt: 1 }).lean();

/** Things waiting for this admin: the number on the app icon. */
async function todo(role) {
  const [approvals, support, reports] = await Promise.all([
    role === "owner" ? AdDraft.countDocuments({ status: "pending" }) : 0,
    role === "viewer" ? 0 : SupportTicket.countDocuments({ status: "open" }),
    role === "viewer" ? 0 : Report.countDocuments({ status: "open" }),
  ]);
  return approvals + support + reports;
}

/** Send one push to every device of one admin. Returns how many arrived. */
async function sendTo(admin, message) {
  const subs = await AdminPushSubscription.find({ admin: admin._id }).lean();
  if (!subs.length) return 0;
  const { publicKey, privateKey } = await vapid();
  const payload = JSON.stringify({ ...message, badge: await todo(admin.role) });
  let delivered = 0;
  for (const s of subs) {
    try {
      await send({ endpoint: s.endpoint, keys: s.keys }, payload, {
        TTL: TTL_SECONDS,
        urgency: message.urgency || "normal",
        topic: message.tag ? message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) : undefined,
        vapidDetails: { subject: contact(), publicKey, privateKey },
      });
      delivered++;
      await AdminPushSubscription.updateOne({ _id: s._id }, { lastSentAt: new Date() });
    } catch (err) {
      // Gone: the device unsubscribed or the app was removed
      if (err.statusCode === 404 || err.statusCode === 410) await AdminPushSubscription.deleteOne({ _id: s._id });
      else console.error("❌ admin push:", err.statusCode || "", err.body || err.message);
    }
  }
  return delivered;
}

/**
 * Tell every admin who wants to hear about `kind`. message: { title, body,
 * url (hash in the console, e.g. "#approvals"), tag (replaces an older push
 * with the same tag) }. Never throws: a failed push must not break the caller.
 */
async function notify(kind, message) {
  try {
    const roles = KINDS[kind];
    if (!roles) throw new Error(`unknown kind ${kind}`);
    const admins = await Admin.find({ role: { $in: roles }, totpEnabled: true, active: { $ne: false }, [`notify.${kind}`]: { $ne: false } }).lean();
    let delivered = 0;
    for (const admin of admins) delivered += await sendTo(admin, message);
    return delivered;
  } catch (err) {
    console.error("❌ admin push:", err.message);
    return 0;
  }
}

/** Run notify() in the background. */
const tell = (kind, message) => {
  notify(kind, message);
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const nf = new Intl.NumberFormat("de-DE");

/**
 * The morning push, for admins whose hour has come and who haven't had
 * today's yet. Called every few minutes by the job leader (index.js).
 */
async function dailyDue(now = new Date()) {
  const { dateKey, minutes } = localParts(now, ZONE);
  const hour = Math.floor(minutes / 60);
  const admins = await Admin.find({ totpEnabled: true, active: { $ne: false }, "notify.daily": { $ne: false }, dailyPushFor: { $ne: dateKey } }).lean();
  const due = admins.filter((a) => hour >= (a.notify?.dailyHour ?? 8));
  if (!due.length) return 0;
  const summary = await daySummary(now);
  let sent = 0;
  for (const admin of due) {
    // Claim first: two runs must not send it twice
    const claimed = await Admin.updateOne({ _id: admin._id, dailyPushFor: { $ne: dateKey } }, { dailyPushFor: dateKey });
    if (!claimed.modifiedCount) continue;
    // #ack: opening it acknowledges the push (the dead-man rule below)
    if (await sendTo(admin, { title: "Gestern bei Wanna yap?", body: summary, url: "#ack", tag: "daily" })) sent++;
  }
  return sent;
}

/** "Aktivierung 4 W: 37 % (Ziel 40) 🔴": the north star with its traffic light. */
function activationLine(a) {
  if (a.pct4w == null) return "Aktivierung 4 W: noch keine Daten";
  if (!a.enough) return `Aktivierung 4 W: ${a.pct4w} % (Ziel ${a.goalPct}, erst ${nf.format(a.sample)} gemessen)`;
  return `Aktivierung 4 W: ${a.pct4w} % (Ziel ${a.goalPct}) ${a.ok ? "🟢" : "🔴"}`;
}

/**
 * "Gestern: 3 neue Nutzer · 12 aktiv · 5 Gespräche (48 Min.) · … ·
 * Aktivierung 4 W: 37 % (Ziel 40) 🔴 · Dichte: 52 % · …": yesterday, whole,
 * plus the north star, the alerts of the last 12 hours (lib/alerts.js) and
 * what waits.
 */
async function daySummary(now = new Date()) {
  const { yesterday: y, activation, density, todo, sms, plus } = await require("./today").yesterdayNumbers(now);
  const parts = [
    `Gestern: ${plural(y.newUsers, "neuer Nutzer", "neue Nutzer")}`,
    `${nf.format(y.active)} aktiv`,
    `${plural(y.talks, "Gespräch", "Gespräche")}${y.talkMinutes ? ` (${nf.format(y.talkMinutes)} Min.)` : ""}`,
    plural(y.visits, "Besuch", "Besuche") + " auf der Website",
  ];
  if (y.waitlist) parts.push(`${nf.format(y.waitlist)} neu auf der Warteliste`);
  parts.push(activationLine(activation));
  if (density.c3plus != null) parts.push(`Dichte: ${density.c3plus} %${density.c0 ? ` (${density.c0} % ohne Kontakte)` : ""}`);
  // "Plus: +2 neu · 1 gekündigt · MRR 84 €", only once subscriptions move or pay
  if (plusMoved(plus) || plus?.mrrCents > 0) parts.push(`Plus: +${nf.format(plus.newPaid || 0)} neu · ${nf.format(plus.cancelled || 0)} gekündigt · MRR ${nf.format(Math.round((plus.mrrCents || 0) / 100))} €`);
  if (todo.overdueTickets) parts.push(`${plural(todo.overdueTickets, "Ticket wartet", "Tickets warten")} seit über 24 h`);
  if (todo.approvals) parts.push(`${plural(todo.approvals, "Video wartet", "Videos warten")} auf Freigabe`);
  const night = await AlertState.find({ lastAt: { $gte: new Date(now.getTime() - 12 * 3600 * 1000) } }, { tag: 1 }).sort({ lastAt: -1 }).lean();
  if (night.length) parts.push(`Alarme der Nacht: ${night.map((a) => a.tag).join(", ")}`);
  parts.push(sms.paused ? "SMS pausiert" : `SMS ${nf.format(sms.started)}/${nf.format(sms.cap)}`);
  return parts.join(" · ");
}

// --- Dead-man rule -------------------------------------------------------------------

const DEAD_MAN_DAYS = 7;
const DEAD_MAN_TAG = "owner_silent";
// Plan 2.11: the weekly report goes out, but no owner acknowledged it
const WEEKLY_SILENT_DAYS = 14;
const WEEKLY_SILENT_TAG = "weekly_silent";
const DAY_MS = 24 * 3600 * 1000;

/**
 * Two signs that the owners are gone, checked by the job leader every hour:
 *
 * - owner_silent: no owner acknowledged the daily push or signed in for 7
 *   days.
 * - weekly_silent (plan 2.11): the weekly report has been going out for at
 *   least 14 days (AppConfig.ops.weeklyReportFirstAt) and no owner
 *   acknowledged one (models/WeeklyReview.js ackAt) in the last 14 days.
 *   Only checked while owner_silent does not hold, so the contact never
 *   gets two mails about the same silence.
 *
 * Either way: a mail to the emergency contact (AppConfig.ops.emergencyContact),
 * or without one (or when the mail cannot go out) a push to the owners. Once
 * per 7 days per tag, booked in AlertState with the same conditional upsert
 * lib/alerts.js uses, so two leaders can't both send. Returns "mail", "push"
 * or null. A fresh install with no owner at all stays quiet: there is nobody
 * to miss yet.
 */
async function deadManCheck(now = new Date()) {
  const since = new Date(now.getTime() - DEAD_MAN_DAYS * DAY_MS);
  const owners = await Admin.find({ role: "owner", totpEnabled: true, active: { $ne: false } }, { email: 1, lastAckAt: 1, lastLoginAt: 1 }).lean();
  if (!owners.length) return null;
  // Signing in counts as well: an owner who reads the console daily but never
  // taps the push must not have their emergency contact alarmed
  const alive = owners.some((o) => (o.lastAckAt && o.lastAckAt >= since) || (o.lastLoginAt && o.lastLoginAt >= since));
  const emails = owners.map((o) => o.email).join(", ");
  if (!alive) {
    return raise(now, {
      tag: DEAD_MAN_TAG,
      base: `Seit ${DEAD_MAN_DAYS} Tagen hat kein Owner die Tageszahlen quittiert oder sich angemeldet.`,
      subject: "Wanna yap?: Owner hat 7 Tage nicht quittiert",
      reason: `Seit ${DEAD_MAN_DAYS} Tagen hat kein Owner die tägliche Mitteilung der Admin-Konsole quittiert oder sich dort angemeldet (${emails}).`,
      title: "Quittung fehlt seit 7 Tagen",
      url: "#ack",
    });
  }
  return weeklySilentCheck(now, owners, emails);
}

/** weekly_silent (see deadManCheck); `owners` are the active owners. */
async function weeklySilentCheck(now, owners, emails) {
  const since = new Date(now.getTime() - WEEKLY_SILENT_DAYS * DAY_MS);
  const config = await require("../models/AppConfig").findOne({ key: "app" }, { ops: 1 }).lean();
  const first = config?.ops?.weeklyReportFirstAt;
  if (!first || new Date(first) > since) return null;
  const WeeklyReview = require("../models/WeeklyReview");
  if (await WeeklyReview.exists({ admin: { $in: owners.map((o) => o._id) }, ackAt: { $gte: since } })) return null;
  return raise(now, {
    tag: WEEKLY_SILENT_TAG,
    base: `Seit ${WEEKLY_SILENT_DAYS} Tagen hat kein Owner den Wochenreport quittiert (Stunden Betrieb, Entscheidungen).`,
    subject: "Wanna yap?: Wochenreport seit 14 Tagen nicht quittiert",
    reason: `Seit ${WEEKLY_SILENT_DAYS} Tagen hat kein Owner den Wochenreport quittiert, der jeden Montag kommt (${emails}). Die Konsole wird vielleicht noch geöffnet, aber die wöchentliche Durchsicht mit den Betriebsstunden fehlt.`,
    title: "Wochenreport seit 14 Tagen offen",
    url: "#weekly",
  });
}

/**
 * Book `tag` (once per 7 days) and tell the emergency contact by mail, or
 * the owners by push. `base` is the short reason for AlertState and the
 * push, `reason` the sentence for the contact's mail.
 */
async function raise(now, { tag, base, subject, reason, title, url }) {
  const since = new Date(now.getTime() - DEAD_MAN_DAYS * DAY_MS);
  const { emergencyContact } = await require("./appConfig").getConfig().then((c) => c.ops);
  // Booked before anything goes out, so two instances never both act; what
  // the booking says is settled below, once the mail attempt is known
  try {
    await AlertState.updateOne(
      { tag, $or: [{ lastAt: { $exists: false } }, { lastAt: { $lt: since } }] },
      { $set: { lastAt: now, lastText: base, level: "warn" }, $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (err) {
    // Sent within the last 7 days: the upsert ran into the unique tag
    if (err.code === 11000) return null;
    throw err;
  }
  const outcome = (lastText) => AlertState.updateOne({ tag }, { $set: { lastText } });
  let text;
  if (emergencyContact) {
    const mailer = require("./mailer");
    if (mailer.configured()) {
      try {
        await mailer.sendMail({
          to: emergencyContact,
          subject,
          text: `Hallo,\n\ndu bist als Notfallkontakt für Wanna yap? hinterlegt. ${reason}\n\nBitte erkundige dich, ob alles in Ordnung ist. Falls nicht: Was zu tun ist, um den Betrieb 30 Tage weiterzuführen oder geordnet einzustellen, steht in docs/EMERGENCY.md im App-Repo (CMM).\n\nDiese Mail kommt höchstens einmal pro Woche, solange die Quittung fehlt.\n\nWanna yap? (automatisch gesendet)`,
        });
        await outcome(`${base} Notfallkontakt ${emergencyContact} wurde informiert.`);
        console.error(`🚨 dead-man (${tag}): emergency contact ${emergencyContact} mailed`);
        return "mail";
      } catch (err) {
        console.error("❌ dead-man mail:", err.reason || err.message);
      }
    }
    // The owners must not believe the contact knows: say that nobody was reached
    text = `${base} Notfallkontakt ${emergencyContact} konnte nicht per Mail erreicht werden (SMTP_URL fehlt oder Versand fehlgeschlagen). Bitte selbst melden.`;
  } else {
    text = `${base} Es ist kein Notfallkontakt hinterlegt (App → Betrieb).`;
  }
  await outcome(text);
  await notify("alerts", { title, body: text, url, tag: `alert-${tag}` });
  console.error(`🚨 dead-man (${tag}): ${text}`);
  return "push";
}

module.exports = { KINDS, vapid, subscribe, unsubscribe, devices, notify, tell, sendTo, dailyDue, daySummary, activationLine, deadManCheck, DEAD_MAN_DAYS, WEEKLY_SILENT_DAYS, setSender };
