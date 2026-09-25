const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes, talked } = require("./helpers");
const User = require("../models/User");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const Talk = require("../models/Talk");
const { dueRituals, tickRituals, migratePrivateCircles } = require("../lib/circles");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const DANA = "+4915444444444";
const TZ = "Europe/Berlin";

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  if (name) {
    await User.updateOne(
      { phone },
      { name, timezone: TZ, pushToken: `ExponentPushToken[${name}]`, "notificationPrefs.quietHours.enabled": false },
    );
  }
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const socketFor = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(ctx.url, { transports: ["websocket"], auth: { token }, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
const pushes = (type) => fakes.expoPushes.filter((p) => p.data?.type === type);

/** Anna's circle "Familie" with Ben and Carl as members. */
async function family() {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  const created = await request(ctx.app)
    .post("/circles")
    .set(auth(anna))
    .send({ name: "Familie", emoji: "🏡", invite: [BEN, CARL] })
    .expect(200);
  const id = created.body.circle.id;
  await request(ctx.app).post(`/circles/${id}/accept`).set(auth(ben)).expect(200);
  await request(ctx.app).post(`/circles/${id}/accept`).set(auth(carl)).expect(200);
  return { anna, ben, carl, id, code: created.body.circle.code };
}

test("circles: create, invite (app users and people without the app), accept or decline", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  const benApp = await socketFor(ben);
  try {
    const invited = new Promise((resolve) => benApp.once("circleInvite", resolve));
    const created = await request(ctx.app)
      .post("/circles")
      .set(auth(anna))
      .send({ name: "Familie Fischer", emoji: "🏡", invite: [BEN, CARL], inviteHashes: [User.hashPhone(DANA)] })
      .expect(200);
    const circle = created.body.circle;
    assert.equal(circle.members.length, 1);
    assert.equal(circle.invites.length, 3);
    assert.match(circle.code, /^[A-Z2-9]{8}$/);
    assert.equal((await invited).circleId, circle.id);
  } finally {
    benApp.close();
  }
  await settle();
  const invitePush = pushes("circle_invite").find((p) => p.to === "ExponentPushToken[Ben]");
  assert.equal(invitePush.title, "Anna lädt dich in 🏡 Familie Fischer ein");

  const benView = (await request(ctx.app).get("/circles").set(auth(ben)).expect(200)).body;
  assert.equal(benView.circles.length, 0);
  assert.deepEqual(benView.invites.map((i) => [i.name, i.invitedByName]), [["Familie Fischer", "Anna"]]);
  const id = benView.invites[0].circleId;

  // Not a member yet: can't look inside
  await request(ctx.app).get(`/circles/${id}`).set(auth(ben)).expect(404);
  await request(ctx.app).post(`/circles/${id}/accept`).set(auth(ben)).expect(200);
  await request(ctx.app).post(`/circles/${id}/decline`).set(auth(carl)).expect(200);
  const detail = (await request(ctx.app).get(`/circles/${id}`).set(auth(ben)).expect(200)).body.circle;
  assert.deepEqual(detail.members.map((m) => m.name).sort(), ["Anna", "Ben"]);
  assert.equal(detail.invites.length, 1, "Dana (no app yet) is still invited");

  // Dana signs up: her invite is waiting for her
  const dana = await login(DANA, "Dana");
  const danaView = (await request(ctx.app).get("/circles").set(auth(dana)).expect(200)).body;
  assert.deepEqual(danaView.invites.map((i) => i.circleId), [id]);
});

test("circles: joining by code; the creator's rights move on; the last one out deletes it", async () => {
  const { ben, carl, id, code } = await family();
  const dana = await login(DANA, "Dana");

  // Public preview for the invite page
  const preview = await request(ctx.app).get(`/circles/code/${code.toLowerCase()}`).expect(200);
  assert.deepEqual(preview.body.circle, { name: "Familie", emoji: "🏡", memberCount: 3, createdByName: "Anna" });
  await request(ctx.app).get("/circles/code/NOPE1234").expect(404);

  await request(ctx.app).post("/circles/join").set(auth(dana)).send({ code: "WRONG" }).expect(404);
  const joined = await request(ctx.app).post("/circles/join").set(auth(dana)).send({ code }).expect(200);
  assert.equal(joined.body.circle.members.length, 4);

  const anna = (await User.findOne({ phone: ANNA })) && (await login(ANNA)); // fresh token for Anna
  await request(ctx.app).delete(`/circles/${id}/members/${encodeURIComponent(DANA)}`).set(auth(ben)).expect(403);
  await request(ctx.app).post(`/circles/${id}/leave`).set(auth(anna)).expect(200);
  assert.equal((await Circle.findById(id)).createdBy, BEN);
  await request(ctx.app).delete(`/circles/${id}/members/${encodeURIComponent(DANA)}`).set(auth(ben)).expect(200);
  await request(ctx.app).post(`/circles/${id}/leave`).set(auth(carl)).expect(200);
  await request(ctx.app).post(`/circles/${id}/leave`).set(auth(ben)).expect(200);
  assert.equal(await Circle.countDocuments(), 0);
});

test("circles: members see each other's availability without having each other's numbers", async () => {
  const { anna, carl, id } = await family();
  // Nobody has anyone in their address book
  const carlApp = await socketFor(carl);
  try {
    const live = new Promise((resolve) => carlApp.once("statusUpdate", resolve));
    await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: true }).expect(200);
    const update = await live;
    assert.equal(update.phone, ANNA);
    assert.equal(update.isAvailable, true);
  } finally {
    carlApp.close();
  }
  const detail = (await request(ctx.app).get(`/circles/${id}`).set(auth(carl)).expect(200)).body.circle;
  assert.equal(detail.members.find((m) => m.phone === ANNA).isAvailable, true);
  await settle();
  assert.ok(pushes("contact_available").some((p) => p.to === "ExponentPushToken[Carl]"));
});

