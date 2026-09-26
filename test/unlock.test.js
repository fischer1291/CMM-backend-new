const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes, talked } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const Call = require("../models/Call");
const CallMoment = require("../models/CallMoment");
const DailyMoment = require("../models/DailyMoment");
const MomentUnlock = require("../models/MomentUnlock");
const { unlockState, tickMomentsWaiting } = require("../lib/unlock");
const { localParts, shiftDateKey } = require("../lib/localTime");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  await MomentUnlock.syncIndexes();
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const TZ = "Europe/Berlin";
const MIN = 60 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: TZ });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const feed = async (token) => (await request(ctx.app).get("/moment/callmoments").set(auth(token)).expect(200)).body;
const CLOUD = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/moment/abc.jpg`;

async function friendsWithMoments() {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN, CARL] });
  await CallMoment.create({ userPhone: BEN, userName: "Ben", targetPhone: CARL, targetName: "Carl", screenshot: CLOUD, note: "Geheim", mood: "😊", callDuration: "05:00" });
  return anna;
}

test("locked feed: friends' moments come blurred, without note or reactions; old fields stay", async () => {
  const anna = await friendsWithMoments();
  const body = await feed(anna);
  assert.equal(body.locked, true);
  assert.equal(body.lockedCount, 1);
  assert.deepEqual(body.callMoments, []);
  assert.equal(body.lockedMoments.length, 1);
  const m = body.lockedMoments[0];
  assert.equal(m.userName, "Ben");
  assert.match(m.screenshot, /\/image\/upload\/e_blur:2000,q_30,w_240\/v1\/moment\/abc\.jpg$/);
  assert.equal(m.note, undefined);
  assert.equal(m.reactions, undefined);
  assert.deepEqual(body.unlock, { unlocked: false, via: null, streak: 0, best: 0, total: 0 });
});

test("unlock: a call of a minute or more, not a quick one; then everything is clear", async () => {
  const anna = await friendsWithMoments();
  const now = new Date();
  // 20 seconds: not enough
  await Call.create({ callId: "short", channel: "c1", caller: ANNA, callee: BEN, status: "ended", acceptedAt: new Date(now - 20 * 1000), endedAt: now });
  assert.equal((await feed(anna)).unlock.unlocked, false);

  await talked(ANNA, CARL); // two minutes
  const body = await feed(anna);
  assert.equal(body.unlock.unlocked, true);
  assert.equal(body.unlock.via, "talk");
  assert.equal(body.unlock.streak, 1);
  assert.deepEqual(body.lockedMoments, []);
  assert.equal(body.callMoments[0].note, "Geheim");
});

test("unlock: joining the Yap Moment unlocks too, and is recorded right away", async () => {
  const anna = await friendsWithMoments();
  const now = new Date();
  await DailyMoment.create({ day: localParts(now, TZ).dateKey, zone: TZ, at: new Date(now - MIN), endsAt: new Date(now.getTime() + 9 * MIN), sentAt: now });
  await request(ctx.app).post("/daily/join").set(auth(anna)).expect(200);
  assert.equal(await MomentUnlock.countDocuments({ phone: ANNA }), 1);
  const body = await feed(anna);
  assert.equal(body.unlock.via, "daily");
});

test("unlock: talks are recorded when they end (streak without opening the feed)", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  const start = new Date(Date.now() - 5 * MIN);
  const call = await Call.create({ callId: "c9", channel: "c9", caller: ANNA, callee: BEN, status: "accepted", acceptedAt: start });
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: call.channel });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await Talk.countDocuments(), 1);
  assert.deepEqual((await MomentUnlock.find().lean()).map((u) => u.phone).sort(), [ANNA, BEN]);
});

test("streak: days in a row up to today, or up to yesterday while today is open; best run", async () => {
  await login(ANNA, "Anna");
  const user = await User.findOne({ phone: ANNA });
  const today = localParts(new Date(), TZ).dateKey;
  const day = (n) => shiftDateKey(today, -n);
  for (const n of [1, 2, 3, 6, 7, 8, 9]) await MomentUnlock.create({ phone: ANNA, day: day(n), via: "talk" });

  let state = await unlockState(user);
  assert.deepEqual({ unlocked: state.unlocked, streak: state.streak, best: state.best, total: state.total }, { unlocked: false, streak: 3, best: 4, total: 7 });

  await MomentUnlock.create({ phone: ANNA, day: today, via: "daily" });
  state = await unlockState(user);
  assert.equal(state.streak, 4);
});

test("badges: curious after the first unlock, 'Immer dabei' by days", async () => {
  const anna = await login(ANNA, "Anna");
  const today = localParts(new Date(), TZ).dateKey;
  for (let n = 0; n < 7; n++) await MomentUnlock.create({ phone: ANNA, day: shiftDateKey(today, -n * 2), via: "talk" });
  const album = (await request(ctx.app).get("/me/badges").set(auth(anna)).expect(200)).body;
  const byId = Object.fromEntries(album.badges.map((b) => [b.id, b]));
  assert.equal(byId.curious.earned, true);
  assert.equal(byId.unlocker.tier, 1);
  assert.equal(byId.unlocker.tierName, "Bronze");
});

test("evening push: around 19:00 local time, once, only when something waits and it's still locked", async () => {
  await friendsWithMoments();
  await User.updateOne({ phone: ANNA }, { pushToken: "ExponentPushToken[anna]", "notificationPrefs.quietHours.enabled": false });
  // 19:05 in Berlin (UTC+2 in September)
  const evening = new Date(Date.UTC(2026, 8, 26, 17, 5));
  await CallMoment.updateMany({}, { timestamp: new Date(evening - 60 * MIN), sharedAt: new Date(evening - 60 * MIN) });

  assert.equal(await tickMomentsWaiting(new Date(Date.UTC(2026, 8, 26, 15, 0))), 0, "17:00: too early");
  assert.equal(await tickMomentsWaiting(evening), 1);
  assert.equal(fakes.expoPushes.at(-1).title, "Ein Moment wartet auf dich 🔒");
  assert.equal(await tickMomentsWaiting(new Date(evening.getTime() + 5 * MIN)), 0, "once a day");

  // Opted out of moment pushes: nothing
  await User.updateOne({ phone: ANNA }, { "notificationPrefs.moments": false });
  await require("../models/PushLog").deleteMany({});
  assert.equal(await tickMomentsWaiting(evening), 0);
});
