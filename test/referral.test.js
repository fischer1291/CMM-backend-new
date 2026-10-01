const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const { resetLimitsCache } = require("../lib/plan");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
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
async function talkedWithAnna(phone) {
  const endedAt = new Date();
  await ctx.calls.recordTalk({ callId: `talk-${++talks}`, caller: phone, callee: ANNA, acceptedAt: new Date(endedAt.getTime() - 120 * 1000), endedAt });
}

test("referral: a friend counts after the first talk, every third one gives 30 days of Plus, shown in /me/plan", async () => {
  const anna = await login(ANNA, "Anna");
  let plan = (await request(ctx.app).get("/me/plan").set(auth(anna)).expect(200)).body;
  assert.deepEqual(plan.referral, { step: 3, rewardDays: 30, maxRewards: 6, joined: 0, activated: 0, earned: 0, toNext: 3 });

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
