// Sign-in, devices and recycled numbers (plan 2.9, routes/verify.js,
// lib/devices.js): /verify/check stores the device and lastVerifiedAt, an
// account quiet for half a year asks "Ist das dein Konto?" on an unknown
// device, /verify/account-check answers it once, new_device tells the other
// device, GET /me/devices and POST /me/logout-all.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { Types } = require("mongoose");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const ActiveDay = require("../models/ActiveDay");
const ArchivedAccount = require("../models/ArchivedAccount");
const { signToken } = require("../lib/auth");
const { localParts } = require("../lib/localTime");
const { RECYCLE_AFTER_DAYS } = require("../routes/verify");
const { MAX_DEVICES } = require("../lib/devices");
const { countsOf } = require("../lib/opsCounters");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const DAY = 24 * 3600 * 1000;
const PUSH_A = "ExponentPushToken[device-a]";
const VOIP_B = "b".repeat(64);

const deviceHeaders = (id, model = "iPhone 15") => ({
  "X-Device-Id": id,
  "X-Device-Model": model,
  "X-App-Version": "1.4.0",
  "X-App-Build": "77",
  "X-Platform": "ios",
});
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const check = (phone, headers = {}) => request(ctx.app).post("/verify/check").set(headers).send({ phone, code: fakes.approvedCode }).expect(200);
const answer = (phone, checkToken, reply, headers = {}, extra = {}) => request(ctx.app).post("/verify/account-check").set(headers).send({ phone, checkToken, answer: reply, ...extra });
const idAt = (date) => new Types.ObjectId(Math.floor(date.getTime() / 1000));
const dayKey = (date) => localParts(date, "Europe/Berlin").dateKey;

/** Wait for a fire-and-forget write. */
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** An account that was last used `daysAgo` days ago, known on device "old-device". */
async function quietAccount(phone, daysAgo, extra = {}) {
  const last = new Date(Date.now() - daysAgo * DAY);
  await User.create({
    _id: idAt(new Date(last.getTime() - 30 * DAY)),
    phone,
    phoneHash: User.hashPhone(phone),
    phoneHmac: User.hmacPhone(phone),
    name: "Anna Alt",
    avatarUrl: "https://res.cloudinary.com/testcloud/image/upload/avatars/avatar_4915111111111.jpg",
    pushToken: PUSH_A,
    pushTokenMetadata: { deviceId: "old-device", platform: "ios" },
    devices: [{ id: "old-device", model: "iPhone 8", firstSeenAt: last, lastSeenAt: last }],
    ...extra,
  });
  await ActiveDay.create({ day: dayKey(last), who: User.hmacPhone(phone), at: last });
  return last;
}

test("verify: a sign-in stores the device and lastVerifiedAt, once per device", async () => {
  const before = Date.now();
  const res = await check(ANNA, deviceHeaders("dev-a"));
  assert.ok(res.body.token);
  let user = await User.findOne({ phone: ANNA }).lean();
  assert.ok(user.lastVerifiedAt.getTime() >= before);
  assert.equal(user.devices.length, 1);
  assert.deepEqual(
    { id: user.devices[0].id, model: user.devices[0].model, platform: user.devices[0].platform, appVersion: user.devices[0].appVersion, appBuild: user.devices[0].appBuild },
    { id: "dev-a", model: "iPhone 15", platform: "ios", appVersion: "1.4.0", appBuild: "77" },
  );

  // The same device again: one entry, refreshed; a malformed id is ignored
  await check(ANNA, deviceHeaders("dev-a", "iPhone 15 Pro"));
  await check(ANNA, deviceHeaders("bad id!"));
  user = await User.findOne({ phone: ANNA }).lean();
  assert.deepEqual(user.devices.map((d) => [d.id, d.model]), [["dev-a", "iPhone 15 Pro"]]);

  // At most ten: the least recently seen falls out
  for (let i = 0; i < MAX_DEVICES; i++) await check(ANNA, deviceHeaders(`dev-${i}`));
  user = await User.findOne({ phone: ANNA }).lean();
  assert.equal(user.devices.length, MAX_DEVICES);
  assert.ok(!user.devices.some((d) => d.id === "dev-a"));

  // The export names the devices
  const exported = (await request(ctx.app).get("/me/export").set(auth(res.body.token)).expect(200)).body.data;
  assert.equal(exported.devices.signedIn.length, MAX_DEVICES);
  assert.ok(exported.devices.lastVerifiedAt);
});

