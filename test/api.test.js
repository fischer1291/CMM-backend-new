const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Call = require("../models/Call");
const CallMoment = require("../models/CallMoment");
const { expireMoments } = require("../routes/moment");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  delete process.env.AUTH_REQUIRED;
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";

/** Verify a phone via the SMS flow and return its auth token. */
async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app)
    .post("/verify/check")
    .send({ phone, code: fakes.approvedCode })
    .expect(200);
  if (name) await User.updateOne({ phone }, { name });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("verify: rejects invalid numbers and normalizes national numbers", async () => {
  await request(ctx.app).post("/verify/start").send({ phone: "abc" }).expect(400);
  const res = await request(ctx.app).post("/verify/start").send({ phone: "0151 1111 1111" }).expect(200);
  assert.equal(res.body.phone, ANNA);
  assert.deepEqual(fakes.sms, [ANNA]);
});

test("verify: wrong code gives no token, right code creates user and token", async () => {
  const wrong = await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: "000000" });
  assert.equal(wrong.body.success, false);
  assert.equal(await User.countDocuments(), 0);

  const token = await login(ANNA);
  assert.ok(token);
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.phoneHash, User.hashPhone(ANNA));
});

test("auth: a token can only act as its own phone", async () => {
  const token = await login(ANNA);
  await login(BEN);

  await request(ctx.app).post("/me/update").set(auth(token)).send({ phone: BEN, name: "Evil" }).expect(403);
  await request(ctx.app).post("/me/update").set(auth(token)).send({ name: "Anna" }).expect(200);
  assert.equal((await User.findOne({ phone: ANNA })).name, "Anna");
  assert.equal((await User.findOne({ phone: BEN })).name, undefined);
});

test("auth: invalid tokens are rejected; AUTH_REQUIRED blocks token-less requests", async () => {
  await login(ANNA);
  await request(ctx.app).post("/me/update").set(auth("garbage")).send({ name: "x" }).expect(401);

  // Legacy (token-less) still works while AUTH_REQUIRED is off
  await request(ctx.app).post("/me/update").send({ phone: ANNA, name: "Legacy" }).expect(200);

  process.env.AUTH_REQUIRED = "true";
  await request(ctx.app).post("/me/update").send({ phone: ANNA, name: "x" }).expect(401);
  const health = await request(ctx.app).get("/api/push-health").expect(200); // public
  assert.equal(health.body.agoraCertificateFromEnv, false);
});

test("me: validates name and avatar URL", async () => {
  const token = await login(ANNA);
  await request(ctx.app).post("/me/update").set(auth(token)).send({ name: "" }).expect(400);
  await request(ctx.app).post("/me/update").set(auth(token)).send({ name: "x".repeat(51) }).expect(400);
  await request(ctx.app).post("/me/update").set(auth(token)).send({ avatarUrl: "javascript:alert(1)" }).expect(400);
});

test("contacts: hash matching stores contacts; legacy numbers use the caller's region", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await login(CARL);

  const res = await request(ctx.app)
    .post("/contacts/match")
    .set(auth(anna))
    .send({ hashes: [User.hashPhone(BEN), User.hashPhone(ANNA), "not-a-hash"] })
    .expect(200);
  assert.deepEqual(res.body.matched.map((m) => m.phone), [BEN]); // not herself
  assert.deepEqual((await User.findOne({ phone: ANNA })).contacts, [BEN]);

  const legacy = await request(ctx.app)
    .post("/contacts/match")
    .set(auth(anna))
    .send({ phones: ["0153 33333333"] })
    .expect(200);
  assert.deepEqual(legacy.body.matched.map((m) => m.phone), [CARL]);
});