test("circles: 'only circles' audience limits availability to chosen circles", async () => {
  const { anna, id } = await family();
  const dana = await login(DANA, "Dana");
  await User.updateOne({ phone: DANA }, { contacts: [ANNA] });
  await request(ctx.app).put("/me/audience").set(auth(anna)).send({ mode: "circles", circles: ["000000000000000000000000"] }).expect(400);
  await request(ctx.app).put("/me/audience").set(auth(anna)).send({ mode: "circles", circles: [id] }).expect(200);
  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: true }).expect(200);

  const danaSees = await request(ctx.app).get(`/status/get?phone=${encodeURIComponent(ANNA)}`).set(auth(dana)).expect(200);
  assert.equal(danaSees.body.isAvailable, false, "Dana is a contact, but not in the chosen circle");
  const carl = await login(CARL);
  const carlSees = await request(ctx.app).get(`/status/get?phone=${encodeURIComponent(ANNA)}`).set(auth(carl)).expect(200);
  assert.equal(carlSees.body.isAvailable, true);
});

test("circles: blocked members don't see each other; can't join a circle with someone who blocked you", async () => {
  const { anna, ben, id, code } = await family();
  await request(ctx.app).post("/blocks").set(auth(anna)).send({ phone: BEN }).expect(200);
  const annaView = (await request(ctx.app).get(`/circles/${id}`).set(auth(anna)).expect(200)).body.circle;
  assert.ok(!annaView.members.some((m) => m.phone === BEN));

  const dana = await login(DANA, "Dana");
  await request(ctx.app).post("/blocks").set(auth(dana)).send({ phone: ANNA }).expect(200);
  await request(ctx.app).post("/circles/join").set(auth(dana)).send({ code }).expect(404);
  assert.ok(ben);
});

test("circles: warmth counts time between members this week; goal when everyone talked", async () => {
  const { anna, id } = await family();
  const start = new Date();
  await Talk.create({ callId: "t1", participants: [ANNA, BEN], startedAt: start, seconds: 20 * 60 });
  await Talk.create({ callId: "t2", participants: [ANNA, DANA], startedAt: start, seconds: 60 * 60 }); // Dana isn't in the circle
  let warmth = (await request(ctx.app).get(`/circles/${id}`).set(auth(anna))).body.circle.warmth;
  assert.deepEqual(warmth, { minutes: 20, talkedCount: 2, memberCount: 3, goalReached: false });

  await Talk.create({ callId: "t3", participants: [CARL, BEN], startedAt: start, seconds: 10 * 60 });
  warmth = (await request(ctx.app).get(`/circles/${id}`).set(auth(anna))).body.circle.warmth;
  assert.deepEqual(warmth, { minutes: 30, talkedCount: 3, memberCount: 3, goalReached: true });
});

