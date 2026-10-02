// Paywall funnel and plan limits (plan 2.6a): POST /me/plus/funnel counts
// steps per day and source, every refusal by a plan limit counts as a limit
// hit, computeDay writes MetricsDaily.plus.funnel and plus.limitHits, the
// trial_ending push goes out once and outside the lifecycle cap, and the
// alert purchase_failures fires from the fourth failure of a day.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { Types } = require("mongoose");
const { setup, teardown, reset, fakes, befriend } = require("./helpers");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const PushLog = require("../models/PushLog");
const AlertState = require("../models/AlertState");
const opsCounters = require("../lib/opsCounters");
const alerts = require("../lib/alerts");
const paywall = require("../lib/paywall");
const { computeDay, todayKey, METRICS_VERSION } = require("../lib/metrics");
const { resetLimitsCache, limitError } = require("../lib/plan");
const { endStaleRooms } = require("../lib/circles");
const { tickLifecycle } = require("../lib/lifecycle");
const { notify, LIFECYCLE_CAP } = require("../lib/notify");
const { saveConfig } = require("../lib/appConfig");
const { localParts, shiftDateKey } = require("../lib/localTime");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
  await AlertState.syncIndexes();
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const DORA = "+4915444444444";
const EMIL = "+4915555555555";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Fire-and-forget counters land a moment after the response
const settle = () => new Promise((r) => setTimeout(r, 80));
const today = () => opsCounters.countsOf(todayKey());

async function login(phone, name = "X") {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: "Europe/Berlin" });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const funnel = (token, body) => request(ctx.app).post("/me/plus/funnel").set(auth(token)).send(body);

test("funnel: needs a token, refuses unknown steps, counts steps and views and purchases per source", async () => {
  await request(ctx.app).post("/me/plus/funnel").send({ step: "paywall_view", from: "settings" }).expect(401);
  const anna = await login(ANNA);

  for (const bad of [{}, { step: "paywallView" }, { step: "bought" }, { step: ["paywall_view"] }]) {
    assert.deepEqual((await funnel(anna, bad).expect(400)).body, { success: false, error: "invalid_step" });
  }
  assert.deepEqual((await funnel(anna, { step: "paywall_view", from: "settings" }).expect(200)).body, { success: true });
  await funnel(anna, { step: "paywall_view", from: "limit_circles" }).expect(200);
  await funnel(anna, { step: "paywall_view", from: "limit_circles" }).expect(200);
  await funnel(anna, { step: "purchase_start", from: "limit_circles" }).expect(200);
  await funnel(anna, { step: "purchase_success", from: "limit_circles" }).expect(200);
  await funnel(anna, { step: "purchase_cancel", from: "settings" }).expect(200);
  await funnel(anna, { step: "offering_empty", from: "plus_winback_30" }).expect(200);
  // An unknown or missing source is "other"
  await funnel(anna, { step: "paywall_view", from: "somewhere" }).expect(200);
  await funnel(anna, { step: "paywall_view" }).expect(200);
  await funnel(anna, { step: "paywall_view", from: { $gt: "" } }).expect(200);

  const c = await today();
  assert.equal(c.paywallView, 6);
  assert.equal(c.purchaseStart, 1);
  assert.equal(c.purchaseSuccess, 1);
  assert.equal(c.purchaseCancel, 1);
  assert.equal(c.offeringEmpty, 1);
  assert.equal(c.paywallViewFromSettings, 1);
  assert.equal(c.paywallViewFromLimitCircles, 2);
  assert.equal(c.purchaseSuccessFromLimitCircles, 1);
  assert.equal(c.paywallViewFromOther, 3);
  // Only views and purchases are counted per source
  assert.equal(c.purchaseStartFromLimitCircles, undefined);
  assert.equal(c.offeringEmptyFromPlusWinback30, undefined);
  assert.ok(Object.keys(c).every((name) => !name.includes("_")), "counter names without underscores");

  // The contract with the app
  assert.deepEqual(paywall.STEPS, ["paywall_view", "purchase_start", "purchase_success", "purchase_cancel", "purchase_error", "restore_success", "restore_error", "offering_empty"]);
  for (const from of ["settings", "memories", "appicon", "year", "room", "limit_circles", "limit_rituals", "limit_members", "limit_moments", "referral", "plus_expiring", "billing_issue", "plus_winback_3", "plus_winback_30", "cancel", "trial_ending", "push", "other"]) {
    assert.ok(paywall.SOURCES.includes(from), from);
    assert.match(paywall.sourceCounter("purchase_success", from), /^[a-zA-Z][a-zA-Z0-9]{0,39}$/);
  }
});

