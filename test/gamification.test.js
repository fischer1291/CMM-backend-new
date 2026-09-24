const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const { parseSchedule, activeSlot, nextSlot, applySchedules } = require("../lib/schedule");
const { weekKey, localParts } = require("../lib/localTime");
const { expireMoments } = require("../routes/moment");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const TZ = "Europe/Berlin";
const HOUR = 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  if (name) await User.updateOne({ phone }, { name });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** a and b know each other (both have the other in their contacts). */
const befriend = (a, b) =>
  Promise.all([
    User.updateOne({ phone: a }, { $addToSet: { contacts: b } }),
    User.updateOne({ phone: b }, { $addToSet: { contacts: a } }),
  ]);

const talk = (callId, a, b, startedAt, minutes) =>
  Talk.create({ callId, participants: [a, b], startedAt, seconds: minutes * 60 });

// Wednesday 2026-09-23, 18:30 in Berlin (CEST, UTC+2)
const WED_1830 = new Date("2026-09-23T16:30:00Z");

test("localTime: local parts and Monday-based weeks respect the zone", () => {
  assert.deepEqual(localParts(WED_1830, TZ), { dateKey: "2026-09-23", day: 3, minutes: 18 * 60 + 30 });
  assert.equal(weekKey(WED_1830, TZ), "2026-09-21");
  // Sunday 23:30 in Berlin is already Monday in Tokyo
  const sundayLate = new Date("2026-09-27T21:30:00Z");
  assert.equal(weekKey(sundayLate, TZ), "2026-09-21");
  assert.equal(weekKey(sundayLate, "Asia/Tokyo"), "2026-09-28");
});

test("schedule: validation rejects bad zones, short and overlapping slots", () => {
  const base = { enabled: true, timezone: TZ };
  assert.ok(parseSchedule({ ...base, timezone: "Mars/Base" }).error);
  assert.ok(parseSchedule({ ...base, slots: [{ day: 7, start: 0, end: 60 }] }).error);
  assert.ok(parseSchedule({ ...base, slots: [{ day: 1, start: 600, end: 610 }] }).error);
  assert.ok(
    parseSchedule({ ...base, slots: [{ day: 1, start: 600, end: 700 }, { day: 1, start: 650, end: 800 }] }).error,
  );
  const ok = parseSchedule({ ...base, slots: [{ day: 3, start: 1080, end: 1200 }, { day: 1, start: 60, end: 120 }] });
  assert.deepEqual(ok.value.slots.map((s) => s.day), [1, 3]);
});

test("schedule: active and next slot in the user's zone", () => {
  const schedule = { enabled: true, timezone: TZ, slots: [{ day: 3, start: 18 * 60, end: 20 * 60 }] };
  const slot = activeSlot(schedule, WED_1830);
  assert.equal(slot.key, "2026-09-23|1080");
  assert.equal(slot.endsAt.toISOString(), "2026-09-23T18:00:00.000Z");
  assert.equal(activeSlot({ ...schedule, enabled: false }, WED_1830), null);
  assert.equal(activeSlot({ ...schedule, timezone: "Asia/Tokyo" }, WED_1830), null);

  const next = nextSlot(schedule, WED_1830);
  assert.equal(next.day, 3);
  assert.equal(next.inMinutes, 7 * 24 * 60 - 30);
});

test("schedule: API saves the plan; the job makes the user available once per slot", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN);
  await befriend(ANNA, BEN);
  await request(ctx.app).get("/me/schedule").expect(401);
  await request(ctx.app).put("/me/schedule").set(auth(anna)).send({ enabled: true, timezone: "x", slots: [] }).expect(400);

  const saved = await request(ctx.app)
    .put("/me/schedule")
    .set(auth(anna))
    .send({ enabled: true, timezone: TZ, slots: [{ day: 3, start: 18 * 60, end: 20 * 60 }] })
    .expect(200);
  assert.equal(saved.body.schedule.slots.length, 1);

  const announced = [];
  assert.equal(await applySchedules(async (u) => announced.push(u.phone), WED_1830), 1);
  let user = await User.findOne({ phone: ANNA });
  assert.equal(user.isAvailable, true);
  assert.equal(user.availableSource, "schedule");
  assert.equal(user.momentActiveUntil.toISOString(), "2026-09-23T18:00:00.000Z");
  assert.deepEqual(announced, [ANNA]);

  // Switching off by hand during the slot sticks
  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: false }).expect(200);
  assert.equal(await applySchedules(async () => {}, new Date(WED_1830.getTime() + 10 * 60 * 1000)), 0);
  user = await User.findOne({ phone: ANNA });
  assert.equal(user.isAvailable, false);

  // Slot end: the expiry job takes over
  await applySchedules(async () => {}, new Date(WED_1830.getTime() + 7 * 24 * HOUR));
  await User.updateOne({ phone: ANNA }, { momentActiveUntil: new Date(Date.now() - 1000) });
  assert.equal(await expireMoments(ctx.io), 1);
  assert.equal((await User.findOne({ phone: ANNA })).availableSource, null);
});

test("sessions: /moment/confirm accepts 15/30/60/120 minutes, rejects others", async () => {
  const anna = await login(ANNA);
  await request(ctx.app).post("/moment/confirm").set(auth(anna)).send({ mood: "😊", minutes: 45 }).expect(400);
  const before = Date.now();
  await request(ctx.app).post("/moment/confirm").set(auth(anna)).send({ mood: "😊", minutes: 60 }).expect(200);
  const status = await request(ctx.app).get("/status/get").set(auth(anna)).expect(200);
  assert.equal(status.body.availableSource, "session");
  const until = new Date(status.body.availableUntil).getTime();
  assert.ok(until >= before + 60 * 60 * 1000 && until < before + 61 * 60 * 1000);

  // Legacy app: no minutes -> 15
  await request(ctx.app).post("/moment/confirm").set(auth(anna)).send({ mood: "😊" }).expect(200);
  // Manual availability is open-ended
  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: true }).expect(200);
  const manual = await request(ctx.app).get("/status/get").set(auth(anna)).expect(200);
  assert.equal(manual.body.availableUntil, null);
  assert.equal(manual.body.availableSource, "manual");
});

