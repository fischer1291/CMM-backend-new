/**
 * Lifecycle pushes (plan 2.3): after the sign-up something happens without
 * anyone starting it. A leader job (index.js, every 30 minutes) walks a list
 * of stages; each stage is a rule { key, select(now) -> candidates,
 * params(candidate, now) -> push params or null }. A candidate is
 * { user, slot? }: the slot makes a stage repeatable per period (the week of
 * week_open, the end date of plus_expiring, the inactivity episode of
 * come_back), otherwise a stage goes to a person once.
 *
 * Once means once: before the push the job claims the stage in
 * User.lifecycle.sent with a conditional update on the empty key, so two
 * instances (Render overlaps them during a deploy) never both send. A push
 * that lib/notify.js then skips (cap, precedence, quiet hours) or Expo does
 * not take gives the claim back, so a later tick may try again within the
 * stage's window; the windows are bounded, so nothing old is sent late.
 *
 * The onboarding stages (days 1, 3, 7) go only to accounts that are new:
 * routes/verify.js sets milestones.verifiedAt for older accounts on their
 * next sign-in too (a new device, an expired token), and a veteran must not
 * get the newcomer series. During the onboarding the inactivity stages
 * wait, so the onboarding stages are not lost to the cap.
 *
 * Tone: no pressure, no "streak is breaking". Switch: notificationPrefs
 * .lifecycle ("Erinnerungen und Tipps"); cap, quiet hours and the precedence
 * of contact_available live in lib/notify.js.
 */
const { Types } = require("mongoose");
const User = require("../models/User");
const Talk = require("../models/Talk");
const ActiveDay = require("../models/ActiveDay");
const PushLog = require("../models/PushLog");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const { notify, isQuiet, lifecycleHold } = require("./notify");
const { momentFor, zoneOf } = require("./dailyMoment");
const { weekStreak, talksOf } = require("./stats");
const { Expo } = require("./push");
const { blockedWith } = require("./relations");
const { localParts, shiftDateKey, weekKey, zoneOr, DEFAULT_TIMEZONE } = require("./localTime");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// ActiveDay counts days in Europe/Berlin (lib/metrics.js markActive)
const ACTIVITY_ZONE = "Europe/Berlin";
// Sources of a Plus that ends on its own (a present, not a subscription)
const GIFT_SOURCES = ["referral", "gift", "waitlist", "admin"];
// RevenueCat's cancel_reason values that mean "the person cancelled": the
// survey asks only them. null: no CANCELLATION at plus.eventAt (the nightly
// reconcile set the status). BILLING_ERROR is a failed payment (billing_issue
// instead), CUSTOMER_SUPPORT a refund by Apple (nothing).
const SURVEY_REASONS = [null, "UNSUBSCRIBE", "UNKNOWN"];
// One billing_issue per problem: RevenueCat sends BILLING_ISSUE and a
// CANCELLATION with BILLING_ERROR for the same failed payment, each with its
// own eventAt, so a slot within this distance of a sent one is the same problem
const BILLING_EPISODE_MS = 14 * 24 * 3600 * 1000;
// An account is new when it was created at most this long before its first
// verified sign-in (routes/verify.js creates it in the same request; older
// app versions registered right after the check, routes/auth.js)
const NEW_ACCOUNT_SLACK_MS = 2 * DAY;
// The onboarding ends with the last day of yap_moment_invite
const ONBOARDING_MS = 10 * DAY;
// Inactivity stages: days since the last ActiveDay, window [from, to]
const INACTIVE = {
  friends_were_available: [3, 6],
  come_back: [14, 20],
  come_back_30: [30, 40],
};

const ago = (now, ms) => new Date(now.getTime() - ms);
const ahead = (now, ms) => new Date(now.getTime() + ms);
// Who can get a lifecycle push at all; the rest is checked per person
const reachable = { pushToken: { $exists: true, $ne: null }, "notificationPrefs.lifecycle": { $ne: false } };
const notSent = (key) => ({ [`lifecycle.sent.${key}`]: null });
const asCandidates = (users, slot) => users.map((user) => ({ user, slot: slot?.(user) }));
const dayOf = (date) => date.toISOString().slice(0, 10);

/** Created about when it was first verified, i.e. not an older account signing in again. */
const isNewAccount = (user) => {
  const verifiedAt = user.milestones?.verifiedAt;
  return !!verifiedAt && user._id.getTimestamp().getTime() >= verifiedAt.getTime() - NEW_ACCOUNT_SLACK_MS;
};
const inOnboarding = (user, now) => isNewAccount(user) && user.milestones.verifiedAt > ago(now, ONBOARDING_MS);

/**
 * Accounts first verified `minAgo`..`maxAgo` ago that are new; the _id bound
 * keeps older accounts out of the query already, isNewAccount decides.
 */
