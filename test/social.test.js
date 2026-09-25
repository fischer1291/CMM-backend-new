const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes, talked, shareAll } = require("./helpers");
const User = require("../models/User");
const Call = require("../models/Call");
const CallMoment = require("../models/CallMoment");
const Invite = require("../models/Invite");

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
const IMAGE = "data:image/jpeg;base64,AAAA";

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  if (name) await User.updateOne({ phone }, { name, pushToken: `ExponentPushToken[${name}]` });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const befriend = (...phones) =>
  Promise.all(phones.map((p) => User.updateOne({ phone: p }, { contacts: phones.filter((q) => q !== p) })));
const socketFor = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(ctx.url, { transports: ["websocket"], auth: { token }, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });

test("block: hides both from each other everywhere; unblock restores with the next sync", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  await talked(BEN, ANNA);
  await request(ctx.app)
    .post("/moment/callmoment")
    .set(auth(ben))
    .send({ targetPhone: ANNA, screenshot: IMAGE, mood: "😊", callDuration: "01:00" })
    .expect(200);
  await shareAll();

  await request(ctx.app).post("/blocks").set(auth(anna)).send({ phone: ANNA }).expect(400);
  await request(ctx.app).post("/blocks").set(auth(anna)).send({ phone: BEN }).expect(200);

  const [a, b] = await Promise.all([User.findOne({ phone: ANNA }), User.findOne({ phone: BEN })]);
  assert.deepEqual(a.contacts, []);
  assert.deepEqual(b.contacts, []);

  // Address book sync doesn't bring them back, in either direction
  const hashes = { hashes: [User.hashPhone(ANNA), User.hashPhone(BEN)] };
  assert.equal((await request(ctx.app).post("/contacts/match").set(auth(anna)).send(hashes)).body.matched.length, 0);
  assert.equal((await request(ctx.app).post("/contacts/match").set(auth(ben)).send(hashes)).body.matched.length, 0);

  await request(ctx.app).get(`/me?phone=${encodeURIComponent(BEN)}`).set(auth(anna)).expect(404);
  await request(ctx.app).get(`/status/get?phone=${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(404);
  await request(ctx.app).post("/nudge").set(auth(ben)).send({ phone: ANNA }).expect(403);
  const feed = await request(ctx.app).get("/moment/callmoments").set(auth(anna)).expect(200);
  assert.equal(feed.body.callMoments.length, 0, "Ben's moment with Anna is gone from her feed");
  assert.deepEqual(await ctx.calls.startCall({ from: BEN, to: ANNA, channel: "call_blocked" }), {
    ok: false,
    reason: "unreachable",
  });

  const list = await request(ctx.app).get("/blocks").set(auth(anna)).expect(200);
  assert.deepEqual(list.body.blocked.map((x) => [x.phone, x.name]), [[BEN, "Ben"]]);

  await request(ctx.app).delete(`/blocks/${encodeURIComponent(BEN)}`).set(auth(anna)).expect(200);
  assert.equal((await request(ctx.app).post("/contacts/match").set(auth(anna)).send(hashes)).body.matched.length, 1);
});

test("report: a moment reported by three people is hidden; reporting can block too", async () => {
  const anna = await login(ANNA, "Anna");
  const reporters = [await login(BEN, "Ben"), await login(CARL, "Carl"), await login(DANA, "Dana")];
  await befriend(ANNA, BEN, CARL, DANA);
  await talked(ANNA, BEN);
  const momentId = (
    await request(ctx.app)
      .post("/moment/callmoment")
      .set(auth(anna))
      .send({ targetPhone: BEN, screenshot: IMAGE, mood: "😊", callDuration: "01:00" })
  ).body.callMoment._id;
  await shareAll();

  await request(ctx.app).post("/reports").set(auth(reporters[0])).send({ phone: ANNA, reason: "rude" }).expect(400);
  for (const token of reporters) {
    await request(ctx.app).post("/reports").set(auth(token)).send({ phone: ANNA, momentId, reason: "inappropriate" }).expect(200);
  }
  assert.equal((await CallMoment.findById(momentId)).hidden, true);
  const feed = await request(ctx.app).get("/moment/callmoments").set(auth(reporters[0])).expect(200);
  assert.equal(feed.body.callMoments.length, 0);

  await request(ctx.app).post("/reports").set(auth(reporters[0])).send({ phone: ANNA, reason: "harassment", block: true }).expect(200);
  assert.ok(!(await User.findOne({ phone: BEN })).contacts.includes(ANNA));

  // Moderation needs the admin key
  await request(ctx.app).get("/admin/reports").expect(403);
  const open = await request(ctx.app).get("/admin/reports").set("X-Admin-Key", "admin-key").expect(200);
  assert.equal(open.body.reports.length, 4);
  const withMoment = open.body.reports.find((r) => r.momentId);
  await request(ctx.app)
    .post(`/admin/reports/${withMoment._id}/resolve`)
    .set("X-Admin-Key", "admin-key")
    .send({ removeMoment: true })
    .expect(200);
  assert.equal(await CallMoment.countDocuments({ _id: momentId }), 0);
});

test("invites: the invited person is connected on sign-up; inviters hear it once they have a name", async () => {
  const anna = await login(ANNA, "Anna");
  await request(ctx.app).post("/invites").set(auth(anna)).send({ hashes: ["nope"] }).expect(400);
  await request(ctx.app).post("/invites").set(auth(anna)).send({ hashes: [User.hashPhone(BEN)] }).expect(200);
  const annaApp = await socketFor(anna);
  try {
    const joined = new Promise((resolve) => annaApp.once("contactJoined", resolve));
    const ben = await login(BEN); // no name yet
    await settle();
    assert.ok((await User.findOne({ phone: ANNA })).contacts.includes(BEN));
    assert.ok((await User.findOne({ phone: BEN })).contacts.includes(ANNA));
    assert.equal(await Invite.countDocuments(), 0);
    assert.equal(fakes.expoPushes.filter((p) => p.data?.type === "contact_joined").length, 0);

    await User.updateOne({ phone: ANNA }, { "notificationPrefs.quietHours.enabled": false });
    await request(ctx.app).post("/me/update").set(auth(ben)).send({ name: "Ben" }).expect(200);
    assert.equal((await joined).name, "Ben");
    await settle();
    const push = fakes.expoPushes.find((p) => p.data?.type === "contact_joined");
    assert.equal(push.title, "Ben ist jetzt dabei 🎉");
    assert.equal(push.to, "ExponentPushToken[Anna]");

    // Only once
    await request(ctx.app).post("/me/update").set(auth(ben)).send({ name: "Benjamin" }).expect(200);
    await settle();
    assert.equal(fakes.expoPushes.filter((p) => p.data?.type === "contact_joined").length, 1);
  } finally {
    annaApp.close();
  }
});

test("audio calls: the call, socket event and call push say it's audio only", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const caller = await socketFor(anna);
  const callee = await socketFor(ben);
  try {
    const incoming = new Promise((resolve) => callee.once("incomingCall", resolve));
    caller.emit("callRequest", { to: BEN, channel: "call_audio", video: false });
    assert.equal((await incoming).hasVideo, false);
    assert.equal((await Call.findOne({ channel: "call_audio" })).video, false);
    // No VoIP configured in tests: the regular call push is the fallback
    await settle();
    const push = fakes.expoPushes.find((p) => p.data?.type === "incoming_call");
    assert.equal(push.body, "Anruf");
    assert.equal(push.data.hasVideo, false);
  } finally {
    caller.close();
    callee.close();
  }
});
