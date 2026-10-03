// Lifecycle pushes (plan 2.3, lib/lifecycle.js): the stages, their texts and
// deep links, once per stage even with two leaders, the cap of two in seven
// days, the switch, the precedence of contact_available, POST /me/state and
// the measurement in MetricsDaily.lifecycle.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { Types } = require("mongoose");
const { setup, teardown, reset, fakes, befriend } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const ActiveDay = require("../models/ActiveDay");
const DailyMoment = require("../models/DailyMoment");
const PushDecision = require("../models/PushDecision");
const PushLog = require("../models/PushLog");
const Lock = require("../models/Lock");
const MetricsDaily = require("../models/MetricsDaily");
const { applyEvent } = require("../routes/plus");
const { tickLifecycle, isNewAccount, RULES } = require("../lib/lifecycle");
const { notify, LIFECYCLE_CAP, DAILY_SOCIAL_CAP } = require("../lib/notify");
const { asLeader } = require("../lib/leader");
const { lifecycleDay, saveDay, METRICS_VERSION } = require("../lib/metrics");
const { localParts, shiftDateKey } = require("../lib/localTime");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const DORA = "+4915444444444";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const berlinDay = (date) => localParts(date, "Europe/Berlin").dateKey;
/** The instant of hh:mm on `dateKey` in Berlin, summer or winter time. */
function berlinAt(dateKey, hh, mm = 0) {
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return ["+02:00", "+01:00"].map((offset) => new Date(`${dateKey}T${clock}:00${offset}`)).find((d) => localParts(d, "Europe/Berlin").minutes === hh * 60 + mm);
}
// The next Wednesday, 14:00 in Berlin: no quiet hours, and every row the
// tests write lies ahead of the real clock, so the TTL monitor of the test
// database never removes one in the middle of a test
const NOW = (() => {
  const real = new Date();
  const wait = (3 - localParts(real, "Europe/Berlin").day + 7) % 7 || 7;
  return berlinAt(shiftDateKey(berlinDay(real), wait), 14);
})();
const ago = (ms, now = NOW) => new Date(now.getTime() - ms);

/** An ObjectId created at `date`, like the one of an account created then. */
const idAt = (date) => new Types.ObjectId(Math.floor(date.getTime() / 1000));
/**
 * A user straight in the database, reachable by push. The account was
 * created at its first verified sign-in (or at NOW); `_id: idAt(...)` makes
 * an older one.
 */
const person = (phone, fields = {}) =>
  User.create({
    _id: idAt(fields.milestones?.verifiedAt || NOW),
    phone,
    name: fields.name || phone.slice(-4),
    phoneHmac: User.hmacPhone(phone),
    pushToken: `ExponentPushToken[${phone.slice(-4)}]`,
    timezone: "Europe/Berlin",
    ...fields,
  });
const pushesTo = (phone) => fakes.expoPushes.filter((p) => p.to === `ExponentPushToken[${phone.slice(-4)}]`);
const activeOn = (phone, day) => ActiveDay.create({ day, who: User.hmacPhone(phone), at: NOW });

async function login(phone) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("invite_reminder: day 1 without an invite gets one push to /contacts; with an invite or too early nothing", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(30 * HOUR) } });
  await person(BEN, { milestones: { verifiedAt: ago(30 * HOUR) }, firstInviteAt: ago(29 * HOUR) });
  await person(CARL, { milestones: { verifiedAt: ago(5 * HOUR) } });

  const result = await tickLifecycle(NOW);
  assert.deepEqual(result, { sent: 1, byType: { invite_reminder: 1 } });
  const [push] = pushesTo(ANNA);
  assert.equal(push.data.type, "invite_reminder");
  assert.equal(push.data.url, "/contacts");
  assert.equal(push.title, "Wer fehlt noch? 👋");
  assert.ok(!/reißt|verpass|jetzt sofort/i.test(push.body), "no pressure in the text");
  assert.equal(pushesTo(BEN).length + pushesTo(CARL).length, 0);

  const anna = await User.findOne({ phone: ANNA });
  assert.equal(anna.lifecycle.sent.get("invite_reminder").getTime(), NOW.getTime());
  // The next tick, half an hour later: once means once
  await tickLifecycle(new Date(NOW.getTime() + 30 * 60 * 1000));
  assert.equal(pushesTo(ANNA).length, 1);
});