async function newcomers(now, minAgo, maxAgo, query) {
  const users = await User.find({
    "milestones.verifiedAt": { $gt: ago(now, maxAgo), $lte: ago(now, minAgo) },
    _id: { $gte: Types.ObjectId.createFromTime(Math.floor((now.getTime() - maxAgo - NEW_ACCOUNT_SLACK_MS) / 1000)) },
    ...query,
    ...reachable,
  });
  return users.filter(isNewAccount);
}

/** Any talk at all: milestones.firstTalkAt is missing for talks from before the milestones. */
const hasTalked = (user) => Talk.exists(talksOf(user.phone));
const daysBetween = (fromKey, toKey) => Math.round((Date.parse(toKey) - Date.parse(fromKey)) / DAY);

function clockOf(date, zone) {
  const { minutes } = localParts(date, zone);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const dateLabel = (date, zone) =>
  new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: zoneOr(zone) }).format(date);

/** Contacts and invite connections of `user`, without blocks. */
async function peopleOf(user) {
  const blocked = await blockedWith(user.phone);
  return [...new Set([...(user.contacts || []), ...(user.connections || [])])].filter((p) => p !== user.phone && !blocked.has(p));
}

/**
 * Last day with activity for everyone active in the last `days` days:
 * Map ActiveDay.who (User.phoneHmac) -> "YYYY-MM-DD". One aggregation per
 * tick, shared by the inactivity stages.
 */
async function lastActiveDays(now, days) {
  const today = localParts(now, ACTIVITY_ZONE).dateKey;
  const rows = await ActiveDay.aggregate([
    { $match: { day: { $gte: shiftDateKey(today, -days) } } },
    { $group: { _id: "$who", last: { $max: "$day" } } },
  ]);
  return { today, last: new Map(rows.map((r) => [r._id, r.last])) };
}

/** Candidates of one inactivity stage; the slot is the last active day (one push per episode). */
function inactive(key) {
  const [from, to] = INACTIVE[key];
  return async (now, tick) => {
    tick.activity ??= await lastActiveDays(now, INACTIVE.come_back_30[1] + 1);
    const { today, last } = tick.activity;
    const due = [...last].filter(([, day]) => {
      const idle = daysBetween(day, today);
      return idle >= from && idle <= to;
    });
    if (!due.length) return [];
    const users = (await User.find({ phoneHmac: { $in: due.map(([who]) => who) }, ...reachable })).filter((user) => !inOnboarding(user, now));
    return users.map((user) => ({ user, slot: last.get(user.phoneHmac) }));
  };
}

/**
 * cancel_reason of the CANCELLATION each cancelled user's plus.eventAt came
 * from (routes/plus.js stores it with the event; index userId + eventAt):
 * Map String(user._id) -> reason or null.
 */
async function cancelReasons(users) {
  if (!users.length) return new Map();
  const events = await SubscriptionEvent.find(
    { userId: { $in: users.map((u) => u._id) }, type: "CANCELLATION", eventAt: { $in: users.map((u) => u.plus.eventAt) } },
    { userId: 1, eventAt: 1, cancelReason: 1 },
  ).lean();
  const key = (id, at) => `${id}:${at.getTime()}`;
  const reasons = new Map(events.map((e) => [key(e.userId, e.eventAt), e.cancelReason || null]));
  return new Map(users.map((u) => [String(u._id), reasons.get(key(u._id, u.plus.eventAt)) ?? null]));
}

/** Did `user` get a billing_issue for the same problem already (another event of it)? */
function billingSentNear(user, eventAt) {
  const sent = user.lifecycle?.sent;
  if (!sent?.keys) return false;
  return [...sent.keys()].some((key) => key.startsWith("billing_issue:") && Math.abs(Number(key.slice("billing_issue:".length)) - eventAt.getTime()) < BILLING_EPISODE_MS);
}