test("status: availability push only reaches followers and shows the name", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN);
  await login(CARL);
  await User.updateMany({}, { pushToken: undefined });
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[ben]" });
  await User.updateOne({ phone: CARL }, { pushToken: "ExponentPushToken[carl]" });

  // Ben has Anna in his contacts, Carl does not
  await request(ctx.app).post("/contacts/match").set(auth(ben)).send({ hashes: [User.hashPhone(ANNA)] });

  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: true }).expect(200);
  await new Promise((r) => setTimeout(r, 50)); // broadcast runs async

  assert.equal(fakes.expoPushes.length, 1);
  assert.equal(fakes.expoPushes[0].to, "ExponentPushToken[ben]");
  assert.equal(fakes.expoPushes[0].title, "Anna ist erreichbar");
  assert.ok(!JSON.stringify(fakes.expoPushes[0]).includes("title\":\"+49"));

  await request(ctx.app).post("/status/set").set(auth(anna)).send({ isAvailable: "yes" }).expect(400);
});

test("moments: feed only shows own and contacts' moments", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await login(CARL);
  await request(ctx.app).post("/contacts/match").set(auth(anna)).send({ hashes: [User.hashPhone(BEN)] });

  const base = { screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "01:00" };
  await CallMoment.create({ ...base, userPhone: BEN, userName: "Ben", targetPhone: CARL, targetName: "C" });
  await CallMoment.create({ ...base, userPhone: CARL, userName: "Carl", targetPhone: BEN, targetName: "B" });

  const feed = await request(ctx.app).get("/moment/callmoments").set(auth(anna)).expect(200);
  assert.deepEqual(feed.body.callMoments.map((m) => m.userPhone), [BEN]);

  await request(ctx.app).get(`/moment/callmoments/${encodeURIComponent(CARL)}`).set(auth(anna)).expect(403);
});

test("moments: posting validates input and uses the token's phone", async () => {
  const anna = await login(ANNA);
  const body = { targetPhone: BEN, screenshot: "data:image/jpeg;base64,AAAA", mood: "😊" };
  await request(ctx.app).post("/moment/callmoment").set(auth(anna)).send({ ...body, screenshot: "file:///x.jpg" }).expect(400);
  await request(ctx.app).post("/moment/callmoment").set(auth(anna)).send({ ...body, userPhone: BEN }).expect(403);
  const res = await request(ctx.app).post("/moment/callmoment").set(auth(anna)).send(body).expect(200);
  assert.equal(res.body.callMoment.userPhone, ANNA);
});

test("moments: push broadcast needs the admin key; expired moments end", async () => {
  await request(ctx.app).post("/moment/push-broadcast").expect(403);

  await login(ANNA);
  await User.updateOne(
    { phone: ANNA },
    { isAvailable: true, momentActiveUntil: new Date(Date.now() - 1000), mood: "😊" },
  );
  assert.equal(await expireMoments(ctx.io), 1);
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.isAvailable, false);
  assert.equal(user.momentActiveUntil, null);
});

test("rtcToken: only for own account and own calls", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await Call.create({ callId: "c1", channel: "call_one", caller: ANNA, callee: BEN });

  const uid = ANNA.slice(1);
  await request(ctx.app).post("/rtcToken").set(auth(anna)).send({ channelName: "call_one", uid: BEN.slice(1) }).expect(403);
  await request(ctx.app).post("/rtcToken").set(auth(anna)).send({ channelName: "call_other", uid }).expect(403);
  const ok = await request(ctx.app).post("/rtcToken").set(auth(anna)).send({ channelName: "call_one", uid }).expect(200);
  assert.ok(ok.body.token);
});

