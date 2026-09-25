const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes, talked } = require("./helpers");
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");
const DailyMoment = require("../models/DailyMoment");
const { momentFor, tickDailyMoments } = require("../lib/dailyMoment");
const { localParts } = require("../lib/localTime");
const { expirePendingMoments } = require("../lib/moments");

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
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: TZ, pushToken: `ExponentPushToken[${name}]`, "notificationPrefs.quietHours.enabled": false });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Wednesday 2026-09-23 in Berlin (CEST)
const at = (hh, mm = 0) => new Date(Date.UTC(2026, 8, 23, hh - 2, mm));

test("daily moment: one random time per day between 10:00 and 21:00 local", async () => {
  const early = await momentFor(TZ, at(7), () => 0.5);
  const { minutes } = localParts(early.at, TZ);
  assert.ok(minutes >= 10 * 60 && minutes < 21 * 60, `at ${minutes}`);
  assert.equal(early.endsAt - early.at, 10 * MIN);
  // Same day, same moment
  assert.equal(String((await momentFor(TZ, at(9))).at), String(early.at));

  // Created in the afternoon: still ahead, never in the past
  await DailyMoment.deleteMany({});
  const late = await momentFor(TZ, at(16), () => 0);
  assert.ok(late.at >= at(16, 5));
  // After 21:00: no moment today
  await DailyMoment.deleteMany({});
  const tooLate = await momentFor(TZ, at(21, 30));
  assert.ok(tooLate.sentAt, "marked as done, never fires today");
});

test("daily moment: starts for everyone in the zone (not for those who turned it off)", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  await User.updateOne({ phone: CARL }, { "notificationPrefs.dailyMoment": false });

  const moment = await momentFor(TZ, at(8), () => 0.25);
  assert.equal(await tickDailyMoments(ctx.io, new Date(moment.at.getTime() - MIN)), 0);
  assert.equal(await tickDailyMoments(ctx.io, moment.at), 1);
  assert.equal(await tickDailyMoments(ctx.io, new Date(moment.at.getTime() + MIN)), 0, "only once");

  const pushes = fakes.expoPushes.filter((p) => p.data?.type === "daily_moment");
  assert.deepEqual(pushes.map((p) => p.to).sort(), ["ExponentPushToken[Anna]", "ExponentPushToken[Ben]"]);
  assert.equal(pushes[0].title, "⚡ Yap Moment!");
  assert.equal(pushes[0].categoryId, "daily_moment");
  assert.equal(pushes[0].ttl, 600);
});

test("daily moment: joining makes you available until the end; friends see who's in", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });

  await request(ctx.app).post("/daily/join").set(auth(anna)).expect(409);
  assert.equal((await request(ctx.app).get("/daily").set(auth(anna)).expect(200)).body.active, false);

  // A moment that started a minute ago
  const now = new Date();
  const { dateKey } = localParts(now, TZ);
  await DailyMoment.create({ day: dateKey, zone: TZ, at: new Date(now - MIN), endsAt: new Date(now.getTime() + 9 * MIN), sentAt: new Date(now - MIN) });

  const joined = await request(ctx.app).post("/daily/join").set(auth(ben)).send({ mood: "😊" }).expect(200);
  assert.ok(new Date(joined.body.availableUntil) >= new Date(now.getTime() + 14 * MIN - 1000));
  const benNow = await User.findOne({ phone: BEN });
  assert.equal(benNow.isAvailable, true);
  assert.equal(benNow.availableSource, "daily");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fakes.expoPushes.filter((p) => p.data?.type === "contact_available").length, 0, "the daily push said it all");

  const view = await request(ctx.app).get("/daily").set(auth(anna)).expect(200);
  assert.equal(view.body.active, true);
  assert.equal(view.body.joined, false);
  assert.deepEqual(view.body.participants, [BEN]);
});

test("moments: consent, 24 h in the feed, then memories; unanswered requests expire", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN, CARL] });
  await User.updateOne({ phone: CARL }, { contacts: [ANNA] });
  await talked(ANNA, BEN);
  await talked(CARL, BEN); // Carl talked today: his feed is open

  const post = () =>
    request(ctx.app)
      .post("/moment/callmoment")
      .set(auth(anna))
      .send({ targetPhone: BEN, screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "05:00" })
      .expect(200);
  const first = (await post()).body.callMoment._id;

  // Pending: Ben is asked, Anna waits, Carl sees nothing yet
  const benFeed = (await request(ctx.app).get("/moment/callmoments").set(auth(ben))).body;
  assert.deepEqual(benFeed.pending.map((m) => m._id), [first]);
  assert.deepEqual((await request(ctx.app).get("/moment/callmoments").set(auth(anna))).body.waiting.map((m) => m._id), [first]);
  assert.equal((await request(ctx.app).get("/moment/callmoments").set(auth(carl))).body.callMoments.length, 0);

  // Only Ben decides
  await request(ctx.app).post(`/moment/${first}/consent`).set(auth(anna)).send({ approve: true }).expect(404);
  await request(ctx.app).post(`/moment/${first}/consent`).set(auth(ben)).send({ approve: true }).expect(200);
  assert.deepEqual((await request(ctx.app).get("/moment/callmoments").set(auth(carl))).body.callMoments.map((m) => m._id), [first]);

  // Declined: gone
  const second = (await post()).body.callMoment._id;
  await request(ctx.app).post(`/moment/${second}/consent`).set(auth(ben)).send({ approve: false }).expect(200);
  assert.equal(await CallMoment.countDocuments({ _id: second }), 0);

  // After 24 h: out of the feed, still a memory of the two
  await CallMoment.updateOne({ _id: first }, { sharedAt: new Date(Date.now() - 25 * HOUR), timestamp: new Date(Date.now() - 25 * HOUR) });
  assert.equal((await request(ctx.app).get("/moment/callmoments").set(auth(carl))).body.callMoments.length, 0);
  const memories = (await request(ctx.app).get("/moment/memories").set(auth(ben)).expect(200)).body.memories;
  assert.deepEqual(memories.map((m) => m._id), [first]);
  assert.equal((await request(ctx.app).get("/moment/memories").set(auth(carl))).body.memories.length, 0);

  // Unanswered for a day: removed
  const third = (await post()).body.callMoment._id;
  await CallMoment.updateOne({ _id: third }, { timestamp: new Date(Date.now() - 25 * HOUR) });
  assert.equal(await expirePendingMoments(), 1);
  assert.equal(await CallMoment.countDocuments({ _id: third }), 0);
});
