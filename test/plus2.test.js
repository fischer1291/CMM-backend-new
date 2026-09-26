const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Talk = require("../models/Talk");
const CallMoment = require("../models/CallMoment");
const { tickRituals } = require("../lib/circles");
const { resetLimitsCache } = require("../lib/plan");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const DAY = 24 * 3600 * 1000;

async function login(phone, name = "X") {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: "Europe/Berlin", "notificationPrefs.quietHours.enabled": false });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const plusFor = (phone) => User.updateOne({ phone }, { plus: { active: true, until: null, since: new Date(), source: "admin" } });

test("rituals: free circles have one, Plus up to three with names; older apps keep working", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const circle = await Circle.create({ name: "Familie", emoji: "🏡", createdBy: ANNA, members: [{ phone: ANNA }, { phone: BEN }], code: "RITUALSS" });
  await User.updateOne({ phone: ANNA }, { pushToken: "ExponentPushToken[anna]" });
  const patch = (token, body) => request(ctx.app).patch(`/circles/${circle._id}`).set(auth(token)).send(body);
  const sunday = { enabled: true, day: 0, start: 18 * 60, label: "Sonntagsrunde" };
  const wednesday = { enabled: true, day: 3, start: 20 * 60, label: "Mittwochs-Quatsch" };

  const tooMany = await patch(ben, { rituals: [sunday, wednesday] }).expect(403);
  assert.equal(tooMany.body.error, "plan_limit");
  assert.equal(tooMany.body.plus, 3);
  await patch(ben, { rituals: [{ enabled: true, day: 9, start: 0 }] }).expect(400);

  // The founder's plan counts, not the editor's
  await plusFor(ANNA);
  const saved = (await patch(ben, { rituals: [sunday, wednesday] }).expect(200)).body.circle;
  assert.deepEqual(saved.rituals.map((r) => r.label), ["Sonntagsrunde", "Mittwochs-Quatsch"]);
  assert.equal(saved.ritual.day, 0, "the first one is still `ritual` for older apps");

  // Plus ended: the two stay, a third can't be added
  await User.updateOne({ phone: ANNA }, { plus: { active: false } });
  await patch(ben, { rituals: [sunday, wednesday] }).expect(200);
  await patch(ben, { rituals: [sunday, wednesday, { ...wednesday, day: 5 }] }).expect(403);

  // The extra ritual opens the room with its name in the push (Wed 20:03 Berlin)
  assert.equal(await tickRituals(ctx.io, new Date("2026-09-23T18:03:00Z")), 1);
  await new Promise((r) => setTimeout(r, 50));
  const push = fakes.expoPushes.find((p) => p.data?.type === "circle_ritual");
  assert.match(push.title, /Mittwochs-Quatsch beginnt/);
  assert.equal(await tickRituals(ctx.io, new Date("2026-09-23T18:05:00Z")), 0, "once");

  // An older app edits only the first ritual; the second stays
  await patch(ben, { ritual: { enabled: true, day: 1, start: 19 * 60 } }).expect(200);
  const after = await Circle.findById(circle._id);
  assert.equal(after.ritual.day, 1);
  assert.equal(after.ritual.label, "Sonntagsrunde");
  assert.equal(after.moreRituals.length, 1);
});

test("nudges: an own line is Plus, one line without links, shown in push and list", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await User.updateOne({ phone: BEN }, { contacts: [ANNA], pushToken: "ExponentPushToken[ben]" });
  const nudge = (body) => request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: BEN, ...body });

  assert.equal((await nudge({ message: "Hey du!" }).expect(403)).body.error, "plus_only");
  await plusFor(ANNA);
  await nudge({ message: "schau mal www.example.com" }).expect(400);
  await nudge({ message: "  Kaffee-Call\nheute?  " }).expect(200);
  const push = fakes.expoPushes.at(-1);
  assert.equal(push.body, "„Kaffee-Call heute?“");
  const list = (await request(ctx.app).get("/nudges").set(auth(ben)).expect(200)).body;
  assert.equal(list.received[0].message, "Kaffee-Call heute?");
});

test("year review: headline for everyone, the full story with Plus", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  const year = new Date().getUTCFullYear();
  const at = (m, d, h = 12) => new Date(Date.UTC(year, m - 1, d, h));
  await Talk.create({ callId: "y1", participants: [ANNA, BEN], startedAt: at(1, 10), seconds: 20 * 60 });
  await Talk.create({ callId: "y2", participants: [BEN, ANNA], startedAt: at(1, 17), seconds: 45 * 60 });
  await Talk.create({ callId: "y3", participants: [ANNA, CARL], startedAt: at(3, 2), seconds: 10 * 60 });
  await Talk.create({ callId: "y4", participants: [ANNA, BEN, CARL], startedAt: at(3, 9), seconds: 30 * 60, group: true, owner: ANNA });
  await Talk.create({ callId: "old", participants: [ANNA, BEN], startedAt: at(1, 1) - 400 * DAY, seconds: 99 * 60 });
  const moment = await CallMoment.create({ userPhone: BEN, userName: "Ben", targetPhone: ANNA, targetName: "Anna", screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "45:00", timestamp: at(1, 17) });
  await CallMoment.collection.updateOne({ _id: moment._id }, { $set: { totalReactions: 5 } });

  let review = (await request(ctx.app).get("/me/year-review").set(auth(anna)).expect(200)).body.review;
  assert.deepEqual(review, { year, minutes: 105, talks: 3, people: 2, full: false });

  await plusFor(ANNA);
  review = (await request(ctx.app).get("/me/year-review").set(auth(anna)).expect(200)).body.review;
  assert.equal(review.full, true);
  assert.deepEqual(review.topPeople.map((p) => [p.name, p.minutes]), [["Ben", 80], ["Carl", 25]]);
  assert.equal(review.longest.minutes, 45);
  assert.equal(review.longest.with.name, "Ben");
  assert.equal(review.busiestMonth.month, 1);
  assert.equal(review.firstTalk.with.name, "Ben");
  assert.equal(review.rounds, 1);
  assert.equal(review.roundMinutes, 30);
  assert.equal(review.bestMoment.reactions, 5);
  assert.equal(review.bestMoment.with.name, "Ben");
  await request(ctx.app).get(`/me/year-review?year=${year + 1}`).set(auth(anna)).expect(400);
});