test("talks: an answered call is recorded once, capped at 4 hours", async () => {
  const call = {
    callId: "c1",
    caller: ANNA,
    callee: BEN,
    acceptedAt: new Date(Date.now() - 10 * HOUR),
    endedAt: new Date(),
  };
  await ctx.calls.recordTalk(call);
  await ctx.calls.recordTalk(call);
  const talks = await Talk.find();
  assert.equal(talks.length, 1);
  assert.equal(talks[0].seconds, 4 * 3600);
  await ctx.calls.recordTalk({ ...call, callId: "c2", acceptedAt: undefined });
  assert.equal(await Talk.countDocuments(), 1);
});

test("stats: totals, weekly streak, people and badges", async () => {
  const anna = await login(ANNA);
  const now = new Date();
  const week = 7 * 24 * HOUR;
  await talk("t1", ANNA, BEN, now, 35);
  await talk("t2", CARL, ANNA, new Date(now - week), 10);
  await talk("t3", ANNA, BEN, new Date(now - 2 * week), 20);
  await talk("t4", BEN, CARL, new Date(now - HOUR), 99); // not Anna's

  const res = await request(ctx.app).get(`/me/stats?tz=${encodeURIComponent(TZ)}`).set(auth(anna)).expect(200);
  const { stats, sharing } = res.body;
  assert.equal(stats.totals.allTimeSeconds, 65 * 60);
  assert.equal(stats.totals.talks, 3);
  assert.equal(stats.totals.longestSeconds, 35 * 60);
  assert.ok(stats.streak.current >= 3);
  assert.equal(stats.weeks.length, 8);
  assert.equal(stats.weeks.reduce((sum, w) => sum + w.seconds, 0), 65 * 60);
  assert.deepEqual(stats.people.map((p) => p.phone), [BEN, CARL]);
  assert.equal(stats.people[0].talks, 2);

  const earned = stats.badges.filter((b) => b.earned).map((b) => b.id);
  assert.deepEqual(earned, ["first_talk", "deep_talk", "hour"]);
  assert.equal(stats.badges.find((b) => b.id === "ten_talks").progress, 0.3);
  assert.equal(sharing.visibility, "private");
});

test("stats sharing: private by default; contacts or selected people only, never the people list", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN);
  const carl = await login(CARL);
  await befriend(ANNA, BEN);
  await befriend(ANNA, CARL);
  await talk("t1", ANNA, BEN, new Date(), 12);

  await request(ctx.app).get(`/stats/${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(403);

  await request(ctx.app).put("/me/stats/sharing").set(auth(anna)).send({ visibility: "public" }).expect(400);
  await request(ctx.app).put("/me/stats/sharing").set(auth(anna)).send({ visibility: "contacts" }).expect(200);
  const shared = await request(ctx.app).get(`/stats/${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200);
  assert.equal(shared.body.name, "Anna");
  assert.equal(shared.body.stats.totals.allTimeSeconds, 12 * 60);
  assert.equal(shared.body.stats.people, undefined);
  assert.ok(!JSON.stringify(shared.body).includes(BEN));

  await request(ctx.app)
    .put("/me/stats/sharing")
    .set(auth(anna))
    .send({ visibility: "selected", sharedWith: ["0152 22222222"] })
    .expect(200);
  await request(ctx.app).get(`/stats/${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200);
  await request(ctx.app).get(`/stats/${encodeURIComponent(ANNA)}`).set(auth(carl)).expect(403);
  // Unknown users look the same as private ones
  await request(ctx.app).get("/stats/%2B4915999999999").set(auth(carl)).expect(403);
});

test("nudges: only between people who know each other, once per pair, no push at night", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN);
  const carl = await login(CARL);
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[ben]" });
  // Ben has Anna in his contacts; Carl has nobody
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });

  await request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: CARL }).expect(403);
  await request(ctx.app).post("/nudge").set(auth(carl)).send({ phone: BEN }).expect(403);

  // Night in Ben's zone -> stored, but no push
  const night = localParts(new Date(), TZ).minutes;
  const expectPush = night >= 8 * 60 && night < 22 * 60;
  const res = await request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: BEN }).expect(200);
  assert.equal(res.body.pushed, expectPush);
  if (expectPush) {
    assert.equal(fakes.expoPushes.length, 1);
    assert.equal(fakes.expoPushes[0].data.type, "nudge");
    assert.ok(fakes.expoPushes[0].title.startsWith("Anna"));
  }

  const again = await request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: BEN }).expect(429);
  assert.equal(again.body.error, "already_nudged");

  const inbox = await request(ctx.app).get("/nudges").set(auth(ben)).expect(200);
  assert.deepEqual(inbox.body.received.map((n) => [n.from, n.name]), [[ANNA, "Anna"]]);
  const outbox = await request(ctx.app).get("/nudges").set(auth(anna)).expect(200);
  assert.deepEqual(outbox.body.sent.map((n) => n.to), [BEN]);

  // Available people don't need a nudge
  await User.updateOne({ phone: CARL }, { contacts: [ANNA], isAvailable: true });
  const busy = await request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: CARL }).expect(409);
  assert.equal(busy.body.error, "already_available");
});