/** The stages, in the order they are tried: with a cap of two, the first ones win. */
const RULES = [
  {
    key: "billing_issue",
    // Status billing_issue, or a CANCELLATION for a failed payment (it
    // arrives about when BILLING_ISSUE does, and the later event wins the
    // status); once per problem
    select: async (now) => {
      const users = await User.find({ "plus.status": { $in: ["billing_issue", "cancelled"] }, "plus.eventAt": { $gt: ago(now, 14 * DAY) }, ...reachable });
      const reasons = await cancelReasons(users.filter((u) => u.plus.status === "cancelled"));
      const due = users.filter((u) => u.plus.status === "billing_issue" || reasons.get(String(u._id)) === "BILLING_ERROR").filter((u) => !billingSentNear(u, u.plus.eventAt));
      return asCandidates(due, (u) => String(u.plus.eventAt.getTime()));
    },
    params: () => ({}),
  },
  {
    key: "plus_expiring",
    // Three days before a present ends (referral, gift, waitlist, console)
    select: async (now) =>
      asCandidates(
        await User.find({ "plus.active": true, "plus.source": { $in: GIFT_SOURCES }, "plus.until": { $gt: ahead(now, 2 * DAY), $lte: ahead(now, 3 * DAY) }, ...reachable }),
        (u) => dayOf(u.plus.until),
      ),
    params: ({ user }) => ({ date: dateLabel(user.plus.until, zoneOf(user)) }),
  },
  {
    key: "cancel_survey",
    // Only when the person cancelled (SURVEY_REASONS), not for a failed
    // payment or a refund
    select: async (now) => {
      const users = await User.find({ "plus.status": "cancelled", "plus.eventAt": { $gt: ago(now, 7 * DAY) }, ...reachable });
      const reasons = await cancelReasons(users);
      return asCandidates(
        users.filter((u) => SURVEY_REASONS.includes(reasons.get(String(u._id)))),
        (u) => String(u.plus.eventAt.getTime()),
      );
    },
    params: () => ({}),
  },
  {
    key: "plus_winback_3",
    select: async (now) =>
      asCandidates(
        await User.find({ "plus.source": "store", "plus.status": "expired", "plus.active": false, "plus.until": { $gt: ago(now, 5 * DAY), $lte: ago(now, 3 * DAY) }, ...reachable }),
        (u) => dayOf(u.plus.until),
      ),
    params: () => ({}),
  },
  {
    key: "plus_winback_30",
    select: async (now) =>
      asCandidates(
        await User.find({ "plus.source": "store", "plus.status": "expired", "plus.active": false, "plus.until": { $gt: ago(now, 33 * DAY), $lte: ago(now, 30 * DAY) }, ...reachable }),
        (u) => dayOf(u.plus.until),
      ),
    params: () => ({}),
  },
  {
    key: "invite_reminder",
    // Day 1 after the sign-up, nobody invited yet
    select: async (now) => asCandidates(await newcomers(now, DAY, 2 * DAY, { firstInviteAt: null, ...notSent("invite_reminder") })),
    params: ({ user }) => ({ denied: user.device?.contactsPermission === "denied" }),
  },
  {
    key: "first_call_hint",
    // Day 3, someone is here, no talk yet: the contact last online
    select: async (now) =>
      asCandidates(
        await newcomers(now, 3 * DAY, 4 * DAY, {
          "milestones.firstTalkAt": null,
          $or: [{ "contacts.0": { $exists: true } }, { "connections.0": { $exists: true } }],
          ...notSent("first_call_hint"),
        }),
      ),
    params: async ({ user }) => {
      if (await hasTalked(user)) return null;
      // Only people who have this user too: a call to anyone else is refused
      // (lib/relations.js isConnected)
      const [contact] = await User.find({ phone: { $in: await peopleOf(user) }, contacts: user.phone }, { phone: 1, name: 1, lastOnline: 1, isAvailable: 1 })
        .sort({ isAvailable: -1, lastOnline: -1 })
        .limit(1)
        .lean();
      return contact ? { phone: contact.phone, name: contact.name } : null;
    },
  },
  {
    key: "yap_moment_invite",
    // Day 7 to 10 without a talk: once, in the hour before a Yap Moment
    // (moments are between 10:00 and 21:00 every day). Three days, not two:
    // the day-1 reminder still counts towards the cap until day 8 or 9, so
    // the window keeps at least one whole day after it
    select: async (now) =>
      asCandidates(
        await newcomers(now, 7 * DAY, ONBOARDING_MS, {
          "milestones.firstTalkAt": null,
          "notificationPrefs.dailyMoment": { $ne: false },
          ...notSent("yap_moment_invite"),
        }),
      ),
    params: async ({ user }, now) => {
      if (await hasTalked(user)) return null;
      // The zone lib/dailyMoment.js tickDailyMoments starts moments for (only
      // the top-level timezone), so the push names a moment that happens
      const zone = user.timezone || DEFAULT_TIMEZONE;
      const moment = await momentFor(zone, now);
      if (moment.sentAt || now < ago(moment.at, HOUR) || now >= moment.at) return null;
      return { time: clockOf(moment.at, zone) };
    },
  },
  {
    key: "week_open",
    // Sunday 16:00 local, a streak of two weeks or more and no talk this
    // week; once per week (the slot is the week's Monday). The zone is
    // zoneOf(user) throughout (also schedule.timezone), like the quiet hours
    select: async (now) => {
      const stored = [...(await User.distinct("timezone")), ...(await User.distinct("schedule.timezone"))];
      const zones = [...new Set([DEFAULT_TIMEZONE, ...stored.filter(Boolean)])];
      const due = zones.filter((zone) => {
        const { day, minutes } = localParts(now, zone);
        return day === 0 && minutes >= 16 * 60 && minutes < 17 * 60;
      });
      if (!due.length) return [];
      const noZone = { $in: [null, ""] };
      const zoneQuery = [{ timezone: { $in: due } }, { timezone: noZone, "schedule.timezone": { $in: due } }];
      if (due.includes(DEFAULT_TIMEZONE)) zoneQuery.push({ timezone: noZone, "schedule.timezone": noZone });
      const users = await User.find({ $or: zoneQuery, "milestones.firstTalkAt": { $ne: null }, ...reachable });
      return users.filter((user) => due.includes(zoneOf(user))).map((user) => ({ user, slot: weekKey(now, zoneOf(user)) }));
    },
    params: async ({ user }, now) => {
      const streak = await weekStreak(user.phone, zoneOf(user), now);
      return !streak.thisWeek && streak.current >= 2 ? { streak: streak.current } : null;
    },
  },
  {
    key: "friends_were_available",
    select: inactive("friends_were_available"),
    // Was any contact available in these days? Otherwise the come_back text.
    // lastOnline is when someone last switched availability off (or opened
    // the app with a new push token): close enough for "erreichbar"
    params: async ({ user }, now) => {
      const friends = await User.exists({ phone: { $in: await peopleOf(user) }, $or: [{ isAvailable: true }, { lastOnline: { $gte: ago(now, 3 * DAY) } }] });
      return { friends: !!friends };
    },
  },
  { key: "come_back", select: inactive("come_back"), params: () => ({}) },
  { key: "come_back_30", select: inactive("come_back_30"), params: () => ({}) },
];

