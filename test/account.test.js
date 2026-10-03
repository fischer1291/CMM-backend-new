const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes, talked, shareAll } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const Nudge = require("../models/Nudge");
const CallMoment = require("../models/CallMoment");
const MomentUnlock = require("../models/MomentUnlock");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const ActiveDay = require("../models/ActiveDay");
const WaitlistEntry = require("../models/WaitlistEntry");
const revenuecat = require("../lib/revenuecat");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  delete process.env.REVENUECAT_API_KEY;
  revenuecat.setDeleteSubscriber(null);
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const IMAGE = "data:image/jpeg;base64,AAAA";

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const postMoment = (token, targetPhone, screenshot = IMAGE) =>
  request(ctx.app).post("/moment/callmoment").set(auth(token)).send({ targetPhone, screenshot, mood: "😊", callDuration: "05:00" });

test("delete account: removes the user, their moments, talks, nudges and every trace in others' data", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await login(CARL, "Carl");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  await User.updateOne({ phone: BEN }, { contacts: [ANNA, CARL], statsSharing: { visibility: "selected", sharedWith: [ANNA] } });
  await User.updateOne({ phone: CARL }, { contacts: [BEN] });

  await talked(ANNA, BEN);
  await talked(BEN, CARL);
  await postMoment(anna, BEN).expect(200);
  await postMoment(ben, ANNA).expect(200); // Ben's moment, but it shows Anna
  const bensOther = (await postMoment(ben, CARL).expect(200)).body.callMoment._id;
  await shareAll();
  await request(ctx.app).post("/moment/react").set(auth(anna)).send({ momentId: bensOther, emoji: "❤️" });
  await Talk.create({ callId: "t1", participants: [ANNA, BEN], startedAt: new Date(), seconds: 600 });
  await Talk.create({ callId: "t2", participants: [BEN, CARL], startedAt: new Date(), seconds: 300 });
  await Nudge.create({ from: ANNA, to: BEN });
  await MomentUnlock.create([{ phone: ANNA, day: "2026-10-01", via: "talk" }, { phone: BEN, day: "2026-10-01", via: "talk" }]);
  // Activity rows under the keyed hash (today's from the sign-in), under the
  // stored field and under the SHA-256 of older rows no migration reached
  const annaBefore = await User.findOne({ phone: ANNA });
  assert.equal(annaBefore.phoneHmac, User.hmacPhone(ANNA));
  await ActiveDay.create([
    { day: "2026-09-01", who: User.hmacPhone(ANNA) },
    { day: "2026-09-02", who: User.hashPhone(ANNA) },
    { day: "2026-09-01", who: User.hmacPhone(BEN) },
  ]);
  // A redeemed waitlist code names the account by its SHA-256 (lib/waitlist.js)
  await WaitlistEntry.create([
    { email: "anna@example.com", code: "ANNA1", token: "t-anna", status: "confirmed", claimedBy: User.hashPhone(ANNA), claimedAt: new Date() },
    { email: "ben@example.com", code: "BEN1", token: "t-ben", status: "confirmed", claimedBy: User.hashPhone(BEN), claimedAt: new Date() },
  ]);
  // RevenueCat forgets the subscriber (our user id), when the key is configured
  process.env.REVENUECAT_API_KEY = "rc-api-key";
  const forgotten = [];
  revenuecat.setDeleteSubscriber(async (id) => {
    forgotten.push(id);
    return true;
  });

  await request(ctx.app).delete("/me").expect(401);
  await request(ctx.app).delete("/me").set(auth(anna)).expect(200);

  assert.equal(await User.countDocuments({ phone: ANNA }), 0);
  assert.equal(await ActiveDay.countDocuments({ who: { $in: [User.hmacPhone(ANNA), User.hashPhone(ANNA)] } }), 0, "no activity row of the account is left");
  assert.equal(await ActiveDay.countDocuments({ who: User.hmacPhone(BEN), day: "2026-09-01" }), 1, "other people keep their rows");
  assert.deepEqual(forgotten, [String(annaBefore._id)]);
  assert.equal(await WaitlistEntry.countDocuments({ claimedBy: User.hashPhone(ANNA) }), 0, "no waitlist code names the account");
  assert.equal((await WaitlistEntry.findOne({ code: "ANNA1" })).claimedBy, "deleted", "the code stays used");
  assert.equal((await WaitlistEntry.findOne({ code: "BEN1" })).claimedBy, User.hashPhone(BEN));
  const moments = await CallMoment.find();
  assert.deepEqual(moments.map((m) => m.targetPhone), [CARL]);
  assert.equal(moments[0].totalReactions, 0);
  assert.deepEqual((await Talk.find()).map((t) => t.callId), ["t2"]);
  assert.equal(await Nudge.countDocuments(), 0);
  assert.deepEqual((await MomentUnlock.find()).map((u) => u.phone), [BEN]);
  const benAfter = await User.findOne({ phone: BEN });
  assert.deepEqual(benAfter.contacts, [CARL]);
  assert.deepEqual(benAfter.statsSharing.sharedWith, []);

  // The old token no longer finds an account; signing up again starts fresh
  await request(ctx.app).get("/me").set(auth(anna)).expect(404);
  await request(ctx.app).delete("/me").set(auth(anna)).expect(404);
  await login(ANNA, "Anna neu");
  assert.equal((await User.findOne({ phone: ANNA })).contacts.length, 0);
});