test("invite_reminder: its own text when the device denied access to contacts", async () => {
  await person(DORA, { milestones: { verifiedAt: ago(26 * HOUR) }, device: { contactsPermission: "denied", notifications: "granted", at: ago(HOUR) } });
  await tickLifecycle(NOW);
  const [push] = pushesTo(DORA);
  assert.equal(push.title, "Deine Leute finden 👋");
  assert.match(push.body, /Einladungslink/);
  assert.equal(push.data.url, "/contacts");
});

test("first_call_hint: day 3 without a talk names the contact who was online last and opens their page", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(3.5 * DAY) } });
  await person(BEN, { name: "Ben Braun", lastOnline: ago(2 * DAY) });
  await person(CARL, { name: "Carl Corn", lastOnline: ago(HOUR) });
  // Dora was online last of all, but doesn't have Anna: a call would be refused
  await person(DORA, { name: "Dora", lastOnline: ago(60 * 1000) });
  await befriend(ANNA, BEN, CARL);
  await User.updateOne({ phone: ANNA }, { $addToSet: { contacts: DORA } });

  await tickLifecycle(NOW);
  const [push] = pushesTo(ANNA);
  assert.equal(push.data.type, "first_call_hint");
  assert.equal(push.title, "Carl ist auch hier");
  assert.equal(push.data.url, `/friend?phone=${encodeURIComponent(CARL)}`);
  assert.equal(push.data.phone, CARL);

  // With a talk already there is no hint
  await reset();
  await person(ANNA, { milestones: { verifiedAt: ago(3.5 * DAY), firstTalkAt: ago(DAY) } });
  await person(BEN, { lastOnline: ago(HOUR) });
  await befriend(ANNA, BEN);
  await tickLifecycle(NOW);
  assert.equal(pushesTo(ANNA).length, 0);
});

test("yap_moment_invite: day 7 without a talk, in the hour before the zone's Yap Moment, with its time", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(7.5 * DAY) } });
  const day = berlinDay(NOW);
  const at = new Date(NOW.getTime() + 2 * HOUR);
  await DailyMoment.create({ day, zone: "Europe/Berlin", at, endsAt: new Date(at.getTime() + 10 * 60 * 1000) });

  // Two hours before: not yet
  await tickLifecycle(NOW);
  assert.equal(pushesTo(ANNA).length, 0);
  const assertNoClaim = async () => assert.equal((await User.findOne({ phone: ANNA })).lifecycle?.sent?.get("yap_moment_invite"), undefined);
  await assertNoClaim();

  const later = new Date(at.getTime() - 40 * 60 * 1000);
  await tickLifecycle(later);
  const [push] = pushesTo(ANNA);
  assert.equal(push.data.type, "yap_moment_invite");
  assert.equal(push.title, "Heute um 16:00 ist Yap Moment ⚡");
  assert.equal(push.data.url, "/");
});

test("week_open: Sunday 16:00 with a two-week streak and no talk this week; once per week", async () => {
  // The Sunday after NOW, 16:10 in Berlin
  const sunday = berlinAt(shiftDateKey(berlinDay(NOW), 4), 16, 10);
  await person(ANNA, { milestones: { verifiedAt: ago(30 * DAY, sunday), firstTalkAt: ago(20 * DAY, sunday) } });
  await person(BEN, { milestones: { verifiedAt: ago(30 * DAY, sunday), firstTalkAt: ago(20 * DAY, sunday) } });
  // Anna talked in each of the two weeks before; Ben too, and this week as well
  await Talk.create([
    { callId: "t1", participants: [ANNA, CARL], startedAt: ago(7 * DAY, sunday), seconds: 300 },
    { callId: "t2", participants: [ANNA, CARL], startedAt: ago(14 * DAY, sunday), seconds: 300 },
    { callId: "t3", participants: [BEN, CARL], startedAt: ago(7 * DAY, sunday), seconds: 300 },
    { callId: "t4", participants: [BEN, CARL], startedAt: ago(14 * DAY, sunday), seconds: 300 },
    { callId: "t5", participants: [BEN, CARL], startedAt: ago(2 * DAY, sunday), seconds: 300 },
  ]);

  // Saturday at the same time: nothing
  await tickLifecycle(ago(DAY, sunday));
  assert.equal(fakes.expoPushes.length, 0);

  await tickLifecycle(sunday);
  const [push] = pushesTo(ANNA);
  assert.equal(push.data.type, "week_open");
  assert.match(push.body, /^Du hast 2 Wochen nacheinander/);
  assert.ok(!/reißt|abreißen|verlier/i.test(push.body), "no streak pressure");
  assert.equal(pushesTo(BEN).length, 0, "already talked this week");
  assert.ok((await User.findOne({ phone: ANNA })).lifecycle.sent.get(`week_open:${shiftDateKey(berlinDay(NOW), -2)}`), "keyed by the week's Monday");

  await tickLifecycle(new Date(sunday.getTime() + 30 * 60 * 1000));
  assert.equal(pushesTo(ANNA).length, 1);
});