test("rooms: open, join, leave; talks for each participant; tokens only for members", async () => {
  const { anna, ben, id } = await family();
  const dana = await login(DANA, "Dana");
  const benApp = await socketFor(ben);
  let roomId;
  let channel;
  try {
    const opened = new Promise((resolve) => benApp.once("roomOpened", resolve));
    const res = await request(ctx.app).post(`/circles/${id}/room`).set(auth(anna)).expect(200);
    ({ id: roomId, channel } = res.body.room);
    assert.equal((await opened).roomId, roomId);
  } finally {
    benApp.close();
  }
  await settle();
  const invites = pushes("room_open");
  assert.deepEqual(invites.map((p) => p.to).sort(), ["ExponentPushToken[Ben]", "ExponentPushToken[Carl]"]);
  assert.equal(invites[0].title, "🏡 Familie: Runde ist offen 🎙️");
  assert.equal(invites[0].data.url, `/circle?id=${id}`);

  // Opening again joins the same room, no new pushes
  const again = await request(ctx.app).post(`/circles/${id}/room`).set(auth(ben)).expect(200);
  assert.equal(again.body.room.id, roomId);
  assert.equal(pushes("room_open").length, 2);

  // RTC tokens: members only
  await request(ctx.app).post("/rtcToken").set(auth(ben)).send({ channelName: channel, uid: BEN.slice(1), role: "publisher" }).expect(200);
  await request(ctx.app).post("/rtcToken").set(auth(dana)).send({ channelName: channel, uid: DANA.slice(1), role: "publisher" }).expect(403);
  await request(ctx.app).post(`/rooms/${roomId}/join`).set(auth(dana)).expect(404);

  const detail = (await request(ctx.app).get(`/circles/${id}`).set(auth(anna))).body.circle;
  assert.deepEqual(detail.room.participants.sort(), [ANNA, BEN]);

  // Ten minutes together, then both leave
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  await Room.updateOne({ _id: roomId }, { $set: { "participants.$[].joinedAt": tenMinutesAgo } });
  const benLeft = await request(ctx.app).post(`/rooms/${roomId}/leave`).set(auth(ben)).expect(200);
  assert.equal(benLeft.body.ended, false);
  const left = await request(ctx.app).post(`/rooms/${roomId}/leave`).set(auth(anna)).expect(200);
  assert.equal(left.body.ended, true);
  const talks = await Talk.find({ group: true }).sort({ owner: 1 });
  assert.deepEqual(talks.map((t) => [t.owner, t.participants]), [[ANNA, [ANNA, BEN]], [BEN, [BEN, ANNA]]]);

  // Counts in each one's own stats, with the other person
  const stats = (await request(ctx.app).get("/me/stats").set(auth(ben))).body.stats;
  assert.equal(stats.totals.talks, 1);
  assert.deepEqual(stats.people.map((p) => p.phone), [ANNA]);
  await request(ctx.app).post(`/rooms/${roomId}/join`).set(auth(anna)).expect(409);
});

test("rituals: the weekly get-together opens the room and tells everyone, once", async () => {
  const { anna, id } = await family();
  // Wednesday 18:00 in Berlin
  await request(ctx.app)
    .patch(`/circles/${id}`)
    .set(auth(anna))
    .send({ ritual: { enabled: true, day: 3, start: 18 * 60 } })
    .expect(200);
  const wednesday1805 = new Date("2026-09-23T16:05:00Z");
  assert.equal((await dueRituals(new Date("2026-09-23T15:55:00Z"))).length, 0);
  assert.equal(await tickRituals(ctx.io, wednesday1805), 1);
  assert.equal(await tickRituals(ctx.io, new Date("2026-09-23T16:07:00Z")), 0, "once a day");
  assert.equal(await Room.countDocuments({ circleId: id, active: true }), 1);
  await settle();
  assert.equal(pushes("circle_ritual").length, 3);
});

test("migration: old private lists become shared circles with invite drafts", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await User.collection.updateOne(
    { phone: ANNA },
    {
      $set: {
        circles: [{ id: "abc123def", name: "Crew", emoji: "💛", members: [BEN] }],
        availabilityAudience: { mode: "circles", circles: ["abc123def"] },
      },
    },
  );
  assert.equal(await migratePrivateCircles(), 1);
  const circle = await Circle.findOne({ createdBy: ANNA });
  assert.deepEqual(circle.invites.map((i) => [i.phone, i.status]), [[BEN, "draft"]]);
  const user = await User.findOne({ phone: ANNA }).lean();
  assert.deepEqual(user.availabilityAudience.circles, [String(circle._id)]);
  assert.equal(user.circles, undefined);
  assert.equal(pushes("circle_invite").length, 0, "drafts aren't sent");

  // The invited person still sees Anna's availability (the audience didn't shrink)
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });
  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: true }).expect(200);
  const ben = await login(BEN);
  const seen = await request(ctx.app).get(`/status/get?phone=${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200);
  assert.equal(seen.body.isAvailable, true);

  // Sending the drafts
  await request(ctx.app).post(`/circles/${circle._id}/invite`).set(auth(anna)).send({ drafts: true }).expect(200);
  await settle();
  assert.equal(pushes("circle_invite").length, 1);
});
