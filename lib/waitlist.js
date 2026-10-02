/**
 * The waitlist on the landing page: sign up with double opt-in, a personal
 * referral link, and on release day one launch mail to everyone confirmed.
 *
 * Rewards, redeemed with the code in the app (Einstellungen → Warteliste-Code):
 * everyone confirmed gets the "Von Anfang an" badge; whoever brought
 * REFERRAL_GOAL confirmed friends also gets REWARD_DAYS of Wanna yap+.
 */
const crypto = require("crypto");
const dns = require("dns").promises;
const WaitlistEntry = require("../models/WaitlistEntry");
const LandingVisit = require("../models/LandingVisit");
const AppConfig = require("../models/AppConfig");
const User = require("../models/User");
const { sendMail } = require("./mailer");
const { hasOwnPlus, giftedPlus, countGiftDays } = require("./referral");
const { localParts, shiftDateKey } = require("./localTime");

const REFERRAL_GOAL = 3;
const REWARD_DAYS = 30;
const DAY = 24 * 3600 * 1000;
// Resend the confirmation at most this often (same address signing up again)
const RESEND_AFTER_MS = 10 * 60 * 1000;
const KEEP_AFTER_LAUNCH_MS = 365 * DAY;
const CONSENT_TEXT =
  "Ich möchte per E-Mail erfahren, wenn Wanna yap? startet, und bis dahin höchstens ein paar Neuigkeiten bekommen. Abmelden geht jederzeit über den Link in jeder Mail.";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const site = () => (process.env.SITE_URL || "https://wannayap.app").replace(/\/$/, "");
const api = () => (process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "");

const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
/** "ab cd-1234" -> "ABCD1234" (what people type from the mail) */
const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const cleanEmail = (email) => {
  const e = String(email || "").trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};
/**
 * Can the domain receive mail at all? No MX and no address, or a "null MX"
 * (RFC 7505, e.g. example.com): no. Typos like gmial.com end here. DNS
 * trouble on our side lets the address through.
 */
let domainTakesMail = async (domain) => {
  const settle = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 3000))]);
  try {
    const mx = await settle(dns.resolveMx(domain));
    return !(mx.length && mx.every((r) => r.exchange === "" || r.exchange === "."));
  } catch (err) {
    if (!["ENOTFOUND", "ENODATA"].includes(err.code)) return true;
  }
  try {
    return (await settle(dns.resolve(domain))).length > 0;
  } catch (err) {
    return !["ENOTFOUND", "ENODATA"].includes(err.code);
  }
};
// Tests have no DNS
if (process.env.NODE_ENV === "test") domainTakesMail = async (domain) => !/(^|\.)(invalid|nomail\.test)$/.test(domain);
const setDomainCheck = (fn) => {
  domainTakesMail = fn;
};