test("inactivity: 3 days with an available contact, else the come_back text; 14 days come_back; 45 days nothing", async () => {
  const today = berlinDay(NOW);
  await person(ANNA);
  await person(BEN, { isAvailable: true });
  await befriend(ANNA, BEN);
  await activeOn(ANNA, shiftDateKey(today, -4));
  await person(CARL);
  await activeOn(CARL, shiftDateKey(today, -4));
  await person(DORA);
  await activeOn(DORA, shiftDateKey(today, -15));
  const EVA = "+4915555555555";
  await person(EVA);
  await activeOn(EVA, shiftDateKey(today, -45));

  await tickLifecycle(NOW);
  const [anna] = pushesTo(ANNA);
  assert.equal(anna.data.type, "friends_were_available");
  assert.equal(anna.title, "Deine Leute waren erreichbar");
  const [carl] = pushesTo(CARL);
  assert.equal(carl.data.type, "friends_were_available");
  assert.equal(carl.title, "Lange nicht gehört 👋", "nobody of Carl's was available: the come_back text");
  const [dora] = pushesTo(DORA);
  assert.equal(dora.data.type, "come_back");
  assert.equal(pushesTo(EVA).length, 0, "after the last stage: quiet");
  assert.ok((await User.findOne({ phone: DORA })).lifecycle.sent.get(`come_back:${shiftDateKey(today, -15)}`), "one per inactivity episode");
});

test("cap: at most two lifecycle pushes in seven days; the third stage stays unclaimed for later", async () => {
  const today = berlinDay(NOW);
  await person(ANNA, {
    milestones: { verifiedAt: ago(30 * HOUR) },
    plus: { active: true, source: "referral", until: new Date(NOW.getTime() + 2.5 * DAY) },
  });
  await activeOn(ANNA, shiftDateKey(today, -4));
  // An older lifecycle push this week counts too
  await PushLog.create({ to: ANNA, key: "lifecycle:billing_issue:1", sentAt: ago(3 * DAY), expiresAt: new Date(NOW.getTime() + 4 * DAY) });

  await tickLifecycle(NOW);
  assert.equal(LIFECYCLE_CAP, 2);
  assert.deepEqual(pushesTo(ANNA).map((p) => p.data.type), ["plus_expiring"]);
  const sent = (await User.findOne({ phone: ANNA })).lifecycle.sent;
  assert.ok(sent.get(`plus_expiring:${new Date(NOW.getTime() + 2.5 * DAY).toISOString().slice(0, 10)}`));
  assert.equal(sent.get("invite_reminder"), undefined, "held by the cap, not used up");

  // Directly through the catalog the cap holds as well
  const direct = await notify(ANNA, "come_back", { lifecycleKey: "come_back:x" }, { now: NOW });
  assert.equal(direct.skipped, "lifecycle_cap");

  // Eight days later the week is over: the next stage may come (here none is due any more)
  await PushLog.deleteMany({});
  const next = await notify(ANNA, "come_back", { lifecycleKey: "come_back:y" }, { now: new Date(NOW.getTime() + 8 * DAY) });
  assert.equal(next.sent, true);
});