test("verify: an authenticated request adds its device, at most every six hours", async () => {
  const token = (await check(ANNA)).body.token;
  await request(ctx.app).get("/me").set(auth(token)).set(deviceHeaders("dev-x", "iPad")).expect(200);
  assert.ok(await until(async () => (await User.findOne({ phone: ANNA }).lean()).devices.some((d) => d.id === "dev-x")));
  const first = (await User.findOne({ phone: ANNA }).lean()).devices[0].lastSeenAt;
  await request(ctx.app).get("/me").set(auth(token)).set(deviceHeaders("dev-x", "iPad")).expect(200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await User.findOne({ phone: ANNA }).lean()).devices[0].lastSeenAt.getTime(), first.getTime());
});

test("verify: a quiet account asks on an unknown device, not on a known one", async () => {
  const last = await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  const asked = await check(ANNA, deviceHeaders("new-device"));
  assert.equal(asked.body.success, true);
  assert.equal(asked.body.token, undefined);
  assert.deepEqual(asked.body.accountCheck, {
    name: "Anna",
    avatarUrl: "https://res.cloudinary.com/testcloud/image/upload/avatars/avatar_4915111111111.jpg",
    lastActiveMonth: dayKey(last).slice(0, 7),
  });
  assert.match(asked.body.checkToken, /^[a-f0-9]{32}\.\d{13}\.[a-f0-9]{64}$/);
  const user = await User.findOne({ phone: ANNA }).lean();
  assert.ok(user.accountCheck.nonce);
  assert.equal(user.lastVerifiedAt, null);
  assert.equal(fakes.expoPushes.length, 0);

  // An app from before plan 2.9 (no X-Device-Id) cannot show the question:
  // it signs in as before (the returning owner is never locked out while the
  // app update is not out yet), without a new_device push, and is counted
  const old = await check(ANNA);
  assert.equal(old.body.success, true);
  assert.ok(old.body.token);
  assert.equal(old.body.accountCheck, undefined);
  assert.equal(fakes.expoPushes.length, 0);
  assert.ok(await until(async () => (await countsOf(dayKey(new Date()))).accountCheckNoDevice === 1));
  assert.equal((await countsOf(dayKey(new Date()))).accountCheckAsked, 1);

  // The known device signs in right away
  const known = await check(ANNA, deviceHeaders("old-device"));
  assert.ok(known.body.token);
});

test("verify: recent use, no name and picture, or the review login: no question", async () => {
  await quietAccount(ANNA, 30);
  assert.ok((await check(ANNA, deviceHeaders("new-device"))).body.token);

  await quietAccount(BEN, RECYCLE_AFTER_DAYS + 20, { name: "", avatarUrl: "" });
  assert.ok((await check(BEN, deviceHeaders("new-device"))).body.token);

  await User.deleteMany({});
  await ActiveDay.deleteMany({});
  await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  Object.assign(process.env, { REVIEW_PHONE: ANNA, REVIEW_CODE: "246810" });
  try {
    const res = await request(ctx.app).post("/verify/check").set(deviceHeaders("new-device")).send({ phone: ANNA, code: "246810" }).expect(200);
    assert.ok(res.body.token);
  } finally {
    delete process.env.REVIEW_PHONE;
    delete process.env.REVIEW_CODE;
  }
});

test("verify: without an ActiveDay the last online time decides", async () => {
  await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  await ActiveDay.deleteMany({});
  await User.updateOne({ phone: ANNA }, { lastOnline: new Date(Date.now() - 10 * DAY) });
  assert.ok((await check(ANNA, deviceHeaders("new-device"))).body.token);
});

test("verify: 'mine' signs in once, tells the old device, stores the new one", async () => {
  await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  const { checkToken } = (await check(ANNA, deviceHeaders("new-device", "iPhone 16"))).body;

  const res = await answer(ANNA, checkToken, "mine", deviceHeaders("new-device", "iPhone 16")).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.name, "Anna Alt");
  await request(ctx.app).get("/me").set(auth(res.body.token)).expect(200);

  const user = await User.findOne({ phone: ANNA }).lean();
  assert.deepEqual(user.devices.map((d) => d.id).sort(), ["new-device", "old-device"]);
  assert.ok(user.lastVerifiedAt);
  assert.equal(user.accountCheck.nonce, null);

  // new_device went to the token of the other device
  const push = fakes.expoPushes.find((m) => m.data?.type === "new_device");
  assert.ok(push);
  assert.equal(push.to, PUSH_A);
  assert.equal(push.title, "Neue Anmeldung");
  assert.match(push.body, /\(iPhone 16\)/);
  assert.equal(push.data.url, "/settings");

  // Used once
  const again = await answer(ANNA, checkToken, "mine").expect(401);
  assert.equal(again.body.error, "check_expired");
});