test("limit hits: circles, a full circle, a full round, a round ended by time, video and moments are counted per limit", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  // The fourth own circle (free: 3)
  for (const name of ["A", "B", "C"]) await request(ctx.app).post("/circles").set(auth(anna)).send({ name }).expect(200);
  await request(ctx.app).post("/circles").set(auth(anna)).send({ name: "D" }).expect(403);
  // A full circle (free: 12 people)
  const many = (n) => Array.from({ length: n }, (_, i) => ({ phone: `+49160000${String(i).padStart(4, "0")}` }));
  const circle = await Circle.create({ name: "Voll", createdBy: ANNA, members: [{ phone: ANNA }, ...many(11)], code: "FULLFULL" });
  await request(ctx.app).post("/circles/join").set(auth(ben)).send({ code: "FULLFULL" }).expect(400);
  // A full round (free: 6 inside)
  await Circle.updateOne({ _id: circle._id }, { $push: { members: { phone: BEN } } });
  const full = await Room.create({ circleId: circle._id, channel: "room_full", startedBy: ANNA, participants: many(6).map((m) => ({ ...m, joinedAt: new Date() })) });
  await request(ctx.app).post(`/rooms/${full._id}/join`).set(auth(ben)).expect(403);
  // A round past its time, and one that only crashed (no limit)
  await Room.create({ circleId: circle._id, channel: "room_time", startedBy: ANNA, endsAt: new Date(Date.now() - 1000), participants: [{ phone: ANNA, joinedAt: new Date() }] });
  await Room.updateOne({ _id: full._id }, { createdAt: new Date(Date.now() - 5 * HOUR) });
  assert.equal((await endStaleRooms()).length, 2);
  // Video off for free: the call starts as audio and counts
  await befriend(ANNA, BEN);
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[Ben]" });
  assert.equal((await saveConfig({ limits: { free: { video: false } } }, "test")).error, undefined);
  resetLimitsCache();
  const call = await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_video" });
  assert.equal(call.videoDowngraded, "plan_limit", JSON.stringify(call));
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_video" });
  // Any limitError counts, e.g. the moments of a day
  assert.equal(limitError("momentsPerDay", 30, 100).error, "plan_limit");
  await settle();

  const c = await today();
  assert.equal(c.limitHitCircles, 1);
  assert.equal(c.limitHitCircleMembers, 1);
  assert.equal(c.limitHitRoomParticipants, 1);
  assert.equal(c.limitHitRoomMinutes, 1, "only the round ended by time");
  assert.equal(c.limitHitVideo, 1);
  assert.equal(c.limitHitMomentsPerDay, 1);
});

test("computeDay: plus.funnel with the sources and plus.limitHits from the day counters", async () => {
  const now = new Date();
  for (const [name, n] of Object.entries({
    paywallView: 12, purchaseStart: 4, purchaseSuccess: 2, purchaseCancel: 1, purchaseError: 1, restoreSuccess: 1, restoreError: 0, offeringEmpty: 3,
    paywallViewFromSettings: 7, paywallViewFromLimitCircles: 5, purchaseSuccessFromLimitCircles: 2, paywallViewFromTrialEnding: 0,
    limitHitCircles: 2, limitHitRoomMinutes: 1, limitHitVideo: 4,
  })) {
    if (n) await opsCounters.count(name, now, n);
  }
  const doc = await computeDay(todayKey(now), now);
  assert.equal(METRICS_VERSION, 6);
  assert.equal(doc.version, 6);
  const { bySource, ...steps } = doc.plus.funnel;
  assert.deepEqual(steps, { paywallView: 12, purchaseStart: 4, purchaseSuccess: 2, purchaseCancel: 1, purchaseError: 1, restoreSuccess: 1, restoreError: 0, offeringEmpty: 3 });
  assert.deepEqual(bySource, { settings: { view: 7, success: 0 }, limit_circles: { view: 5, success: 2 } });
  assert.deepEqual(doc.plus.limitHits, { circles: 2, roomMinutes: 1, video: 4 });

  // An empty day: zeros, no sources, no hits
  const empty = await computeDay(shiftDateKey(todayKey(now), -3), now);
  assert.equal(empty.plus.funnel.paywallView, 0);
  assert.deepEqual(empty.plus.funnel.bySource, {});
  assert.deepEqual(empty.plus.limitHits, {});
});

// The next Wednesday, 14:00 in Berlin (as in lifecycle.test.js): no quiet
// hours, and every row lies ahead of the real clock
const berlinDay = (date) => localParts(date, "Europe/Berlin").dateKey;
function berlinAt(dateKey, hh) {
  const clock = `${String(hh).padStart(2, "0")}:00`;
  return ["+02:00", "+01:00"].map((offset) => new Date(`${dateKey}T${clock}:00${offset}`)).find((d) => localParts(d, "Europe/Berlin").minutes === hh * 60);
}
const NOW = (() => {
  const real = new Date();
  const wait = (3 - localParts(real, "Europe/Berlin").day + 7) % 7 || 7;
  return berlinAt(shiftDateKey(berlinDay(real), wait), 14);
})();
const person = (phone, fields = {}) =>
  User.create({
    _id: new Types.ObjectId(Math.floor((NOW.getTime() - 60 * DAY) / 1000)),
    phone,
    name: phone.slice(-4),
    phoneHmac: User.hmacPhone(phone),
    pushToken: `ExponentPushToken[${phone.slice(-4)}]`,
    timezone: "Europe/Berlin",
    ...fields,
  });