test("precedence: a contact_available push in the last 24 hours holds every lifecycle push", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(26 * HOUR) } });
  // 9:00 in Berlin: Ben became available
  assert.equal((await notify(ANNA, "contact_available", { phone: BEN, name: "Ben" }, { now: ago(5 * HOUR) })).sent, true);
  fakes.expoPushes.length = 0;

  await tickLifecycle(NOW);
  assert.equal(fakes.expoPushes.length, 0);
  assert.equal((await User.findOne({ phone: ANNA })).lifecycle?.sent?.get("invite_reminder"), undefined, "not used up");

  // Next morning 8:00: the 24 hours aren't over yet; 9:30 they are, and the
  // reminder is still inside its window (26 h + 19.5 h < 48 h)
  await tickLifecycle(new Date(NOW.getTime() + 18 * HOUR));
  assert.equal(pushesTo(ANNA).length, 0);
  await tickLifecycle(new Date(NOW.getTime() + 19.5 * HOUR));
  assert.equal(pushesTo(ANNA)[0]?.data.type, "invite_reminder");
});

test("opt-out: lifecycle=false sends nothing; the switch goes round /me/notifications", async () => {
  const token = await login(ANNA);
  await User.updateOne({ phone: ANNA }, { pushToken: "ExponentPushToken[1111]", timezone: "Europe/Berlin", "milestones.verifiedAt": ago(30 * HOUR) });

  let prefs = (await request(ctx.app).get("/me/notifications").set(auth(token)).expect(200)).body.prefs;
  assert.equal(prefs.lifecycle, true, "on by default");
  await request(ctx.app).put("/me/notifications").set(auth(token)).send({ lifecycle: "nein" }).expect(400);
  prefs = (await request(ctx.app).put("/me/notifications").set(auth(token)).send({ lifecycle: false }).expect(200)).body.prefs;
  assert.equal(prefs.lifecycle, false);
  assert.equal((await request(ctx.app).get("/me/notifications").set(auth(token)).expect(200)).body.prefs.lifecycle, false);

  await tickLifecycle(NOW);
  assert.equal(fakes.expoPushes.length, 0);
  // Through the catalog too
  assert.equal((await notify(ANNA, "invite_reminder", { lifecycleKey: "invite_reminder" }, { now: NOW })).skipped, "opted_out");
});

test("idempotent: two leaders at once and a leader change send each stage once", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(30 * HOUR) } });
  await person(BEN, { plus: { active: false, source: "store", status: "billing_issue", eventAt: ago(HOUR) } });

  // Two instances overlapping during a deploy, both ticking
  await Promise.all([tickLifecycle(NOW), tickLifecycle(NOW)]);
  assert.equal(pushesTo(ANNA).length, 1);
  assert.equal(pushesTo(BEN).length, 1);

  // The leader changes: instance A held the lease, it ran out, B takes over
  await Lock.syncIndexes();
  const job = () => tickLifecycle(new Date(NOW.getTime() + 30 * 60 * 1000));
  assert.ok(await asLeader("jobs-lifecycle-test", job, { owner: "instance-a" }));
  assert.equal(await asLeader("jobs-lifecycle-test", job, { owner: "instance-b" }), undefined, "B waits while A holds the lease");
  await Lock.updateOne({ key: "jobs-lifecycle-test" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.ok(await asLeader("jobs-lifecycle-test", job, { owner: "instance-b" }));
  assert.equal(pushesTo(ANNA).length, 1);
  assert.equal(pushesTo(BEN).length, 1);
  assert.equal(await PushDecision.countDocuments({ result: "sent" }), 2);
});

test("plus_expiring: three days before a present ends, once per end date; not for store plans or later ends", async () => {
  const until = new Date(NOW.getTime() + 2.5 * DAY);
  await person(ANNA, { plus: { active: true, source: "waitlist", until } });
  await person(BEN, { plus: { active: true, source: "admin", until: new Date(NOW.getTime() + 5 * DAY) } });
  await person(CARL, { plus: { active: true, source: "store", status: "active", until } });

  await tickLifecycle(NOW);
  await tickLifecycle(new Date(NOW.getTime() + HOUR));
  const pushes = pushesTo(ANNA);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].data.type, "plus_expiring");
  assert.equal(pushes[0].data.url, "/plus?from=plus_expiring");
  const label = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" }).format(until);
  assert.match(label, /^Samstag, \d+\. /);
  assert.ok(pushes[0].body.includes(`am ${label} aus`), pushes[0].body);
  assert.equal(pushesTo(BEN).length + pushesTo(CARL).length, 0);

  // A new present with a new end date gets its own reminder
  const later = new Date(NOW.getTime() + 10 * DAY);
  await User.updateOne({ phone: ANNA }, { "plus.until": new Date(later.getTime() + 2.5 * DAY) });
  await tickLifecycle(later);
  assert.equal(pushesTo(ANNA).length, 2);
});