test("verify: 'not_mine' archives and deletes the old account, the new holder starts fresh", async () => {
  await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  await User.create({ phone: BEN, phoneHash: User.hashPhone(BEN), contacts: [ANNA], connections: [ANNA] });
  // A token from the old holder's time, still within its lifetime
  const oldToken = signToken(ANNA, { issuedAt: new Date(Date.now() - 3600 * 1000) });
  const oldId = (await User.findOne({ phone: ANNA }).lean())._id;

  const { checkToken } = (await check(ANNA, deviceHeaders("new-device"))).body;
  const res = await answer(ANNA, checkToken, "not_mine", deviceHeaders("new-device"), { ageConfirmed: true, termsVersion: "1", privacyVersion: "2026-09-01" }).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.name, "");

  const archived = await ArchivedAccount.find().lean();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].phoneHmac, User.hmacPhone(ANNA));
  assert.equal(archived[0].export.profile.name, "Anna Alt");
  assert.equal(archived[0].export.profile.phone, ANNA);

  const fresh = await User.findOne({ phone: ANNA }).lean();
  assert.notEqual(String(fresh._id), String(oldId));
  assert.equal(fresh.name, undefined);
  assert.equal(fresh.pushToken, undefined);
  assert.deepEqual(fresh.devices.map((d) => d.id), ["new-device"]);
  assert.ok(fresh.consent.ageConfirmedAt);
  assert.equal(await ActiveDay.countDocuments({ who: User.hmacPhone(ANNA) }), 0);
  const ben = await User.findOne({ phone: BEN }).lean();
  assert.deepEqual(ben.contacts, []);
  assert.deepEqual(ben.connections, []);
  // No push for the old holder: the account is gone
  assert.equal(fakes.expoPushes.filter((m) => m.data?.type === "new_device").length, 0);

  await request(ctx.app).get("/me").set(auth(oldToken)).expect(401);
  await request(ctx.app).get("/me").set(auth(res.body.token)).expect(200);
});

test("verify: an expired, foreign or forged checkToken is refused", async () => {
  await quietAccount(ANNA, RECYCLE_AFTER_DAYS + 20);
  const { checkToken } = (await check(ANNA, deviceHeaders("new-device"))).body;

  assert.equal((await answer(BEN, checkToken, "mine").expect(401)).body.error, "check_expired");
  assert.equal((await answer(ANNA, "nonsense", "mine").expect(401)).body.error, "check_expired");
  const [nonce, untilMs, sig] = checkToken.split(".");
  const forged = `${nonce}.${Number(untilMs) + 60000}.${sig}`;
  assert.equal((await answer(ANNA, forged, "mine").expect(401)).body.error, "check_expired");
  await answer(ANNA, checkToken, "maybe").expect(400);

  // A newer question replaces the older one
  const second = (await check(ANNA, deviceHeaders("new-device"))).body.checkToken;
  await answer(ANNA, checkToken, "mine").expect(401);

  // Past its ten minutes
  await User.updateOne({ phone: ANNA }, { "accountCheck.until": new Date(Date.now() - 1000) });
  await answer(ANNA, second, "mine").expect(401);
  assert.equal(await User.countDocuments({ phone: ANNA, name: "Anna Alt" }), 1);
});

test("verify: new_device goes to the other device's token, not on the same device", async () => {
  await check(ANNA, deviceHeaders("dev-a"));
  const tokenA = (await check(ANNA, deviceHeaders("dev-a"))).body.token;
  await request(ctx.app).post("/user/push-token").set(auth(tokenA)).set(deviceHeaders("dev-a")).send({ token: PUSH_A, deviceId: "ios-name", platform: "ios" }).expect(200);
  assert.equal((await User.findOne({ phone: ANNA }).lean()).pushTokenMetadata.deviceId, "dev-a");

  await check(ANNA, deviceHeaders("dev-a"));
  assert.equal(fakes.expoPushes.length, 0);

  await check(ANNA, deviceHeaders("dev-b", "iPad Air"));
  assert.equal(fakes.expoPushes.length, 1);
  assert.equal(fakes.expoPushes[0].to, PUSH_A);
  assert.equal(fakes.expoPushes[0].data.type, "new_device");
  assert.match(fakes.expoPushes[0].body, /\(iPad Air\)/);

  // Known now: no second push
  await check(ANNA, deviceHeaders("dev-b"));
  assert.equal(fakes.expoPushes.length, 1);
});

