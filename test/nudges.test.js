const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Nudge = require("../models/Nudge");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const HOUR = 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Anna may nudge Ben (Ben has Anna as a contact). */
async function pair() {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  const nudge = () => request(ctx.app).post("/nudge").set(auth(anna)).send({ phone: BEN });
  const inbox = async () => (await request(ctx.app).get("/nudges").set(auth(ben)).expect(200)).body.received;
  const outbox = async () => (await request(ctx.app).get("/nudges").set(auth(anna)).expect(200)).body.sent;
  /** Move all nudges `ms` into the past */
  const age = (ms) =>
    Nudge.find().then((all) =>
      Promise.all(
        all.map((n) =>
          Nudge.updateOne(
            { _id: n._id },
            { createdAt: new Date(n.createdAt - ms), ...(n.resolvedAt ? { resolvedAt: new Date(n.resolvedAt - ms) } : {}) },
          ),
        ),
      ),
    );
  return { anna, ben, nudge, inbox, outbox, age };
}

test("dismiss: the card goes away, the sender isn't told and waits 24 h", async () => {
  const { ben, nudge, inbox, outbox, age } = await pair();
  await nudge().expect(200);
  assert.equal((await inbox()).length, 1);

  await request(ctx.app).post("/nudges/dismiss").set(auth(ben)).send({ from: ANNA }).expect(200);
  assert.equal((await inbox()).length, 0);

  const again = await nudge().expect(429);
  assert.equal(again.body.error, "already_nudged", "same answer as unanswered: no hint about the dismissal");
  assert.ok(new Date(again.body.nextAllowedAt) > new Date(Date.now() + 23 * HOUR));
  assert.equal((await outbox())[0].to, BEN);

  await age(24 * HOUR + 60 * 1000);
  await nudge().expect(200);
});

test("becoming available answers the nudge: card gone, next nudge after 1 h", async () => {
  const { ben, nudge, inbox, age } = await pair();
  await nudge().expect(200);
  await request(ctx.app).post("/status/set").set(auth(ben)).send({ isAvailable: true }).expect(200);
  await new Promise((r) => setTimeout(r, 100)); // broadcast runs async
  assert.equal((await Nudge.findOne()).status, "answered");
  assert.equal((await inbox()).length, 0);

  await request(ctx.app).post("/status/set").set(auth(ben)).send({ isAvailable: false }).expect(200);
  await nudge().expect(429);
  await age(HOUR + 60 * 1000);
  await nudge().expect(200);
});

test("talking answers open nudges in both directions", async () => {
  const { nudge } = await pair();
  await nudge().expect(200);
  await Nudge.create({ from: BEN, to: ANNA });
  await require("../lib/nudges").answerBetween(ANNA, BEN);
  assert.deepEqual((await Nudge.find()).map((n) => n.status), ["answered", "answered"]);
});

test("a nudge is only shown for 4 hours", async () => {
  const { nudge, inbox, age } = await pair();
  await nudge().expect(200);
  await age(3 * HOUR);
  assert.equal((await inbox()).length, 1);
  await age(1 * HOUR + 60 * 1000);
  assert.equal((await inbox()).length, 0);
});

test("three unanswered nudges in a row: a week's rest", async () => {
  const { nudge, outbox, age } = await pair();
  for (let i = 0; i < 3; i++) {
    await nudge().expect(200);
    await age(24 * HOUR + 60 * 1000);
  }
  const rest = await nudge().expect(429);
  assert.equal(rest.body.error, "resting");
  // A week after the last one: allowed again
  await age(6 * 24 * HOUR);
  await nudge().expect(200);
  assert.equal((await outbox()).length, 1);
});

test("dismiss without a sender clears all open nudges for me", async () => {
  const { ben, nudge, inbox } = await pair();
  await nudge().expect(200);
  await Nudge.create({ from: "+4915333333333", to: BEN });
  const res = await request(ctx.app).post("/nudges/dismiss").set(auth(ben)).send({}).expect(200);
  assert.equal(res.body.dismissed, 2);
  assert.equal((await inbox()).length, 0);
  await request(ctx.app).post("/nudges/dismiss").send({}).expect(401);
});
