const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const PushTicket = require("../models/PushTicket");
const { notify, notifyMany, DAILY_SOCIAL_CAP } = require("../lib/notify");
const { checkReceipts, RECEIPT_DELAY_MS } = require("../lib/receipts");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const TOKEN = (who) => `ExponentPushToken[${who}]`;

// 14:00 and 23:30 in Berlin (CEST)
const AFTERNOON = new Date("2026-09-23T12:00:00Z");
const NIGHT = new Date("2026-09-23T21:30:00Z");

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, pushToken: TOKEN(phone.slice(-1)), timezone: "Europe/Berlin" });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("catalog: availability push has channel, category, deep link and a short TTL", async () => {
  await login(BEN, "Ben");
  const result = await notify(BEN, "contact_available", { phone: ANNA, name: "Anna Berg" }, { now: AFTERNOON });
  assert.equal(result.sent, true);
  const [push] = fakes.expoPushes;
  assert.equal(push.title, "Anna ist erreichbar");
  assert.equal(push.channelId, "availability");
  assert.equal(push.categoryId, "contact_available");
  assert.equal(push.ttl, 15 * 60);
  assert.equal(push.data.url, `/friend?phone=${encodeURIComponent(ANNA)}`);
  assert.equal(push.sound, "default");
  assert.ok(!push.title.includes("+49"));
});

test("catalog: availability is throttled per person, others still get through", async () => {
  await login(BEN, "Ben");
  assert.equal((await notify(BEN, "contact_available", { phone: ANNA, name: "Anna" }, { now: AFTERNOON })).sent, true);
  const again = await notify(BEN, "contact_available", { phone: ANNA, name: "Anna" }, { now: AFTERNOON });
  assert.equal(again.skipped, "throttled");
  assert.equal((await notify(BEN, "contact_available", { phone: CARL, name: "Carl" }, { now: AFTERNOON })).sent, true);
  assert.equal(fakes.expoPushes.length, 2);
});

test("catalog: opt-out, quiet hours and the daily cap", async () => {
  const ben = await login(BEN, "Ben");
  await login(CARL, "Carl");

  await request(ctx.app).put("/me/notifications").set(auth(ben)).send({ available: false }).expect(200);
  let [result] = await notifyMany([BEN], "contact_available", { phone: ANNA, name: "Anna" }, { now: AFTERNOON });
  assert.equal(result.skipped, "opted_out");

  // Social pushes wait out the night; a missed call arrives, but silently
  result = await notify(CARL, "nudge", { phone: ANNA, name: "Anna" }, { now: NIGHT });
  assert.equal(result.skipped, "quiet_hours");
  result = await notify(CARL, "missed_call", { phone: ANNA, name: "Anna" }, { now: NIGHT });
  assert.equal(result.sent, true);
  const missed = fakes.expoPushes.at(-1);
  assert.equal(missed.interruptionLevel, "passive");
  assert.equal(missed.sound, undefined);

  for (let i = 0; i < DAILY_SOCIAL_CAP; i++) {
    await notify(CARL, "nudge", { phone: `+49151000000${i}`, name: "X" }, { now: AFTERNOON });
  }
  result = await notify(CARL, "moment_shared", { phone: ANNA, name: "Anna" }, { now: AFTERNOON });
  assert.equal(result.skipped, "daily_cap");
});

test("prefs: defaults, validation and personal quiet hours", async () => {
  const ben = await login(BEN, "Ben");
  await request(ctx.app).get("/me/notifications").expect(401);
  const initial = await request(ctx.app).get("/me/notifications").set(auth(ben)).expect(200);
  assert.deepEqual(initial.body.prefs, {
    available: true,
    nudges: true,
    moments: true,
    quietHours: { enabled: true, start: 1320, end: 480 },
  });

  await request(ctx.app).put("/me/notifications").set(auth(ben)).send({ nudges: "no" }).expect(400);
  await request(ctx.app)
    .put("/me/notifications")
    .set(auth(ben))
    .send({ quietHours: { enabled: true, start: 1500, end: 60 } })
    .expect(400);
  const saved = await request(ctx.app)
    .put("/me/notifications")
    .set(auth(ben))
    .send({ moments: false, quietHours: { enabled: true, start: 13 * 60, end: 15 * 60 } })
    .expect(200);
  assert.equal(saved.body.prefs.moments, false);
  assert.equal(saved.body.prefs.nudges, true);

  // 14:00 is now inside Ben's quiet hours, 23:30 is not
  assert.equal((await notify(BEN, "nudge", { phone: ANNA, name: "A" }, { now: AFTERNOON })).skipped, "quiet_hours");
  assert.equal((await notify(BEN, "nudge", { phone: ANNA, name: "A" }, { now: NIGHT })).sent, true);
});

