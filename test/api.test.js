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
  assert.equal(health.body.agoraCertificateFromEnv, true);
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
  // Independent of the time the tests run
  await User.updateMany({}, { "notificationPrefs.quietHours.enabled": false });

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

test("moments: the random push broadcast is gone; expired moments end", async () => {
  await request(ctx.app).post("/moment/push-broadcast").set("X-Admin-Key", "admin-key").expect(404);

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
const once = (socket, event, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

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

    // Ben is ringing, so a second call to him is busy
    const failed = once(caller, "callFailed");
    caller.emit("callRequest", { to: BEN, channel: "call_def" });
    assert.equal((await failed).reason, "busy");

    // Caller hangs up while ringing: cancelled, callee stops ringing
    const ended = once(callee, "callEnded");
    caller.emit("callEnded", { to: BEN, channel: "call_abc" });
    const endedEvent = await ended;
    assert.equal(endedEvent.from, ANNA);
    assert.equal(endedEvent.reason, "cancelled");
    assert.equal((await Call.findOne({ channel: "call_abc" })).status, "cancelled");
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
    assert.equal((await failed).reason, "invalid");
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

    // Released apps only listen for callEnded; a decline arrives that way
    const declined = once(caller, "callEnded");
    callee.emit("callEnded", { from: BEN, to: ANNA, channel: "call_2aq" });
    const event = await declined;
    assert.equal(event.from, BEN);
    assert.equal(event.reason, "declined");
  } finally {
    caller.close();
    callee.close();
  }
});

/** Two logged-in, connected users (Anna calls Ben). */
async function twoUsers() {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const caller = await socketFor(anna);
  const callee = await socketFor(ben);
  return { anna, ben, caller, callee, close: () => (caller.close(), callee.close()) };
}

async function ring(caller, callee, channel) {
  const incoming = once(callee, "incomingCall");
  caller.emit("callRequest", { to: BEN, channel });
  return incoming;
}

test("calls: callee declines while ringing -> caller gets callEnded(declined)", async () => {
  const { caller, callee, close } = await twoUsers();
  try {
    await ring(caller, callee, "call_decline");
    const declined = once(caller, "callEnded");
    callee.emit("callEnded", { to: ANNA, channel: "call_decline" });
    const event = await declined;
    assert.equal(event.from, BEN);
    assert.equal(event.reason, "declined");
    assert.equal((await Call.findOne({ channel: "call_decline" })).status, "declined");
  } finally {
    close();
  }
});

test("calls: accept, then hang up -> ended with duration, history per side", async () => {
  const { anna, ben, caller, callee, close } = await twoUsers();
  try {
    await ring(caller, callee, "call_talk");
    const accepted = once(caller, "callAccepted");
    callee.emit("acceptCall", { from: ANNA, channel: "call_talk" });
    assert.equal((await accepted).from, BEN);

    const ended = once(callee, "callEnded");
    caller.emit("callEnded", { to: BEN, channel: "call_talk" });
    assert.equal((await ended).reason, "hangup");

    const call = await Call.findOne({ channel: "call_talk" });
    assert.equal(call.status, "ended");
    assert.ok(call.acceptedAt && call.endedAt);

    const annaHistory = await request(ctx.app).get("/calls").set(auth(anna)).expect(200);
    assert.equal(annaHistory.body.calls[0].direction, "outgoing");
    assert.equal(annaHistory.body.calls[0].otherPhone, BEN);
    const benHistory = await request(ctx.app).get("/calls").set(auth(ben)).expect(200);
    assert.equal(benHistory.body.calls[0].direction, "incoming");
    await request(ctx.app).get("/calls").expect(401);
  } finally {
    close();
  }
});

test("calls: no answer -> missed for both sides plus a missed-call push", async () => {
  const { caller, callee, close } = await twoUsers();
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[ben]" });
  try {
    await ring(caller, callee, "call_nobody");
    const missed = once(caller, "callEnded", 4000);
    const calleeEnded = once(callee, "callEnded", 4000);
    const missedEvent = await missed;
    assert.equal(missedEvent.channel, "call_nobody");
    assert.equal(missedEvent.reason, "missed");
    assert.equal((await calleeEnded).reason, "missed");
    assert.equal((await Call.findOne({ channel: "call_nobody" })).status, "missed");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fakes.expoPushes.some((p) => p.title === "Verpasster Anruf" && p.body.startsWith("Anna")));
  } finally {
    close();
  }
});

test("calls: accepting after the caller cancelled makes the callee hang up", async () => {
  const { caller, callee, close } = await twoUsers();
  try {
    await ring(caller, callee, "call_late");
    const cancelled = once(callee, "callEnded");
    caller.emit("callEnded", { to: BEN, channel: "call_late" });
    await cancelled;

    const late = once(callee, "callEnded");
    callee.emit("acceptCall", { from: ANNA, channel: "call_late" });
    assert.equal((await late).reason, "unavailable");
    assert.equal((await Call.findOne({ channel: "call_late" })).status, "cancelled");
  } finally {
    close();
  }
});