const cleanTag = (v) => (typeof v === "string" && v ? v.replace(/[^\w.-]/g, "").slice(0, 40) || null : null);
/** ios | android from the form, else from the browser's user agent; null when neither says. */
function platformOf(platform, userAgent) {
  if (["ios", "android"].includes(platform)) return platform;
  const ua = String(userAgent || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return null;
}
const ZONE = "Europe/Berlin";
const VISIT_DAYS = 30;

// --- Mails -----------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
function layout({ title, body, button, footer }) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#0B0B12;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#F4F4FA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0B12"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.5px;padding-bottom:28px">Wanna yap?</td></tr>
<tr><td style="font-size:30px;font-weight:700;line-height:1.15;letter-spacing:-0.8px;padding-bottom:18px">${esc(title)}</td></tr>
<tr><td style="font-size:17px;line-height:1.55;color:#C9C9DA">${body}</td></tr>
${button ? `<tr><td style="padding:30px 0"><a href="${esc(button.url)}" style="display:inline-block;padding:16px 30px;border-radius:999px;background:#00E5FF;background-image:linear-gradient(90deg,#00E5FF,#8B5CFF,#FF2E93);color:#0B0B12;font-weight:700;font-size:17px;text-decoration:none">${esc(button.label)}</a></td></tr>` : ""}
<tr><td style="font-size:13px;line-height:1.5;color:#6C6C88;padding-top:24px;border-top:1px solid #23233A">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function confirmMail(entry) {
  const url = `${site()}/?bestaetigen=${entry.token}`;
  return {
    subject: "Bitte bestätige: Wanna yap? Warteliste",
    text: `Hey!\n\nNur noch ein Klick: Bestätige deine E-Mail-Adresse, dann sagen wir dir Bescheid, sobald Wanna yap? im App Store ist.\n\n${url}\n\nDu hast dich nicht eingetragen? Dann ignorier diese Mail einfach. Ohne Bestätigung löschen wir deine Adresse nach 7 Tagen.\n\nWanna yap? · ${site()}`,
    html: layout({
      title: "Nur noch ein Klick",
      body: "Bestätige deine E-Mail-Adresse, dann sagen wir dir Bescheid, sobald Wanna yap? im App Store ist. Danach bekommst du deinen persönlichen Einladungslink.",
      button: { url, label: "Ja, ich bin dabei" },
      footer: `Du hast dich nicht eingetragen? Dann ignorier diese Mail einfach. Ohne Bestätigung löschen wir deine Adresse nach 7 Tagen.<br><a href="${site()}/datenschutz" style="color:#A6A6BF">Datenschutz</a> · <a href="${site()}/impressum" style="color:#A6A6BF">Impressum</a>`,
    }),
  };
}

function launchMail(entry, referrals) {
  const download = `${site()}/download?ct=waitlist`;
  const unsubscribe = `${site()}/?abmelden=${entry.token}`;
  const reward =
    referrals >= REFERRAL_GOAL
      ? `Weil du ${referrals} Freunde mitgebracht hast, gibt es dazu ${REWARD_DAYS} Tage Wanna yap+ geschenkt.`
      : "";
  const code = showCode(entry.code);
  return {
    subject: "Wanna yap? ist da 🎉",
    text: `Es ist so weit: Wanna yap? ist im App Store.\n\n${download}\n\nDein Code: ${code}\nLös ihn in der App unter Einstellungen → Warteliste-Code ein, dann bekommst du das Abzeichen „Von Anfang an“. ${reward}\n\nDie App lebt von deinen Leuten: Lade gleich die ein, mit denen du öfter reden willst.\n\nAbmelden: ${unsubscribe}\nWanna yap? · ${site()}`,
    html: layout({
      title: "Es ist so weit: Wanna yap? ist da",
      body: `Danke, dass du von Anfang an dabei bist. Hol dir die App und sieh, wer aus deinen Leuten gerade Zeit hat.<br><br>
<b style="color:#F4F4FA">Dein Code: <span style="font-family:Menlo,monospace;letter-spacing:2px">${esc(code)}</span></b><br>
Lös ihn in der App unter <i>Einstellungen → Warteliste-Code</i> ein, dann bekommst du das Abzeichen „Von Anfang an“. ${esc(reward)}<br><br>
Die App lebt von deinen Leuten: Lade gleich die ein, mit denen du öfter reden willst.`,
      button: { url: download, label: "Jetzt im App Store laden" },
      footer: `Du bekommst diese Mail, weil du dich auf die Warteliste eingetragen hast. <a href="${esc(unsubscribe)}" style="color:#A6A6BF">Abmelden</a><br><a href="${site()}/datenschutz" style="color:#A6A6BF">Datenschutz</a> · <a href="${site()}/impressum" style="color:#A6A6BF">Impressum</a>`,
    }),
    unsubscribe: `${api()}/waitlist/unsubscribe/${entry.token}`,
  };
}

// --- Sign-up -----------------------------------------------------------------------

async function sendConfirm(entry) {
  await sendMail({ to: entry.email, ...confirmMail(entry) });
  await WaitlistEntry.updateOne({ _id: entry._id }, { confirmMailAt: new Date() });
}

// Tell the owners at most once an hour that confirmation mails fail
let lastAlert = 0;
function alertMailFailing(err) {
  if (Date.now() - lastAlert < 3600 * 1000) return;
  lastAlert = Date.now();
  require("./adminPush").tell("alerts", {
    title: "Bestätigungsmails kommen nicht an",
    body: `Der Mail-Anbieter lehnt ab: ${err.reason || err.message}. Anmeldungen bleiben gespeichert, die Mail geht raus, sobald es wieder klappt.`,
    url: "#waitlist",
    tag: "mail-failing",
    urgency: "high",
  });
}

/**
 * The confirmation mail; a failure of our sending keeps the sign-up
 * (resendMissing() tries again). Returns "sent", "delayed" or "rejected"
 * (the address itself can't receive mail).
 */
async function trySendConfirm(entry) {
  try {
    await sendConfirm(entry);
    return "sent";
  } catch (err) {
    if (err.recipientRejected) return "rejected";
    console.error("❌ waitlist confirm mail:", err.reason || err.message);
    alertMailFailing(err);
    return "delayed";
  }
}

/**
 * Sign-ups whose confirmation mail never went out (the mail provider failed):
 * send it now. Stops at the first failure, the provider is still down.
 * Called every 10 minutes by the job leader (index.js).
 */
async function resendMissing(now = new Date(), limit = 20) {
  const waiting = await WaitlistEntry.find({ status: "pending", confirmMailAt: null, createdAt: { $gte: new Date(now.getTime() - 7 * DAY) } })
    .sort({ createdAt: 1 })
    .limit(limit);
  let sent = 0;
  let dropped = 0;
  for (const entry of waiting) {
    try {
      await sendConfirm(entry);
      sent++;
    } catch (err) {
      // The address can't receive mail: nothing to wait for, drop it and go on
      if (err.recipientRejected) {
        await WaitlistEntry.deleteOne({ _id: entry._id, status: "pending" });
        dropped++;
        continue;
      }
      return { sent, dropped, failed: true, waiting: waiting.length - sent - dropped };
    }
  }
  return { sent, dropped, failed: false, waiting: waiting.length - sent - dropped };
}

/**
 * Sign up. The answer is the same whether the address is new, pending or
 * already confirmed, so nobody can find out who is on the list.
 */
async function signUp({ email, ref, source, campaign, platform, userAgent, ip }) {
  const address = cleanEmail(email);
  if (!address) return { error: "invalid_email" };
  const existing = await WaitlistEntry.findOne({ email: address });
  if (existing) {
    if (existing.status === "pending" && (!existing.confirmMailAt || Date.now() - existing.confirmMailAt > RESEND_AFTER_MS)) {
      const result = await trySendConfirm(existing);
      if (result === "rejected") {
        await WaitlistEntry.deleteOne({ _id: existing._id, status: "pending" });
        return { error: "undeliverable" };
      }
      if (result === "delayed") return { ok: true, mailDelayed: true };
    }
    return { ok: true };
  }
  if (!(await domainTakesMail(address.split("@")[1]))) return { error: "undeliverable" };
  const referrer = normalizeCode(ref);
  const referredBy = referrer && (await WaitlistEntry.exists({ code: referrer, status: "confirmed" })) ? referrer : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const entry = await WaitlistEntry.create({
        email: address,
        code: newCode(),
        token: crypto.randomBytes(24).toString("hex"),
        referredBy,
        source: cleanTag(source),
        campaign: cleanTag(campaign),
        platform: platformOf(platform, userAgent),
        consent: { at: new Date(), ip: ip || null, text: CONSENT_TEXT },
      });
      const result = await trySendConfirm(entry);
      if (result === "rejected") {
        await WaitlistEntry.deleteOne({ _id: entry._id, status: "pending" });
        return { error: "undeliverable" };
      }
      await countStep("submitted", { source, campaign, ref: !!ref }).catch(() => {});
      return result === "sent" ? { ok: true } : { ok: true, mailDelayed: true };
    } catch (err) {
      // Same address at the same moment: fine; a code collision: try again
      if (err.code === 11000 && err.keyPattern?.email) return { ok: true };
      if (err.code !== 11000) throw err;
    }
  }
  throw new Error("waitlist_code_collision");
}