test("logout: removes this device's tokens so it stops getting pushes and calls", async () => {
  const ben = await login(BEN, "Ben");
  await User.updateOne({ phone: BEN }, { voipToken: "ab".repeat(32) });

  // Tokens of another device stay
  await request(ctx.app).post("/auth/logout").set(auth(ben)).send({ pushToken: TOKEN("other") }).expect(200);
  let user = await User.findOne({ phone: BEN });
  assert.equal(user.pushToken, TOKEN("2"));
  assert.equal(user.voipToken, "ab".repeat(32));

  await request(ctx.app)
    .post("/auth/logout")
    .set(auth(ben))
    .send({ pushToken: TOKEN("2"), voipToken: "ab".repeat(32) })
    .expect(200);
  user = await User.findOne({ phone: BEN });
  assert.equal(user.pushToken, undefined);
  assert.equal(user.voipToken, undefined);

  // Older apps send nothing: everything goes
  await User.updateOne({ phone: BEN }, { pushToken: TOKEN("2"), voipToken: "cd".repeat(32) });
  await request(ctx.app).post("/auth/logout").set(auth(ben)).send({}).expect(200);
  user = await User.findOne({ phone: BEN });
  assert.equal(user.pushToken, undefined);
  assert.equal(user.voipToken, undefined);
  await request(ctx.app).post("/auth/logout").expect(401);
});

test("push-token: stores the device time zone", async () => {
  const ben = await login(BEN, "Ben");
  await request(ctx.app)
    .post("/user/push-token")
    .set(auth(ben))
    .send({ token: TOKEN("new"), deviceId: "d", platform: "ios", timezone: "America/New_York" })
    .expect(200);
  assert.equal((await User.findOne({ phone: BEN })).timezone, "America/New_York");
  await request(ctx.app)
    .post("/user/push-token")
    .set(auth(ben))
    .send({ token: TOKEN("new"), timezone: "Nowhere/City" })
    .expect(200);
  assert.equal((await User.findOne({ phone: BEN })).timezone, "America/New_York");
});

test("receipts: DeviceNotRegistered removes the token; checked tickets are cleared", async () => {
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  await notifyMany([BEN, CARL], "missed_call", { phone: ANNA, name: "Anna" }, { now: AFTERNOON });
  const tickets = await PushTicket.find().sort({ ticketId: 1 });
  assert.equal(tickets.length, 2);
  const benTicket = tickets.find((t) => t.token === TOKEN("2"));
  const carlTicket = tickets.find((t) => t.token === TOKEN("3"));
  fakes.receipts[benTicket.ticketId] = { status: "error", details: { error: "DeviceNotRegistered" } };
  fakes.receipts[carlTicket.ticketId] = { status: "ok" };

  // Too early: receipts aren't ready yet
  assert.equal((await checkReceipts(new Date())).checked, 0);

  const later = new Date(Date.now() + RECEIPT_DELAY_MS + 1000);
  const result = await checkReceipts(later);
  assert.deepEqual(result, { checked: 2, removedTokens: 1, errors: 1 });
  assert.equal((await User.findOne({ phone: BEN })).pushToken, undefined);
  assert.equal((await User.findOne({ phone: CARL })).pushToken, TOKEN("3"));
  assert.equal(await PushTicket.countDocuments(), 0);
});

test("moments: the other person hears about a shared moment only if they know the author", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  await User.updateMany({}, { "notificationPrefs.quietHours.enabled": false });
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });

  const post = (targetPhone) =>
    request(ctx.app)
      .post("/moment/callmoment")
      .set(auth(anna))
      .send({ targetPhone, screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "05:00" })
      .expect(200);
  await post(BEN);
  await post(CARL);
  await new Promise((r) => setTimeout(r, 100));

  const moments = fakes.expoPushes.filter((p) => p.data?.type === "moment_shared");
  assert.deepEqual(moments.map((p) => p.to), [TOKEN("2")]);
  assert.equal(moments[0].data.url, "/callmoments");
});