test("verify: no new_device when it is unclear whose the token is", async () => {
  // An account from before plan 2.9: push token with the old body deviceId,
  // no device list yet
  await User.create({
    phone: ANNA,
    phoneHash: User.hashPhone(ANNA),
    phoneHmac: User.hmacPhone(ANNA),
    name: "Anna",
    pushToken: PUSH_A,
    pushTokenMetadata: { deviceId: "ios-Annas iPhone-17.5", platform: "ios" },
  });
  // Re-verification from an app without X-Device-Id (logout, reinstall)
  assert.ok((await check(ANNA)).body.token);
  assert.equal(fakes.expoPushes.length, 0);
  // The first sign-in with the updated app: nothing to compare yet
  assert.ok((await check(ANNA, deviceHeaders("dev-a"))).body.token);
  assert.equal(fakes.expoPushes.length, 0);
  // A list exists now, but the token is still registered under the old
  // body deviceId: it may sit on the signing-in phone itself
  assert.ok((await check(ANNA, deviceHeaders("dev-b"))).body.token);
  assert.equal(fakes.expoPushes.length, 0);
  // Once the app registers its token with X-Device-Id, another device is told
  const token = (await check(ANNA, deviceHeaders("dev-a"))).body.token;
  await request(ctx.app).post("/user/push-token").set(auth(token)).set(deviceHeaders("dev-a")).send({ token: PUSH_A, platform: "ios" }).expect(200);
  await check(ANNA, deviceHeaders("dev-c"));
  assert.deepEqual(fakes.expoPushes.map((m) => [m.to, m.data?.type]), [[PUSH_A, "new_device"]]);
});

test("me/devices: the list, most recent first, with the current device", async () => {
  await check(ANNA, deviceHeaders("dev-a", "iPhone 12"));
  await new Promise((r) => setTimeout(r, 10));
  const token = (await check(ANNA, deviceHeaders("dev-b", "iPhone 16"))).body.token;
  const { body } = await request(ctx.app).get("/me/devices").set(auth(token)).set("X-Device-Id", "dev-b").expect(200);
  assert.equal(body.success, true);
  assert.deepEqual(body.devices.map((d) => [d.id, d.model, d.current]), [["dev-b", "iPhone 16", true], ["dev-a", "iPhone 12", false]]);
  assert.deepEqual(Object.keys(body.devices[0]).sort(), ["appBuild", "appVersion", "current", "id", "lastSeenAt", "model", "platform"]);
  await request(ctx.app).get("/me/devices").expect(401);
});

test("me/logout-all: other sessions end, foreign tokens go, the caller gets a fresh token", async () => {
  const tokenA = (await check(ANNA, deviceHeaders("dev-a"))).body.token;
  await request(ctx.app).post("/user/push-token").set(auth(tokenA)).set(deviceHeaders("dev-a")).send({ token: PUSH_A, platform: "ios" }).expect(200);
  const tokenB = (await check(ANNA, deviceHeaders("dev-b"))).body.token;
  await User.updateOne({ phone: ANNA }, { voipToken: VOIP_B, voipTokenMetadata: { deviceId: "dev-b" } });
  // Both work before
  await request(ctx.app).get("/me").set(auth(tokenA)).expect(200);

  const res = await request(ctx.app).post("/me/logout-all").set(auth(tokenB)).set(deviceHeaders("dev-b")).send({ voipToken: VOIP_B }).expect(200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.token);

  await request(ctx.app).get("/me").set(auth(tokenA)).expect(401);
  await request(ctx.app).get("/me").set(auth(tokenB)).expect(401);
  await request(ctx.app).get("/me").set(auth(res.body.token)).expect(200);

  const user = await User.findOne({ phone: ANNA }).lean();
  assert.equal(user.pushToken, undefined);
  assert.equal(user.voipToken, VOIP_B);
  assert.deepEqual(user.devices.map((d) => d.id), ["dev-b"]);
  assert.ok(user.tokensValidAfter);
  await request(ctx.app).post("/me/logout-all").expect(401);

  // Without X-Device-Id no device is the caller's: the list is emptied
  const again = await request(ctx.app).post("/me/logout-all").set(auth(res.body.token)).send({}).expect(200);
  assert.deepEqual((await User.findOne({ phone: ANNA }).lean()).devices, []);
  await request(ctx.app).get("/me").set(auth(again.body.token)).expect(200);
});