/**
 * One visit to the landing page: only a counter per day, source and campaign
 * goes up. Source is utm_source or the platform the page saw in the referrer;
 * without either, "empfehlung" for a ?ref= link, else "direkt" (the same
 * labels the sign-ups get in overview()).
 */
async function countVisit(visit, now = new Date()) {
  return countStep("visit", visit, now);
}

// The steps the landing page reports, and the counter each one raises
const STEPS = { visit: "visits", engaged: "engaged", form: "formStarted", submitted: "submitted", store: "storeClicks" };

/** One step on the way to a sign-up (see STEPS), counted like a visit. */
async function countStep(step, { source, campaign, ref }, now = new Date()) {
  const field = STEPS[step];
  if (!field) return false;
  const tag = cleanTag(source)?.toLowerCase() || (ref ? "empfehlung" : "direkt");
  await LandingVisit.updateOne(
    { day: localParts(now, ZONE).dateKey, source: tag, campaign: cleanTag(campaign)?.toLowerCase() || "" },
    { $inc: { [field]: 1 } },
    { upsert: true },
  );
  return true;
}

/** Visits of the last 30 days: per day, and per source/campaign next to the sign-ups they brought. */
async function visitStats(now = new Date()) {
  const today = localParts(now, ZONE).dateKey;
  const firstDay = shiftDateKey(today, -(VISIT_DAYS - 1));
  const lastWeek = shiftDateKey(today, -6);
  const [byDay, visits, signups] = await Promise.all([
    LandingVisit.aggregate([{ $match: { day: { $gte: firstDay } } }, { $group: { _id: "$day", n: { $sum: "$visits" } } }]),
    LandingVisit.aggregate([
      { $match: { day: { $gte: firstDay } } },
      {
        $group: {
          _id: { source: "$source", campaign: "$campaign" },
          n: { $sum: "$visits" },
          engaged: { $sum: "$engaged" },
          formStarted: { $sum: "$formStarted" },
          submitted: { $sum: "$submitted" },
          storeClicks: { $sum: "$storeClicks" },
        },
      },
    ]),
    WaitlistEntry.aggregate([
      { $match: { status: "confirmed", createdAt: { $gte: new Date(now.getTime() - VISIT_DAYS * DAY) } } },
      {
        $group: {
          _id: {
            source: { $toLower: { $ifNull: ["$source", { $cond: [{ $ne: ["$referredBy", null] }, "empfehlung", "direkt"] }] } },
            campaign: { $toLower: { $ifNull: ["$campaign", ""] } },
          },
          n: { $sum: 1 },
        },
      },
    ]),
  ]);
  const perDay = new Map(byDay.map((d) => [d._id, d.n]));
  const days = Array.from({ length: VISIT_DAYS }, (_, i) => shiftDateKey(firstDay, i));
  const rows = new Map();
  const row = ({ source, campaign }) => {
    const key = `${source}|${campaign}`;
    if (!rows.has(key)) rows.set(key, { source, campaign: campaign || null, visits: 0, engaged: 0, formStarted: 0, submitted: 0, storeClicks: 0, storeRate: null, signups: 0 });
    return rows.get(key);
  };
  for (const v of visits) {
    const r = row(v._id);
    r.visits += v.n;
    r.engaged += v.engaged || 0;
    r.formStarted += v.formStarted || 0;
    r.submitted += v.submitted || 0;
    r.storeClicks += v.storeClicks || 0;
  }
  for (const s of signups) row(s._id).signups += s.n;
  // Visit → store click, the share that went on towards the store (null without visits)
  for (const r of rows.values()) r.storeRate = r.visits ? r.storeClicks / r.visits : null;
  const storeClicks = visits.reduce((sum, v) => sum + (v.storeClicks || 0), 0);
  return {
    today: perDay.get(today) || 0,
    last7Days: days.filter((d) => d >= lastWeek).reduce((sum, d) => sum + (perDay.get(d) || 0), 0),
    last30Days: days.reduce((sum, d) => sum + (perDay.get(d) || 0), 0),
    signups30Days: signups.reduce((sum, s) => sum + s.n, 0),
    storeClicks30Days: storeClicks,
    // The way from visit to confirmed sign-up, last 30 days; storeClicks is the
    // other way off the page (visit → store → download → registration), same denominator
    funnel: {
      visits: visits.reduce((sum, v) => sum + v.n, 0),
      engaged: visits.reduce((sum, v) => sum + (v.engaged || 0), 0),
      formStarted: visits.reduce((sum, v) => sum + (v.formStarted || 0), 0),
      submitted: visits.reduce((sum, v) => sum + (v.submitted || 0), 0),
      confirmed: signups.reduce((sum, s) => sum + s.n, 0),
      storeClicks,
    },
    byDay: days.map((day) => ({ day, count: perDay.get(day) || 0, partial: day === today })),
    campaigns: [...rows.values()].sort((a, b) => b.visits - a.visits || b.signups - a.signups).slice(0, 25),
  };
}