test("billing_issue: once per store event, opens /plus with the hint in the text; cancel and win-back deep links", async () => {
  await person(ANNA, { plus: { active: true, source: "store", status: "billing_issue", eventAt: ago(2 * HOUR), until: new Date(NOW.getTime() + 10 * DAY) } });
  await tickLifecycle(NOW);
  await tickLifecycle(new Date(NOW.getTime() + HOUR));
  const [push, ...more] = pushesTo(ANNA);
  assert.equal(more.length, 0);
  assert.equal(push.data.type, "billing_issue");
  assert.equal(push.data.url, "/plus?from=billing_issue");
  assert.match(push.body, /Apple-ID/);

  // Cancelled, and a store plan that ran out three days ago
  await person(BEN, { plus: { active: true, source: "store", status: "cancelled", eventAt: ago(HOUR) } });
  await person(CARL, { plus: { active: false, source: "store", status: "expired", until: ago(3.5 * DAY), eventAt: ago(3.5 * DAY) } });
  await person(DORA, { plus: { active: false, source: "store", status: "expired", until: ago(31 * DAY), eventAt: ago(31 * DAY) } });
  await tickLifecycle(NOW);
  assert.equal(pushesTo(BEN)[0].data.url, "/plus?from=cancel");
  assert.equal(pushesTo(BEN)[0].data.type, "cancel_survey");
  assert.equal(pushesTo(CARL)[0].data.url, "/plus?from=plus_winback_3");
  assert.equal(pushesTo(DORA)[0].data.url, "/plus?from=plus_winback_30");
});

test("POST /me/state: validates, stores, writes again only on a change or after two hours", async () => {
  const token = await login(ANNA);
  await request(ctx.app).post("/me/state").set(auth(token)).send({}).expect(400);
  const bad = await request(ctx.app).post("/me/state").set(auth(token)).send({ notifications: "maybe" }).expect(400);
  assert.equal(bad.body.error, "invalid_notifications");
  await request(ctx.app).post("/me/state").set(auth(token)).send({ notifications: "granted", contactsPermission: 1 }).expect(400);
  // Token only: no legacy claimed phone on a new route
  await request(ctx.app).post("/me/state").send({ phone: ANNA, notifications: "granted" }).expect(401);

  const first = (await request(ctx.app).post("/me/state").set(auth(token)).send({ notifications: "granted", contactsPermission: "denied" }).expect(200)).body;
  assert.equal(first.success, true);
  assert.equal(first.device.notifications, "granted");
  assert.equal(first.device.contactsPermission, "denied");
  const at = new Date(first.device.at).getTime();

  // Same values right after: nothing written
  const same = (await request(ctx.app).post("/me/state").set(auth(token)).send({ notifications: "granted", contactsPermission: "denied" }).expect(200)).body;
  assert.equal(new Date(same.device.at).getTime(), at);
  // One value changed: written, the other stays
  const changed = (await request(ctx.app).post("/me/state").set(auth(token)).send({ contactsPermission: "granted" }).expect(200)).body;
  assert.deepEqual([changed.device.notifications, changed.device.contactsPermission], ["granted", "granted"]);
  // Two hours old: refreshed even without a change
  await User.updateOne({ phone: ANNA }, { "device.at": new Date(Date.now() - 2 * HOUR - 1000) });
  const refreshed = (await request(ctx.app).post("/me/state").set(auth(token)).send({ notifications: "granted" }).expect(200)).body;
  assert.ok(Date.now() - new Date(refreshed.device.at).getTime() < 60 * 1000);

  // The export shows it
  const exported = (await request(ctx.app).get("/me/export").set(auth(token)).expect(200)).body.data;
  assert.equal(exported.devices.permissions.contacts, "granted");
});