test("calls: a cancelled call is replayed to a device that connects right after", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN);
  // Ben is offline but reachable by push (e.g. woken by VoIP)
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[ben]" });
  const caller = await socketFor(anna);
  try {
    caller.emit("callRequest", { to: BEN, channel: "call_replay" });
    await new Promise((r) => setTimeout(r, 100));
    caller.emit("callEnded", { to: BEN, channel: "call_replay" });
    await new Promise((r) => setTimeout(r, 100));

    const callee = await socketFor(ben);
    try {
      const replay = once(callee, "callEnded");
      callee.emit("register", BEN);
      const event = await replay;
      assert.equal(event.channel, "call_replay");
      assert.equal(event.reason, "cancelled");
    } finally {
      callee.close();
    }
  } finally {
    caller.close();
  }
});

test("calls: unreachable callee (offline, no push token) fails immediately", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await User.updateOne({ phone: BEN }, { $unset: { pushToken: 1, voipToken: 1 } });
  const caller = await socketFor(anna);
  try {
    const failed = once(caller, "callFailed");
    caller.emit("callRequest", { to: BEN, channel: "call_void" });
    assert.equal((await failed).reason, "unreachable");
    assert.equal((await Call.findOne({ channel: "call_void" })).status, "missed");
  } finally {
    caller.close();
  }
});

test("calls: the callee fetching an RTC token counts as accepting", async () => {
  const { ben, caller, callee, close } = await twoUsers();
  try {
    await ring(caller, callee, "call_token");
    const accepted = once(caller, "callAccepted");
    await request(ctx.app)
      .post("/rtcToken")
      .set(auth(ben))
      .send({ channelName: "call_token", uid: BEN.slice(1), role: "publisher" })
      .expect(200);
    assert.equal((await accepted).from, BEN);
    assert.equal((await Call.findOne({ channel: "call_token" })).status, "accepted");

    // ...so the ring timeout no longer ends it
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal((await Call.findOne({ channel: "call_token" })).status, "accepted");
  } finally {
    close();
  }
});

test("calls: declining over HTTP works without a socket (lock screen, app just woken)", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  // Ben is only reachable by push: no socket connected
  await User.updateOne({ phone: BEN }, { pushToken: "ExponentPushToken[ben]" });
  const caller = await socketFor(anna);
  try {
    caller.emit("callRequest", { to: BEN, channel: "call_http" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await Call.findOne({ channel: "call_http" })).status, "ringing");

    await request(ctx.app).post("/calls/end").send({ channel: "call_http", other: ANNA }).expect(401);
    await request(ctx.app).post("/calls/end").set(auth(ben)).send({ channel: "call_http" }).expect(400);

    // Someone else can't end it
    const foreign = await request(ctx.app).post("/calls/end").set(auth(carl)).send({ channel: "call_http", other: ANNA }).expect(200);
    assert.equal(foreign.body.status, null);

    const declined = once(caller, "callEnded");
    const res = await request(ctx.app).post("/calls/end").set(auth(ben)).send({ channel: "call_http", other: ANNA }).expect(200);
    assert.equal(res.body.status, "declined");
    assert.equal((await declined).reason, "declined");

    // The socket event arriving later changes nothing
    const again = await request(ctx.app).post("/calls/end").set(auth(ben)).send({ channel: "call_http", other: ANNA }).expect(200);
    assert.equal(again.body.status, null);
    assert.equal((await Call.findOne({ channel: "call_http" })).status, "declined");
  } finally {
    caller.close();
  }
});

test("calls: the caller can cancel over HTTP; the callee's device hears about it", async () => {
  const { anna, caller, callee, close } = await twoUsers();
  try {
    await ring(caller, callee, "call_cancel_http");
    const cancelled = once(callee, "callEnded");
    const res = await request(ctx.app)
      .post("/calls/end")
      .set(auth(anna))
      .send({ channel: "call_cancel_http", other: BEN })
      .expect(200);
    assert.equal(res.body.status, "cancelled");
    assert.equal((await cancelled).reason, "cancelled");
  } finally {
    close();
  }
});

test("verify: App Store review login works only when configured, without SMS", async () => {
  const REVIEW = "+4915999999999";
  // Not configured: normal SMS flow
  await request(ctx.app).post("/verify/start").send({ phone: REVIEW }).expect(200);
  assert.deepEqual(fakes.sms, [REVIEW]);

  process.env.REVIEW_PHONE = REVIEW;
  process.env.REVIEW_CODE = "246810";
  try {
    fakes.sms.length = 0;
    await request(ctx.app).post("/verify/start").send({ phone: "0159 99999999" }).expect(200);
    assert.deepEqual(fakes.sms, [], "no SMS for the review number");
    const wrong = await request(ctx.app).post("/verify/check").send({ phone: REVIEW, code: "123456" });
    assert.equal(wrong.body.success, false, "the Twilio test code must not work here");
    const ok = await request(ctx.app).post("/verify/check").send({ phone: REVIEW, code: "246810" }).expect(200);
    assert.ok(ok.body.token);
    // Other numbers are unaffected
    const other = await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: "246810" });
    assert.equal(other.body.success, false);

    // A too short code disables it
    process.env.REVIEW_CODE = "12";
    const short = await request(ctx.app).post("/verify/check").send({ phone: REVIEW, code: "12" });
    assert.equal(short.status, 400);
  } finally {
    delete process.env.REVIEW_PHONE;
    delete process.env.REVIEW_CODE;
  }
});