const pushesTo = (phone) => fakes.expoPushes.filter((p) => p.to === `ExponentPushToken[${phone.slice(-4)}]`);
const trial = (until) => ({ plus: { active: true, source: "store", status: "trial", until, eventAt: new Date(NOW.getTime() - 5 * DAY) } });

test("trial_ending: one to two days before a trial ends, once per end date, outside the cap; not without a trial, not opted out", async () => {
  const until = new Date(NOW.getTime() + 1.5 * DAY); // Friday 02:00: "übermorgen"
  await person(ANNA, trial(until));
  await person(BEN, { plus: { active: true, source: "store", status: "active", until } });
  await person(CARL, trial(new Date(NOW.getTime() + 3 * DAY)));
  // Two lifecycle pushes this week: the cap is full, the notice still goes out
  await person(DORA, trial(until));
  for (const [i, key] of ["come_back:a", "week_open:b"].entries()) {
    await PushLog.create({ to: DORA, key: `lifecycle:${key}`, sentAt: new Date(NOW.getTime() - (2 + i) * DAY), expiresAt: new Date(NOW.getTime() + 4 * DAY) });
  }
  await person(EMIL, { ...trial(until), notificationPrefs: { lifecycle: false } });

  await tickLifecycle(NOW);
  await tickLifecycle(new Date(NOW.getTime() + HOUR));
  const [push, ...more] = pushesTo(ANNA);
  assert.equal(more.length, 0, "once per end date");
  assert.equal(push.data.type, "trial_ending");
  assert.equal(push.data.url, "/plus?from=trial_ending");
  assert.equal(push.title, "Deine Probezeit endet übermorgen");
  assert.match(push.body, /Kündigen geht jederzeit in den iPhone-Einstellungen/);
  assert.ok((await User.findOne({ phone: ANNA })).lifecycle.sent.get(`trial_ending:${until.toISOString().slice(0, 10)}`));
  assert.equal(pushesTo(BEN).length + pushesTo(CARL).length + pushesTo(EMIL).length, 0);

  assert.equal(LIFECYCLE_CAP, 2);
  assert.deepEqual(pushesTo(DORA).map((p) => p.data.type), ["trial_ending"]);
  // It uses up nothing: no lifecycle row, so the cap and the spacing stay as they were
  assert.equal(await PushLog.countDocuments({ to: { $in: [ANNA, DORA] }, key: /^lifecycle:trial_ending/ }), 0);
  assert.equal((await notify(DORA, "come_back", { lifecycleKey: "come_back:x" }, { now: NOW })).skipped, "lifecycle_cap", "the cap still holds for the rest");

  // A day later Anna's end is less than a day away (nothing more); Carl's turn comes
  fakes.expoPushes.length = 0;
  await tickLifecycle(new Date(NOW.getTime() + 1.2 * DAY));
  assert.equal(pushesTo(ANNA).length, 0);
  assert.equal(pushesTo(CARL)[0]?.data.type, "trial_ending");
  assert.equal(pushesTo(CARL)[0].title, "Deine Probezeit endet übermorgen");

  // Quiet hours hold: 23:00 sends nothing
  await person("+4915666666666", trial(new Date(NOW.getTime() + 1.6 * DAY)));
  fakes.expoPushes.length = 0;
  await tickLifecycle(new Date(NOW.getTime() + 9 * HOUR));
  assert.equal(pushesTo("+4915666666666").length, 0);
});

test("alert purchase_failures: from the fourth failure of the day, cancels don't count", async () => {
  const anna = await login(ANNA);
  const failures = () => alerts.runRules(new Date(), { uptimeSec: 0 }).then((fired) => fired.includes("purchase_failures"));
  await funnel(anna, { step: "purchase_error", from: "settings" }).expect(200);
  await funnel(anna, { step: "restore_error", from: "settings" }).expect(200);
  await funnel(anna, { step: "offering_empty", from: "room" }).expect(200);
  for (let i = 0; i < 5; i++) await funnel(anna, { step: "purchase_cancel", from: "settings" }).expect(200);
  assert.equal(await failures(), false, "three failures are no alarm");

  await funnel(anna, { step: "purchase_error", from: "limit_circles" }).expect(200);
  assert.equal(await failures(), true);
  const state = await AlertState.findOne({ tag: "purchase_failures" }).lean();
  assert.equal(state.level, "warn");
  assert.equal(state.lastText, "Heute 2× Kauf fehlgeschlagen, 1× Wiederherstellen fehlgeschlagen, 1× kein Angebot geladen. Konsole → Plus, App Store Connect-Status und RevenueCat prüfen.");
});