test("measurement: sent per type, active the next day and a talk within 48 hours, from the decisions of T, T-1 and T-2", async () => {
  const day = berlinDay(NOW);
  const [dayBefore, twoBefore] = [shiftDateKey(day, -1), shiftDateKey(day, -2)];
  const at = (d, h) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
  await PushDecision.create([
    { to: ANNA, type: "invite_reminder", result: "sent", at: at(day, 10) },
    { to: BEN, type: "invite_reminder", result: "quiet_hours", at: at(day, 10) },
    { to: ANNA, type: "contact_available", result: "sent", at: at(day, 10) },
    // The day before: two come_backs, one of them came back on T
    { to: BEN, type: "come_back", result: "sent", at: at(dayBefore, 10) },
    { to: CARL, type: "come_back", result: "sent", at: at(dayBefore, 10) },
    // Two days before: a hint, followed by a talk 30 hours later
    { to: DORA, type: "first_call_hint", result: "sent", at: at(twoBefore, 10) },
    { to: CARL, type: "first_call_hint", result: "sent", at: at(twoBefore, 10) },
  ]);
  await activeOn(BEN, day);
  await Talk.create({ callId: "m1", participants: [DORA, ANNA], startedAt: at(dayBefore, 16), seconds: 120 });

  const result = await lifecycleDay(day);
  assert.deepEqual(result.sentByType, { invite_reminder: 1 });
  assert.deepEqual(result.activeNextDay, { come_back: { sent: 2, active: 1 } });
  assert.deepEqual(result.talk48h, { first_call_hint: { sent: 2, talked: 1 } });
});

test("billing_issue: a CANCELLATION for a failed payment gives exactly one billing_issue and no cancel_survey; a refund gives nothing", async () => {
  let n = 0;
  const event = (user, type, at, extra = {}) => ({
    id: `lc-${++n}`,
    type,
    app_user_id: String(user._id),
    product_id: "wannayap_plus_monthly",
    store: "APP_STORE",
    environment: "PRODUCTION",
    period_type: "NORMAL",
    event_timestamp_ms: at.getTime(),
    purchased_at_ms: ago(10 * DAY).getTime(),
    expiration_at_ms: NOW.getTime() + 20 * DAY,
    ...extra,
  });
  const apply = async (user, type, at, extra) => assert.equal((await applyEvent(event(user, type, at, extra), NOW)).result, "ok");
  const anna = await person(ANNA);
  const ben = await person(BEN);
  const carl = await person(CARL);
  const dora = await person(DORA);
  for (const user of [anna, ben, carl, dora]) await apply(user, "INITIAL_PURCHASE", ago(10 * DAY));

  // Anna: BILLING_ISSUE, a tick, then RevenueCat's CANCELLATION with BILLING_ERROR
  await apply(anna, "BILLING_ISSUE", ago(3 * HOUR));
  await tickLifecycle(NOW);
  await apply(anna, "CANCELLATION", ago(2 * HOUR), { cancel_reason: "BILLING_ERROR" });
  // Ben: both arrive before the next tick, the CANCELLATION last (it wins the status)
  await apply(ben, "BILLING_ISSUE", ago(3 * HOUR));
  await apply(ben, "CANCELLATION", ago(2 * HOUR), { cancel_reason: "BILLING_ERROR" });
  assert.equal((await User.findOne({ phone: BEN })).plus.status, "cancelled");
  // Carl: Apple's support refunded; Dora cancelled herself
  await apply(carl, "CANCELLATION", ago(2 * HOUR), { cancel_reason: "CUSTOMER_SUPPORT" });
  await apply(dora, "CANCELLATION", ago(2 * HOUR), { cancel_reason: "UNSUBSCRIBE" });

  await tickLifecycle(new Date(NOW.getTime() + 30 * 60 * 1000));
  await tickLifecycle(new Date(NOW.getTime() + 60 * 60 * 1000));
  const types = (phone) => pushesTo(phone).map((p) => p.data.type);
  assert.deepEqual(types(ANNA), ["billing_issue"]);
  assert.deepEqual(types(BEN), ["billing_issue"]);
  assert.deepEqual(types(CARL), []);
  assert.deepEqual(types(DORA), ["cancel_survey"]);
  assert.equal(pushesTo(DORA)[0].data.url, "/plus?from=cancel");
});

test("Expo unreachable: the stage and the cap stay free, the next tick sends it", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(30 * HOUR) } });
  fakes.failExpo = true;
  assert.deepEqual(await tickLifecycle(NOW), { sent: 0, byType: {} });
  assert.equal((await User.findOne({ phone: ANNA })).lifecycle?.sent?.get("invite_reminder"), undefined);
  assert.equal(await PushLog.countDocuments({ to: ANNA }), 0, "no cap used up");
  assert.equal(await PushDecision.countDocuments({ to: ANNA, result: "failed" }), 1);

  fakes.failExpo = false;
  await tickLifecycle(new Date(NOW.getTime() + 30 * 60 * 1000));
  assert.deepEqual(pushesTo(ANNA).map((p) => p.data.type), ["invite_reminder"]);
});