async function statusOf(entry) {
  const [position, referrals, total] = await Promise.all([
    WaitlistEntry.countDocuments({ status: "confirmed", confirmedAt: { $lte: entry.confirmedAt } }),
    WaitlistEntry.countDocuments({ referredBy: entry.code, status: "confirmed" }),
    WaitlistEntry.countDocuments({ status: "confirmed" }),
  ]);
  return { code: entry.code, position, total, referrals, goal: REFERRAL_GOAL, rewardDays: REWARD_DAYS };
}

/** The link in the confirmation mail (the landing page posts the token here). */
async function confirm(token, ip) {
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return null;
  const entry = await WaitlistEntry.findOne({ token });
  if (!entry) return null;
  if (entry.status !== "confirmed") {
    entry.status = "confirmed";
    entry.confirmedAt = new Date();
    entry.consent.confirmedIp = ip || null;
    await entry.save();
  }
  return statusOf(entry);
}

async function status(code) {
  const entry = await WaitlistEntry.findOne({ code: normalizeCode(code), status: "confirmed" });
  return entry ? statusOf(entry) : null;
}

/** Unsubscribing deletes the entry (link in every mail, one-click header). */
async function unsubscribe(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return false;
  const res = await WaitlistEntry.deleteOne({ token });
  return res.deletedCount > 0;
}