/**
 * Claim, send, or give the claim back. Returns "sent", "already" or the
 * reason it was skipped.
 */
async function deliver(rule, { user, slot }, now) {
  if (user.notificationPrefs?.lifecycle === false || !user.pushToken) return "opted_out";
  // A token Expo would never take (lib/push.js drops it before sending):
  // no claim, no PushDecision row every 30 minutes
  if (!Expo.isExpoPushToken(user.pushToken)) return "bad_token";
  const stage = slot ? `${rule.key}:${slot}` : rule.key;
  if (user.lifecycle?.sent?.get?.(stage)) return "already";
  // Cheap checks first, so a person under the cap or asleep costs no claim
  // and no PushDecision row; lib/notify.js checks them again
  if (isQuiet(user, now)) return "quiet_hours";
  const held = await lifecycleHold(user.phone, now);
  if (held) return held;
  const params = await rule.params({ user, slot }, now);
  if (!params) return "not_due";

  const field = `lifecycle.sent.${stage}`;
  const claimed = await User.updateOne({ _id: user._id, [field]: null }, { $set: { [field]: now } });
  if (!claimed.modifiedCount) return "already";
  const result = await notify(user, rule.key, { ...params, lifecycleKey: stage }, { now });
  if (result?.sent && result.failed && result.failed !== "DeviceNotRegistered") {
    // Expo did not take it (an outage, no ticket): neither the stage nor the
    // cap is used up, a later tick inside the window tries again. A device
    // that is gone loses its token (lib/push.js) and drops out by itself.
    await PushLog.deleteOne({ to: user.phone, key: `lifecycle:${stage}`, sentAt: now });
    await User.updateOne({ _id: user._id, [field]: now }, { $unset: { [field]: 1 } });
    return "failed";
  }
  if (result?.sent) return "sent";
  // Skipped: free the stage for a later tick, unless it already went out
  // (throttled: the PushLog row of this very stage exists)
  if (result?.skipped !== "throttled") await User.updateOne({ _id: user._id, [field]: now }, { $unset: { [field]: 1 } });
  return result?.skipped || "skipped";
}

/** One run over every stage. Returns { sent, byType }. */
async function tickLifecycle(now = new Date()) {
  const tick = {};
  const byType = {};
  let sent = 0;
  for (const rule of RULES) {
    // One stage failing to query must not hold up the others
    const candidates = await rule.select(now, tick).catch((err) => {
      console.error(`❌ lifecycle ${rule.key} select:`, err.message);
      return [];
    });
    for (const candidate of candidates) {
      const outcome = await deliver(rule, candidate, now).catch((err) => {
        console.error(`❌ lifecycle ${rule.key}:`, err.message);
        return "error";
      });
      if (outcome !== "sent") continue;
      sent++;
      byType[rule.key] = (byType[rule.key] || 0) + 1;
    }
  }
  return { sent, byType };
}

module.exports = { tickLifecycle, isNewAccount, RULES, INACTIVE };
