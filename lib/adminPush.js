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
 * - daily: the day's numbers at the chosen hour (everyone)
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
const { localParts } = require("./localTime");

const ZONE = "Europe/Berlin";
const KINDS = {
  approvals: ["owner"],
  posting: ["owner"],
  support: ["owner", "support"],
  reports: ["owner", "support"],
  daily: ["owner", "support", "viewer"],
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
    const admins = await Admin.find({ role: { $in: roles }, totpEnabled: true, [`notify.${kind}`]: { $ne: false } }).lean();
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
 * The day's numbers, for admins whose hour has come and who haven't had
 * today's yet. Called every few minutes by the job leader (index.js).
 */
async function dailyDue(now = new Date()) {
  const { dateKey, minutes } = localParts(now, ZONE);
  const hour = Math.floor(minutes / 60);
  const admins = await Admin.find({ totpEnabled: true, "notify.daily": { $ne: false }, dailyPushFor: { $ne: dateKey } }).lean();
  const due = admins.filter((a) => hour >= (a.notify?.dailyHour ?? 20));
  if (!due.length) return 0;
  const summary = await daySummary(now);
  let sent = 0;
  for (const admin of due) {
    // Claim first: two runs must not send it twice
    const claimed = await Admin.updateOne({ _id: admin._id, dailyPushFor: { $ne: dateKey } }, { dailyPushFor: dateKey });
    if (!claimed.modifiedCount) continue;
    if (await sendTo(admin, { title: "Heute bei Wanna yap?", body: summary, url: "#dashboard", tag: "daily" })) sent++;
  }
  return sent;
}

/** "3 neue Nutzer · 12 aktiv · 5 Gespräche (48 Min.) · …" for today so far. */
async function daySummary(now = new Date()) {
  const metrics = require("./metrics");
  const LandingVisit = require("../models/LandingVisit");
  const WaitlistEntry = require("../models/WaitlistEntry");
  const { dateKey } = localParts(now, ZONE);
  const [series, visits, waitlist, pending] = await Promise.all([
    metrics.series(1, now),
    LandingVisit.aggregate([{ $match: { day: dateKey } }, { $group: { _id: null, n: { $sum: "$visits" } } }]),
    WaitlistEntry.countDocuments({ status: "confirmed", confirmedAt: { $gte: startOfDay(now) } }),
    AdDraft.countDocuments({ status: "pending" }),
  ]);
  const d = series[series.length - 1] || {};
  const parts = [
    plural(d.users?.new || 0, "neuer Nutzer", "neue Nutzer"),
    `${nf.format(d.users?.dau || 0)} aktiv`,
    `${plural(d.talks?.count || 0, "Gespräch", "Gespräche")}${d.talks?.minutes ? ` (${nf.format(Math.round(d.talks.minutes))} Min.)` : ""}`,
    plural(visits[0]?.n || 0, "Besuch", "Besuche") + " auf der Website",
  ];
  if (waitlist) parts.push(`${nf.format(waitlist)} neu auf der Warteliste`);
  if (pending) parts.push(`${plural(pending, "Video wartet", "Videos warten")} auf Freigabe`);
  return parts.join(" · ");
}

// Midnight in Berlin as a Date
function startOfDay(now) {
  const d = new Date(now.getTime() - localParts(now, ZONE).minutes * 60000);
  d.setUTCSeconds(0, 0);
  return d;
}

module.exports = { KINDS, vapid, subscribe, unsubscribe, devices, notify, tell, sendTo, dailyDue, daySummary, setSender };