test("measurement: a recount of yesterday keeps talk48h from the final snapshot, not from a partial one", async () => {
  const day = shiftDateKey(berlinDay(new Date()), -1);
  const talk48h = { first_call_hint: { sent: 2, talked: 1 } };
  const stored = (partial) => ({ day, partial, version: METRICS_VERSION - 1, users: { total: 1 }, lifecycle: { sentByType: { come_back: 3 }, activeNextDay: {}, talk48h } });

  // Final: the decisions of T-2 are gone, the stored count stays
  await MetricsDaily.create(stored(false));
  let doc = await saveDay(day, new Date());
  assert.deepEqual(doc.lifecycle.talk48h, talk48h);
  assert.deepEqual(doc.lifecycle.sentByType, {}, "the decisions of T itself are still there: counted again");

  // Partial (taken during T): counted again
  await MetricsDaily.deleteMany({});
  await MetricsDaily.create(stored(true));
  doc = await saveDay(day, new Date());
  assert.deepEqual(doc.lifecycle.talk48h, {});
});

test("onboarding stages only for new accounts: an older account signing in again gets none of them", async () => {
  const longAgo = ago(200 * DAY);
  // Anna: an account of 200 days, new device, verifiedAt set on this sign-in
  await person(ANNA, { _id: idAt(longAgo), milestones: { verifiedAt: ago(30 * HOUR) } });
  // Ben: an older account on day 3, with a talk from before the milestones
  await person(BEN, { _id: idAt(longAgo), milestones: { verifiedAt: ago(3.5 * DAY) } });
  await person(CARL, { name: "Carl", lastOnline: ago(HOUR) });
  // Dora: new, but a talk without firstTalkAt (the milestone was not written)
  await person(DORA, { milestones: { verifiedAt: ago(3.5 * DAY) } });
  await befriend(BEN, CARL, DORA);
  await Talk.create([
    { callId: "o1", participants: [BEN, CARL], startedAt: ago(100 * DAY), seconds: 600 },
    { callId: "o2", participants: [DORA, CARL], startedAt: ago(2 * DAY), seconds: 120 },
  ]);
  // Eva: older account on day 7; Fred: new on day 7 (the control)
  const EVA = "+4915555555555";
  const FRED = "+4915666666666";
  await person(EVA, { _id: idAt(longAgo), milestones: { verifiedAt: ago(7.5 * DAY) } });
  await person(FRED, { milestones: { verifiedAt: ago(7.5 * DAY) } });
  const at = new Date(NOW.getTime() + 40 * 60 * 1000);
  await DailyMoment.create({ day: berlinDay(NOW), zone: "Europe/Berlin", at, endsAt: new Date(at.getTime() + 10 * 60 * 1000) });

  assert.equal(isNewAccount(await User.findOne({ phone: ANNA })), false);
  assert.equal(isNewAccount(await User.findOne({ phone: FRED })), true);
  await tickLifecycle(NOW);
  assert.deepEqual(fakes.expoPushes.map((p) => p.data.type), ["yap_moment_invite"]);
  assert.equal(pushesTo(FRED).length, 1);
});

