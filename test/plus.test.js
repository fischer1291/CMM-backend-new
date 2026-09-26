const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const CallMoment = require("../models/CallMoment");
const { endStaleRooms } = require("../lib/circles");
const { resetLimitsCache } = require("../lib/plan");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
  process.env.REVENUECAT_WEBHOOK_SECRET = "rc-secret";
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const DAY = 24 * 3600 * 1000;

async function login(phone, name = "X") {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: "Europe/Berlin" });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const plusFor = (phone, days = 30) => User.updateOne({ phone }, { plus: { active: true, until: new Date(Date.now() + days * DAY), since: new Date(), source: "admin" } });
const newCircle = (token, name) => request(ctx.app).post("/circles").set(auth(token)).send({ name, emoji: "💛" });
const members = (n) => Array.from({ length: n }, (_, i) => ({ phone: `+49160000${String(i).padStart(4, "0")}` }));

test("plan: free by default, with both plans' limits for the comparison", async () => {
  const anna = await login(ANNA);
  const body = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.equal(body.plan, "free");
  assert.equal(body.limits.circles, 3);
  assert.equal(body.all.plus.circleMembers, 50);
  assert.equal(body.usage.circlesFounded, 0);
  await plusFor(ANNA);
  assert.equal((await request(ctx.app).get("/me/plan").set(auth(anna))).body.plan, "plus");
});

test("circles: founding counts against the plan, joining never does", async () => {
  const anna = await login(ANNA);
  const ben = await login(BEN);
  for (const n of ["A", "B", "C"]) await newCircle(anna, n).expect(200);
  const fourth = await newCircle(anna, "D").expect(403);
  assert.deepEqual(fourth.body, { success: false, error: "plan_limit", limit: "circles", value: 3, plus: 20 });

  // Ben founds three and Anna joins them: fine
  for (const n of ["E", "F", "G"]) {
    const { body } = await newCircle(ben, n).expect(200);
    const code = (await Circle.findById(body.circle.id)).code;
    await request(ctx.app).post("/circles/join").set(auth(anna)).send({ code }).expect(200);
  }
  await plusFor(ANNA);
  await newCircle(anna, "D").expect(200);
});

test("circles: size follows the founder's plan; the full circle says whether Plus would help", async () => {
  await login(ANNA);
  const ben = await login(BEN);
  const circle = await Circle.create({ name: "Voll", createdBy: ANNA, members: [{ phone: ANNA }, ...members(11)], code: "FULLFULL" });
  const full = await request(ctx.app).post("/circles/join").set(auth(ben)).send({ code: "FULLFULL" }).expect(400);
  assert.deepEqual(full.body, { success: false, error: "full", founderCanUpgrade: true });
  await plusFor(ANNA);
  await request(ctx.app).post("/circles/join").set(auth(ben)).send({ code: "FULLFULL" }).expect(200);
  assert.equal((await Circle.findById(circle._id)).members.length, 13);
});

test("rounds: free circles end after 60 minutes, Plus circles don't; at most 6 inside", async () => {
  const anna = await login(ANNA);
  const circle = await Circle.create({ name: "Runde", createdBy: ANNA, members: [{ phone: ANNA }, { phone: BEN }, ...members(8)], code: "RUNDERUN" });
  const opened = (await request(ctx.app).post(`/circles/${circle._id}/room`).set(auth(anna)).expect(200)).body.room;
  const endsIn = new Date(opened.endsAt) - Date.now();
  assert.ok(endsIn > 59 * 60 * 1000 && endsIn <= 60 * 60 * 1000);

  // Time's up: the round ends
  await Room.updateOne({ _id: opened.id }, { endsAt: new Date(Date.now() - 1000) });
  const ended = await endStaleRooms();
  assert.equal(ended.length, 1);
  assert.equal((await Room.findById(opened.id)).active, false);

  // Six inside: the seventh can't join
  const room = await Room.create({ circleId: circle._id, channel: "room_full", startedBy: ANNA, participants: members(6).map((m) => ({ ...m, joinedAt: new Date() })) });
  const ben = await login(BEN);
  const tooMany = await request(ctx.app).post(`/rooms/${room._id}/join`).set(auth(ben)).expect(403);
  assert.equal(tooMany.body.error, "room_full");

  await Room.deleteMany({});
  await plusFor(ANNA);
  const plusRoom = (await request(ctx.app).post(`/circles/${circle._id}/room`).set(auth(anna)).expect(200)).body.room;
  assert.equal(plusRoom.endsAt, null);
});

test("memories: free shows the last 30 days and how many older ones wait; Plus shows all", async () => {
  const anna = await login(ANNA);
  const base = { userPhone: ANNA, userName: "Anna", targetPhone: BEN, targetName: "Ben", screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "01:00" };
  await CallMoment.create({ ...base, timestamp: new Date(Date.now() - 5 * DAY) });
  await CallMoment.create({ ...base, timestamp: new Date(Date.now() - 90 * DAY) });
  let body = (await request(ctx.app).get("/moment/memories").set(auth(anna)).expect(200)).body;
  assert.equal(body.memories.length, 1);
  assert.equal(body.olderHidden, 1);
  assert.equal(body.memoriesDays, 30);
  await plusFor(ANNA);
  body = (await request(ctx.app).get("/moment/memories").set(auth(anna)).expect(200)).body;
  assert.equal(body.memories.length, 2);
  assert.equal(body.olderHidden, 0);
});

test("RevenueCat webhook: secret required; purchase, cancellation (still Plus), expiry; late events ignored", async () => {
  await login(ANNA);
  const id = String((await User.findOne({ phone: ANNA }))._id);
  const hook = (event, secret = "rc-secret") => request(ctx.app).post("/webhooks/revenuecat").set("Authorization", `Bearer ${secret}`).send({ event });
  const t = Date.now();
  const event = (type, at, expires) => ({ type, app_user_id: id, product_id: "wannayap_plus_monthly", event_timestamp_ms: at, expiration_at_ms: expires });

  await hook(event("INITIAL_PURCHASE", t, t + 30 * DAY), "wrong").expect(401);
  assert.equal((await hook(event("INITIAL_PURCHASE", t, t + 30 * DAY)).expect(200)).body.result, "ok");
  let user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.active, true);
  assert.equal(user.plus.source, "store");

  await hook(event("CANCELLATION", t + 1000, t + 30 * DAY)).expect(200);
  user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.active, true, "cancelled: Plus until the period ends");

  // An older event arriving late changes nothing
  assert.equal((await hook(event("RENEWAL", t - 5000, t + 60 * DAY))).body.result, "stale");

  await hook(event("EXPIRATION", t + 2000, t + 30 * DAY)).expect(200);
  assert.equal((await User.findOne({ phone: ANNA })).plus.active, false);
  assert.equal((await hook({ type: "RENEWAL", app_user_id: "nobody" })).body.result, "unknown_user");
});

test("interest and the supporter badge", async () => {
  const anna = await login(ANNA);
  await request(ctx.app).post("/me/plus-interest").set(auth(anna)).send({ features: ["memories", "nope", "family", "memories"] }).expect(200);
  assert.deepEqual((await User.findOne({ phone: ANNA })).plusInterest.features, ["memories", "family"]);
  let album = (await request(ctx.app).get("/me/badges").set(auth(anna))).body;
  assert.equal(album.badges.find((b) => b.id === "supporter").earned, false);
  await plusFor(ANNA);
  album = (await request(ctx.app).get("/me/badges").set(auth(anna))).body;
  assert.equal(album.badges.find((b) => b.id === "supporter").earned, true);
});
