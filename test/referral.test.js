const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const { resetLimitsCache } = require("../lib/plan");
const { saveConfig, resetFlagsCache } = require("../lib/appConfig");
const opsCounters = require("../lib/opsCounters");
const { computeDay, todayKey, dayRange } = require("../lib/metrics");
const { RULES, runRules } = require("../lib/alerts");
const { shiftDateKey } = require("../lib/localTime");
const { applyEvent } = require("../routes/plus");
const { applyStoreState } = require("../lib/plusReconcile");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
  resetFlagsCache();
});

const ANNA = "+4915111111111";
const FRIENDS = ["+4915222222222", "+4915333333333", "+4915444444444"];
const DAY = 24 * 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  if (name) {
    await User.updateOne(
      { phone },
      { name, pushToken: `ExponentPushToken[${name}]`, "notificationPrefs.quietHours.enabled": false },
    );
  }
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function inviteAndJoin(token, phones) {
  await request(ctx.app).post("/invites").set(auth(token)).send({ hashes: phones.map(User.hashPhone) }).expect(200);
  for (const phone of phones) await login(phone);
  await settle();
}

/** `phone` just had a two-minute call with Anna (the invitee's first talk counts for the inviter). */
let talks = 0;
async function talkedWithAnna(phone, seconds = 120) {
  const endedAt = new Date();
  await ctx.calls.recordTalk({ callId: `talk-${++talks}`, caller: phone, callee: ANNA, acceptedAt: new Date(endedAt.getTime() - seconds * 1000), endedAt });
}

test("referral: a friend counts after the first talk, every third one gives 30 days of Plus, shown in /me/plan", async () => {
  const anna = await login(ANNA, "Anna");
  let plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.deepEqual(plan.referral, { step: 3, rewardDays: 30, maxRewards: 6, joined: 0, activated: 0, earned: 0, toNext: 3, twoSided: false, pairDays: 7 });

  // Joining alone earns nothing: three prepaid SIMs must not buy a month of Plus
  await inviteAndJoin(anna, FRIENDS);
  const joined = await User.findOne({ phone: ANNA });
  assert.ok(joined.firstInviteAt);
  assert.equal(joined.invitesJoined, 3);
  assert.equal(joined.invitesActivated, 0);
  assert.equal(joined.referralRewards, 0);
  assert.equal(joined.plus.active, false);
  assert.deepEqual((await User.findOne({ phone: FRIENDS[0] })).invitedBy, [ANNA]);
  plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.deepEqual([plan.referral.joined, plan.referral.activated, plan.referral.toNext], [3, 0, 3]);

  await talkedWithAnna(FRIENDS[0]);
  await talkedWithAnna(FRIENDS[1]);
  const two = await User.findOne({ phone: ANNA });
  assert.equal(two.invitesActivated, 2);
  assert.equal(two.plus.active, false);
  assert.ok(two.milestones.firstTalkAt, "Anna's own first talk is a milestone too");
  assert.ok((await User.findOne({ phone: FRIENDS[0] })).milestones.firstTalkAt);

  await talkedWithAnna(FRIENDS[2]);
  // A second talk of the same friend changes nothing
  await talkedWithAnna(FRIENDS[2]);
  const after = await User.findOne({ phone: ANNA });
  assert.equal(after.invitesActivated, 3);
  assert.equal(after.referralRewards, 1);
  assert.equal(after.plus.source, "referral");
  assert.ok(Math.abs(after.plus.until - Date.now() - 30 * DAY) < 60 * 1000);

  plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.equal(plan.plan, "plus");
  assert.deepEqual([plan.referral.joined, plan.referral.activated, plan.referral.earned, plan.referral.toNext], [3, 3, 1, 3]);

  const push = fakes.expoPushes.filter((p) => p.data?.type === "referral_reward");
  assert.equal(push.length, 1);
  assert.equal(push[0].to, "ExponentPushToken[Anna]");
});