function socketFor(token) {
  const socket = connect(ctx.url, { transports: ["websocket"], auth: token ? { token } : {} });
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test("socket: calls use the token's phone, create a Call and reach the callee", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN);
  const caller = await socketFor(anna);
  const callee = await socketFor(ben);
  try {
    const incoming = once(callee, "incomingCall");
    // A forged "from" is ignored for authenticated sockets
    caller.emit("callRequest", { from: CARL, to: BEN, channel: "call_abc" });
    const event = await incoming;
    assert.equal(event.from, ANNA);
    assert.equal(event.callerName, "Anna");
    assert.match(event.callId, /^[0-9a-f-]{36}$/);

    const call = await Call.findOne({ channel: "call_abc" });
    assert.equal(call.caller, ANNA);
    assert.equal(call.callee, BEN);

    // Same channel again is rejected
    const failed = once(caller, "callFailed");
    caller.emit("callRequest", { to: BEN, channel: "call_abc" });
    assert.equal((await failed).reason, "Channel already in use");

    // Hang-up reaches the other party
    const ended = once(callee, "callEnded");
    caller.emit("callEnded", { to: BEN, channel: "call_abc" });
    assert.equal((await ended).from, ANNA);
    assert.equal((await Call.findOne({ channel: "call_abc" })).status, "ended");
  } finally {
    caller.close();
    callee.close();
  }
});

test("socket: invalid tokens are refused; invalid channels fail", async () => {
  await assert.rejects(socketFor("garbage"));

  const anna = await login(ANNA);
  const caller = await socketFor(anna);
  try {
    const failed = once(caller, "callFailed");
    caller.emit("callRequest", { to: BEN, channel: "bad channel!" });
    assert.equal((await failed).reason, "Invalid call request");
  } finally {
    caller.close();
  }
});

test("legacy: the currently released app (no token) keeps working", async () => {
  // verify/check still succeeds; old apps ignore the token and call /auth/register
  await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(200);
  await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(200);
  await request(ctx.app).post("/auth/register").send({ phone: BEN, pushToken: "ExponentPushToken[b]" }).expect(200);

  await request(ctx.app).post("/me/update").send({ phone: ANNA, name: "Anna" }).expect(200);
  const me = await request(ctx.app).get(`/me?phone=${encodeURIComponent(ANNA)}`).expect(200);
  assert.equal(me.body.user.name, "Anna");

  const match = await request(ctx.app).post("/contacts/match").send({ phones: [BEN, "0151 11111111"] }).expect(200);
  assert.deepEqual(match.body.matched.map((m) => m.phone).sort(), [ANNA, BEN]);

  await request(ctx.app).post("/status/set").send({ phone: ANNA, isAvailable: true }).expect(200);
  await request(ctx.app).post("/user/push-token").send({ userPhone: ANNA, token: "ExponentPushToken[a]" }).expect(200);
  await request(ctx.app).post("/user/voip-token").send({ userPhone: ANNA, voipToken: "ab".repeat(32) }).expect(200);

  // The call screen strips the "+" from the user's own number
  await request(ctx.app)
    .post("/moment/callmoment")
    .send({ userPhone: ANNA.slice(1), targetPhone: BEN, screenshot: "data:image/jpeg;base64,AAAA", mood: "😊" })
    .expect(200);
  assert.equal((await CallMoment.findOne()).userPhone, ANNA);
  await request(ctx.app).get(`/moment/callmoments?userPhone=${encodeURIComponent(ANNA)}`).expect(200);

  // Socket without token: register + callRequest with payload phones
  const caller = await socketFor(null);
  const callee = await socketFor(null);
  try {
    caller.emit("register", ANNA);
    callee.emit("register", BEN);
    await new Promise((r) => setTimeout(r, 50));
    const incoming = once(callee, "incomingCall");
    caller.emit("callRequest", { from: ANNA, to: BEN, channel: "call_2aq" });
    assert.equal((await incoming).from, ANNA);

    const token = await request(ctx.app).post("/rtcToken").send({ channelName: "call_2aq", uid: ANNA.slice(1) }).expect(200);
    assert.ok(token.body.token);

    const ended = once(caller, "callEnded");
    callee.emit("callEnded", { from: BEN, to: ANNA, channel: "call_2aq" });
    assert.equal((await ended).from, BEN);
  } finally {
    caller.close();
    callee.close();
  }
});