test("spacing: two stages due at once go out a day apart; during the onboarding the inactivity stages wait", async () => {
  const today = berlinDay(NOW);
  // Anna, an older account: her present ends in 2.5 days and she was away 15 days
  await person(ANNA, { _id: idAt(ago(300 * DAY)), plus: { active: true, source: "referral", until: new Date(NOW.getTime() + 2.5 * DAY) } });
  await activeOn(ANNA, shiftDateKey(today, -15));
  // Ben, new on day 3, idle since the sign-up, Carl is available
  await person(BEN, { milestones: { verifiedAt: ago(3.5 * DAY) } });
  await person(CARL, { name: "Carl", isAvailable: true, lastOnline: ago(HOUR) });
  await befriend(BEN, CARL);
  await activeOn(BEN, shiftDateKey(today, -4));

  await tickLifecycle(NOW);
  assert.deepEqual(pushesTo(ANNA).map((p) => p.data.type), ["plus_expiring"]);
  assert.deepEqual(pushesTo(BEN).map((p) => p.data.type), ["first_call_hint"]);
  assert.equal((await User.findOne({ phone: ANNA })).lifecycle.sent.get(`come_back:${shiftDateKey(today, -15)}`), undefined, "held, not used up");
  // Directly through the catalog the spacing holds as well
  assert.equal((await notify(ANNA, "come_back_30", { lifecycleKey: "come_back_30:x" }, { now: new Date(NOW.getTime() + HOUR) })).skipped, "lifecycle_spacing");

  // Twelve hours later still within the day; 25 hours later come_back follows inside its window
  await tickLifecycle(new Date(NOW.getTime() + 12 * HOUR + 30 * 60 * 1000));
  await tickLifecycle(new Date(NOW.getTime() - 4 * HOUR + DAY));
  assert.equal(pushesTo(ANNA).length, 1);
  await tickLifecycle(new Date(NOW.getTime() + 25 * HOUR));
  assert.deepEqual(pushesTo(ANNA).map((p) => p.data.type), ["plus_expiring", "come_back"]);
  // Ben is in his onboarding: no friends_were_available on top of the hint
  assert.deepEqual(pushesTo(BEN).map((p) => p.data.type), ["first_call_hint"]);
});

test("week_open: the zone of the schedule counts when the account has no top-level one", async () => {
  const laAt = (dateKey, hh, mm) =>
    ["-07:00", "-08:00"].map((o) => new Date(`${dateKey}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00${o}`)).find((d) => localParts(d, "America/Los_Angeles").minutes === hh * 60 + mm);
  const sundayKey = shiftDateKey(berlinDay(NOW), 4);
  const sunday = laAt(sundayKey, 16, 10);
  await person(ANNA, { timezone: null, schedule: { timezone: "America/Los_Angeles" }, milestones: { verifiedAt: ago(30 * DAY, sunday), firstTalkAt: ago(20 * DAY, sunday) } });
  await Talk.create([
    { callId: "w1", participants: [ANNA, CARL], startedAt: ago(7 * DAY, sunday), seconds: 300 },
    { callId: "w2", participants: [ANNA, CARL], startedAt: ago(14 * DAY, sunday), seconds: 300 },
  ]);

  // Sunday 16:10 in Berlin is morning in Los Angeles: not hers
  await tickLifecycle(berlinAt(sundayKey, 16, 10));
  assert.equal(pushesTo(ANNA).length, 0);
  await tickLifecycle(sunday);
  assert.deepEqual(pushesTo(ANNA).map((p) => p.data.type), ["week_open"]);
});

test("robust: a token Expo never takes costs no claim and no rows; one failing stage does not stop the others", async () => {
  await person(ANNA, { milestones: { verifiedAt: ago(30 * HOUR) }, pushToken: "kein-token" });
  await tickLifecycle(NOW);
  assert.equal(await PushDecision.countDocuments({}), 0);
  assert.equal((await User.findOne({ phone: ANNA })).lifecycle?.sent?.get("invite_reminder"), undefined);

  await person(BEN, { milestones: { verifiedAt: ago(30 * HOUR) } });
  const first = RULES[0];
  const original = first.select;
  first.select = async () => {
    throw new Error("query failed");
  };
  try {
    await tickLifecycle(NOW);
  } finally {
    first.select = original;
  }
  assert.deepEqual(pushesTo(BEN).map((p) => p.data.type), ["invite_reminder"]);
});

test("lifecycle pushes do not use up the daily social cap", async () => {
  await person(ANNA);
  await PushLog.create([
    { to: ANNA, key: "lifecycle:plus_expiring:x", sentAt: ago(HOUR), expiresAt: new Date(NOW.getTime() + 6 * DAY) },
    ...Array.from({ length: DAILY_SOCIAL_CAP - 1 }, (_, i) => ({ to: ANNA, key: `social-${i}`, sentAt: ago(HOUR), expiresAt: new Date(NOW.getTime() + DAY) })),
  ]);
  assert.equal((await notify(ANNA, "contact_available", { phone: BEN, name: "Ben" }, { now: NOW })).sent, true);
  assert.equal((await notify(ANNA, "moment_shared", { phone: CARL, name: "Carl" }, { now: NOW })).skipped, "daily_cap");
});