test("delete account: a failing RevenueCat call is logged, the account still goes; without the key nothing is called", async () => {
  const anna = await login(ANNA, "Anna");
  process.env.REVENUECAT_API_KEY = "rc-api-key";
  revenuecat.setDeleteSubscriber(async () => {
    throw new Error("revenuecat_503");
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await request(ctx.app).delete("/me").set(auth(anna)).expect(200);
  } finally {
    console.error = original;
  }
  assert.equal(await User.countDocuments({ phone: ANNA }), 0);
  assert.ok(errors.some((e) => e.includes("RevenueCat subscriber") && e.includes("revenuecat_503")), errors.join("\n"));

  delete process.env.REVENUECAT_API_KEY;
  const ben = await login(BEN, "Ben");
  revenuecat.setDeleteSubscriber(async () => {
    throw new Error("must not be called without the key");
  });
  await request(ctx.app).delete("/me").set(auth(ben)).expect(200);
  assert.equal(await User.countDocuments({ phone: BEN }), 0);
});

test("export: everything stored about the user, as JSON", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN], pushToken: "ExponentPushToken[a]" });
  await talked(ANNA, BEN);
  await postMoment(anna, BEN).expect(200);
  await Talk.create({ callId: "t1", participants: [ANNA, BEN], startedAt: new Date(), seconds: 600 });
  const annaId = (await User.findOne({ phone: ANNA }))._id;
  await SubscriptionEvent.create({ rcEventId: "ev-1", userId: annaId, appUserId: String(annaId), type: "INITIAL_PURCHASE", productId: "plus_monthly", store: "APP_STORE", priceCents: 299, currency: "EUR", eventAt: new Date("2026-10-01T10:00:00Z") });
  await SubscriptionEvent.create({ rcEventId: "ev-2", appUserId: "someone-else", type: "RENEWAL" });

  await request(ctx.app).get("/me/export").expect(401);
  const { body } = await request(ctx.app).get("/me/export").set(auth(anna)).expect(200);
  const data = body.data;
  assert.equal(data.profile.phone, ANNA);
  assert.equal(data.profile.name, "Anna");
  assert.deepEqual(data.contacts, [BEN]);
  assert.equal(data.devices.pushNotifications, true);
  assert.equal(data.moments.length, 1);
  assert.equal(data.moments[0].image, "(Bild in der Datenbank)");
  assert.deepEqual(data.conversations.map((c) => [c.with, c.seconds]), [[BEN, 600]]);
  // The days the app was used, from the keyed rows and from older SHA-256
  // rows. Today's row is what the login's markActive upserts (fire and
  // forget); the same upsert here makes the test independent of its timing
  const today = require("../lib/metrics").todayKey();
  await ActiveDay.create([{ day: "2026-09-02", who: User.hashPhone(ANNA) }, { day: "2026-09-01", who: User.hmacPhone(ANNA) }]);
  await ActiveDay.updateOne({ day: today, who: User.hmacPhone(ANNA) }, { $setOnInsert: { day: today } }, { upsert: true });
  const again = (await request(ctx.app).get("/me/export").set(auth(anna)).expect(200)).body.data;
  assert.deepEqual(again.activeDays, ["2026-09-01", "2026-09-02", today]);
  assert.ok(!JSON.stringify(again).includes(User.hmacPhone(ANNA)), "no hashes in the export");
  assert.ok(!JSON.stringify(data).includes("ExponentPushToken"), "no push tokens in the export");
  // Onboarding milestones are about the person and belong in the export
  assert.deepEqual(Object.keys(data.milestones), ["verifiedAt", "contactsSyncedAt", "firstRegisteredContactAt", "pushGrantedAt", "firstCallAt", "firstTalkAt", "firstInviteAt"]);
  assert.ok(Date.parse(data.milestones.verifiedAt) > 0);
  assert.equal(data.milestones.pushGrantedAt, null);
  // So is the research invitation (README "User research")
  assert.deepEqual(data.research, { invitedAt: null, bookedAt: null, dismissedAt: null, doneAt: null });
  // Consent (plan 1.6): nothing was sent in this login
  assert.deepEqual(data.consent, { ageConfirmedAt: null, termsVersion: null, privacyVersion: null });
  // Plus and the store's events for this person, never other people's
  assert.equal(data.plus.active, false);
  assert.deepEqual(data.subscriptions.map((e) => [e.type, e.productId, e.priceCents, e.currency]), [["INITIAL_PURCHASE", "plus_monthly", 299, "EUR"]]);
  assert.ok(!JSON.stringify(data).includes("ev-1"), "no RevenueCat event ids in the export");
});

test("moments: pictures only as our Cloudinary uploads or inline images, no foreign URLs", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await talked(ANNA, BEN);
  await postMoment(anna, BEN, "https://tracker.example.com/pixel.jpg").expect(400);
  await postMoment(anna, BEN, "https://res.cloudinary.com/othercloud/image/upload/x.jpg").expect(400);
  await postMoment(anna, BEN, "https://res.cloudinary.com/testcloud/image/upload/v1/moments/moment_1.jpg").expect(200);
  await postMoment(anna, BEN, IMAGE).expect(200);
  await request(ctx.app).post("/upload/moment").expect(401);
});

test("reactions: only on moments the user may see", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });
  await talked(ANNA, BEN);
  const momentId = (await postMoment(anna, BEN).expect(200)).body.callMoment._id;
  // Waiting for Ben's consent: nobody can react yet
  await request(ctx.app).post("/moment/react").set(auth(ben)).send({ momentId, emoji: "❤️" }).expect(404);
  await shareAll();

  // Carl knows neither of them
  await request(ctx.app).post("/moment/react").set(auth(carl)).send({ momentId, emoji: "❤️" }).expect(404);
  // Ben is in the moment and knows Anna
  await request(ctx.app).post("/moment/react").set(auth(ben)).send({ momentId, emoji: "❤️" }).expect(200);
  assert.equal((await CallMoment.findById(momentId)).totalReactions, 1);
});