// --- Redeem in the app -------------------------------------------------------------

async function redeem(phone, code, io, now = new Date()) {
  const user = await User.findOne({ phone });
  if (!user) return { error: "unknown_user" };
  if (user.waitlist?.code) return { error: "already_redeemed" };
  const entry = await WaitlistEntry.findOne({ code: normalizeCode(code), status: "confirmed" });
  if (!entry) return { error: "unknown_code" };
  // One code, one person
  const claimed = await WaitlistEntry.findOneAndUpdate(
    { _id: entry._id, claimedBy: null },
    { claimedBy: User.hashPhone(phone), claimedAt: now },
    { new: true },
  );
  if (!claimed) return { error: "code_used" };

  const referrals = await WaitlistEntry.countDocuments({ referredBy: entry.code, status: "confirmed" });
  const plusDays = referrals >= REFERRAL_GOAL && !hasOwnPlus(user, now) ? REWARD_DAYS : 0;
  const update = { waitlist: { code: entry.code, at: now, referrals } };
  // Plus that a gift shouldn't touch (a store plan, an open admin grant) stays
  if (plusDays) update.plus = giftedPlus(user, plusDays, "waitlist", now);
  await User.updateOne({ phone }, { $set: update });
  if (plusDays) {
    // The gift budget (plan 2.12)
    await countGiftDays("waitlist", plusDays, now);
    io?.to(`user:${phone}`).emit("planChanged", {});
  }
  return { ok: true, badge: "pioneer", referrals, plusDays };
}

// --- Launch mail -------------------------------------------------------------------

const BATCH = () => Math.max(1, Math.min(200, parseInt(process.env.WAITLIST_BATCH, 10) || 40));

/** One address, e.g. the admin's own, to see the mail before everyone does. */
async function sendTestLaunchMail(email) {
  const address = cleanEmail(email);
  if (!address) return { error: "invalid_email" };
  const sample = { email: address, code: "TEST2345", token: "0".repeat(48) };
  await sendMail({ to: address, ...launchMail(sample, REFERRAL_GOAL) });
  return { ok: true };
}

async function launchState() {
  const cfg = await AppConfig.findOne({ key: "app" }, { waitlistLaunch: 1 }).lean();
  return cfg?.waitlistLaunch || null;
}

/** Start the launch mail (owner, typed confirmation). Sending runs in the background. */
async function startLaunch(by) {
  const state = await launchState();
  if (state?.startedAt) return { state, already: true };
  await AppConfig.updateOne(
    { key: "app" },
    { $set: { waitlistLaunch: { startedAt: new Date(), by, finishedAt: null, sent: 0, failed: 0 } } },
    { upsert: true },
  );
  return { state: await launchState() };
}