test("referral: days add up on a running gift; a store subscription stays untouched", async () => {
  const anna = await login(ANNA, "Anna");
  const giftUntil = new Date(Date.now() + 10 * DAY);
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: giftUntil, source: "gift", since: new Date() }, invitesActivated: 2 });
  await inviteAndJoin(anna, FRIENDS.slice(0, 1));
  await talkedWithAnna(FRIENDS[0]);
  const gifted = await User.findOne({ phone: ANNA });
  assert.equal(gifted.plus.until.getTime(), giftUntil.getTime() + 30 * DAY);

  const storeUntil = new Date(Date.now() + 5 * DAY);
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: storeUntil, source: "store" }, invitesActivated: 5, referralRewards: 1 });
  await inviteAndJoin(anna, FRIENDS.slice(1, 2));
  await talkedWithAnna(FRIENDS[1]);
  const store = await User.findOne({ phone: ANNA });
  assert.equal(store.referralRewards, 2);
  assert.equal(store.plus.source, "store");
  assert.equal(store.plus.until.getTime(), storeUntil.getTime());
  assert.equal(fakes.expoPushes.filter((p) => p.data?.type === "referral_reward").length, 1);
});

test("referral: rewards stop after the maximum", async () => {
  const anna = await login(ANNA, "Anna");
  await User.updateOne({ phone: ANNA }, { invitesActivated: 20, referralRewards: 6 });
  await inviteAndJoin(anna, FRIENDS.slice(0, 1));
  await talkedWithAnna(FRIENDS[0]);
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.referralRewards, 6);
  assert.equal(user.plus.active, false);
  const plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.equal(plan.referral.toNext, null);
});

// --- Plan 2.12: the gift budget and the two-sided experiment -------------------------

const giftDaysToday = async (source) => (await opsCounters.countsOf(todayKey(new Date())))[`giftDays_${source}`] || 0;

test("gift budget: referral days are booked per source and land in the day's snapshot", async () => {
  const anna = await login(ANNA, "Anna");
  await inviteAndJoin(anna, FRIENDS);
  for (const phone of FRIENDS) await talkedWithAnna(phone);
  assert.equal(await giftDaysToday("referral"), 30);

  // A store subscription gets nothing, so nothing is booked
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: new Date(Date.now() + 5 * DAY), source: "store" }, invitesActivated: 5 });
  const late = ["+4915666666666"];
  await inviteAndJoin(anna, late);
  await talkedWithAnna(late[0]);
  assert.equal((await User.findOne({ phone: ANNA })).referralRewards, 2);
  assert.equal(await giftDaysToday("referral"), 30);

  await opsCounters.count("giftDays_waitlist", new Date(), 30);
  await opsCounters.count("giftDays_admin", new Date(), 14);
  const now = new Date();
  const day = await computeDay(todayKey(now), now);
  assert.deepEqual(day.plus.giftDaysGranted, { referral: 30, waitlist: 30, admin: 14 });
});

test("gift budget: the alert gift_days fires over the weekly budget, not at or under it", async () => {
  const rule = RULES.find((r) => r.tag === "gift_days");
  assert.equal(rule.level, "warn");
  const now = new Date();
  // Noon of the local day `offset` days from today
  const dayAt = (offset) => new Date(dayRange(shiftDateKey(todayKey(now), offset))[0].getTime() + 12 * 3600 * 1000);
  await opsCounters.count("giftDays_referral", now, 150);
  await opsCounters.count("giftDays_admin", dayAt(-3), 50);
  // Seven days back is outside the week (today and the six days before)
  await opsCounters.count("giftDays_waitlist", dayAt(-7), 500);
  assert.equal(await rule.check(now), null, "200 of 200 is within the budget");

  await opsCounters.count("giftDays_waitlist", dayAt(-6), 1);
  const text = await rule.check(now);
  assert.match(text, /201 Plus-Tage verschenkt \(Einladungen 150, Warteliste 1, Konsole 50\), Budget 200 je Woche/);
  assert.match(text, /Konsole → App → Ziele/);
  assert.ok((await runRules(now, { uptimeSec: 0 })).includes("gift_days"));

  // A bigger budget in the console: quiet again
  await saveConfig({ goals: { giftDaysPerWeek: 300 } }, "owner@test");
  assert.equal(await rule.check(now), null);
});