/**
 * Background job (leader only, every few seconds): the next batch of launch
 * mails. Picks up where it stopped after a restart; each address gets one mail.
 */
async function runLaunchBatch(now = new Date()) {
  const state = await launchState();
  // Privacy policy: the list is deleted at the latest 12 months after the launch
  if (state?.finishedAt && now - new Date(state.finishedAt) > KEEP_AFTER_LAUNCH_MS && !state.purgedAt) {
    const { deletedCount } = await WaitlistEntry.deleteMany({});
    await AppConfig.updateOne({ key: "app" }, { $set: { "waitlistLaunch.purgedAt": now } });
    return { purged: deletedCount };
  }
  if (!state?.startedAt || state.finishedAt) return null;
  const entries = await WaitlistEntry.find({ status: "confirmed", launchMailAt: null }).sort({ confirmedAt: 1 }).limit(BATCH());
  if (!entries.length) {
    await AppConfig.updateOne({ key: "app" }, { $set: { "waitlistLaunch.finishedAt": new Date() } });
    return { done: true };
  }
  let sent = 0;
  let failed = 0;
  for (const entry of entries) {
    // Mark first: a crash mid-send must not mean a second mail
    const mine = await WaitlistEntry.updateOne({ _id: entry._id, launchMailAt: null }, { launchMailAt: new Date() });
    if (!mine.modifiedCount) continue;
    try {
      const referrals = await WaitlistEntry.countDocuments({ referredBy: entry.code, status: "confirmed" });
      await sendMail({ to: entry.email, ...launchMail(entry, referrals) });
      sent++;
    } catch (err) {
      failed++;
      console.error("❌ launch mail:", err.message);
    }
  }
  await AppConfig.updateOne({ key: "app" }, { $inc: { "waitlistLaunch.sent": sent, "waitlistLaunch.failed": failed } });
  return { sent, failed };
}

// --- Admin numbers -------------------------------------------------------------------

async function overview(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const [pending, confirmed, claimed, mailed, bySource, byDay, top, launch, visits] = await Promise.all([
    WaitlistEntry.countDocuments({ status: "pending" }),
    WaitlistEntry.countDocuments({ status: "confirmed" }),
    WaitlistEntry.countDocuments({ claimedBy: { $ne: null } }),
    WaitlistEntry.countDocuments({ launchMailAt: { $ne: null } }),
    WaitlistEntry.aggregate([
      { $match: { status: "confirmed" } },
      { $group: { _id: { $ifNull: ["$source", { $cond: [{ $ne: ["$referredBy", null] }, "empfehlung", "direkt"] }] }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]),
    WaitlistEntry.aggregate([
      { $match: { status: "confirmed", confirmedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$confirmedAt", timezone: "Europe/Berlin" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    WaitlistEntry.aggregate([
      { $match: { status: "confirmed", referredBy: { $ne: null } } },
      { $group: { _id: "$referredBy", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]),
    launchState(),
    visitStats(now),
  ]);
  const viaReferral = await WaitlistEntry.countDocuments({ status: "confirmed", referredBy: { $ne: null } });
  return {
    pending,
    confirmed,
    viaReferral,
    claimed,
    mailed,
    reachedGoal: (await WaitlistEntry.aggregate([
      { $match: { status: "confirmed", referredBy: { $ne: null } } },
      { $group: { _id: "$referredBy", n: { $sum: 1 } } },
      { $match: { n: { $gte: REFERRAL_GOAL } } },
      { $count: "n" },
    ]))[0]?.n || 0,
    bySource: bySource.map((s) => ({ source: s._id, count: s.n })),
    byDay: byDay.map((d) => ({ day: d._id, count: d.n })),
    topReferrers: top.map((t) => ({ code: showCode(t._id), count: t.n })),
    launch,
    visits,
  };
}

module.exports = {
  REFERRAL_GOAL,
  REWARD_DAYS,
  CONSENT_TEXT,
  newCode,
  normalizeCode,
  showCode,
  platformOf,
  signUp,
  countVisit,
  countStep,
  resendMissing,
  setDomainCheck,
  confirm,
  status,
  unsubscribe,
  redeem,
  sendTestLaunchMail,
  startLaunch,
  launchState,
  runLaunchBatch,
  overview,
  visitStats,
  confirmMail,
  launchMail,
};