test("two-sided: only with the flag, both get 7 days after their first talk, once per pair, a store plan stays", async () => {
  const anna = await login(ANNA, "Anna");
  // The ladder is used up, so only the experiment gives days here
  await User.updateOne({ phone: ANNA }, { referralRewards: 6 });
  await inviteAndJoin(anna, [...FRIENDS, "+4915555555555"]);

  // Flag off: the first talk counts for the ladder only
  await talkedWithAnna(FRIENDS[0]);
  let me = await User.findOne({ phone: ANNA });
  assert.equal(me.plus.active, false);
  assert.deepEqual((await User.findOne({ phone: FRIENDS[0] })).referralPairRewards, []);
  assert.equal((await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body.referral.twoSided, false);

  await saveConfig({ flags: { referral_two_sided: true } }, "owner@test");
  const plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.equal(plan.referral.twoSided, true);
  assert.equal(plan.referral.pairDays, 7);

  // A pair that talked before the flag: the next talk is not their first
  await talkedWithAnna(FRIENDS[0]);
  assert.equal((await User.findOne({ phone: ANNA })).plus.active, false);
  // Under a minute is no talk for the experiment
  await talkedWithAnna("+4915555555555", 30);
  assert.equal((await User.findOne({ phone: ANNA })).plus.active, false);

  await talkedWithAnna(FRIENDS[1]);
  me = await User.findOne({ phone: ANNA });
  const friend = await User.findOne({ phone: FRIENDS[1] });
  for (const u of [me, friend]) {
    assert.equal(u.plus.source, "referral");
    assert.ok(Math.abs(u.plus.until - Date.now() - 7 * DAY) < 60 * 1000);
  }
  assert.deepEqual(friend.referralPairRewards, [ANNA]);
  assert.equal(await giftDaysToday("referral"), 14);
  const pushes = fakes.expoPushes.filter((p) => p.data?.type === "referral_pair_reward");
  assert.equal(pushes.length, 1, "Anna has a push token, the friend none");
  assert.equal(pushes[0].to, "ExponentPushToken[Anna]");
  assert.equal(pushes[0].data.url, "/plus");

  // The same pair again: nothing more
  const until = me.plus.until.getTime();
  await talkedWithAnna(FRIENDS[1]);
  assert.equal((await User.findOne({ phone: ANNA })).plus.until.getTime(), until);
  assert.equal(await giftDaysToday("referral"), 14);

  // Anna buys Plus: the third friend gets the days, her store plan stays
  const storeUntil = new Date(Date.now() + 20 * DAY);
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: storeUntil, source: "store" } });
  await talkedWithAnna(FRIENDS[2]);
  me = await User.findOne({ phone: ANNA });
  assert.equal(me.plus.source, "store");
  assert.equal(me.plus.until.getTime(), storeUntil.getTime());
  assert.equal((await User.findOne({ phone: FRIENDS[2] })).plus.source, "referral");
  assert.equal(await giftDaysToday("referral"), 21);

  // Deleting the inviter removes the marker from the invitee
  await request(ctx.app).delete("/me").set(auth(anna)).expect(200);
  assert.deepEqual((await User.findOne({ phone: FRIENDS[1] })).referralPairRewards, []);
});

test("gift to store: a first purchase after a gift counts, also when the sync came before the webhook", async () => {
  const now = new Date();
  const [gifted, synced, fresh, tester] = await User.create([
    { phone: "+4915711111111", plus: { active: true, until: new Date(now.getTime() + 3 * DAY), source: "referral" } },
    // An expired waitlist gift is still the gift before the store
    { phone: "+4915722222222", plus: { active: false, until: new Date(now.getTime() - 3 * DAY), source: "waitlist" } },
    { phone: "+4915733333333" },
    { phone: "+4915744444444", plus: { active: true, until: new Date(now.getTime() + 3 * DAY), source: "admin" } },
  ]);
  let n = 0;
  const purchase = (user, environment = "PRODUCTION") =>
    applyEvent({ id: `ev-${++n}`, type: "INITIAL_PURCHASE", app_user_id: String(user._id), product_id: "wannayap_plus_monthly", environment, period_type: "NORMAL", price: 2.99, event_timestamp_ms: now.getTime(), expiration_at_ms: now.getTime() + 30 * DAY });

  await purchase(gifted);
  // The app's sync right after the purchase is first, the webhook second
  const syncedDoc = await User.findById(synced._id);
  await applyStoreState(syncedDoc, { active: true, until: new Date(now.getTime() + 30 * DAY), productId: "wannayap_plus_monthly", status: "active", sandbox: false }, now);
  await purchase(synced);
  await purchase(fresh);
  // A test account's purchase never counts
  await purchase(tester, "SANDBOX");

  assert.equal((await User.findById(gifted._id)).plus.previousSource, "referral");
  assert.equal((await User.findById(gifted._id)).plus.source, "store");
  assert.equal((await User.findById(synced._id)).plus.previousSource, "waitlist");
  assert.equal((await User.findById(fresh._id)).plus.previousSource, null);
  assert.equal((await User.findById(tester._id)).plus.previousSource, "admin");

  const day = await computeDay(todayKey(now), now);
  assert.equal(day.plus.newPaid, 3);
  assert.equal(day.plus.giftToStore, 2);
});
