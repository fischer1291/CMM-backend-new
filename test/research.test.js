// User research (README "User research"): the second talk invites to a
// research call, the person answers the card once, support marks the talk
// as done in the console.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const User = require("../models/User");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const EMAIL = "owner@example.com";
const PASSWORD = "a-long-admin-password";

async function login(phone) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const researchOf = async (phone) => (await User.findOne({ phone }).lean()).research;

/** a and b just had a two-minute call, recorded like endCall does. */
let talks = 0;
async function talked(a, b, callId = `research-talk-${++talks}`) {
  const endedAt = new Date();
  await ctx.calls.recordTalk({ callId, caller: a, callee: b, acceptedAt: new Date(endedAt.getTime() - 120 * 1000), endedAt });
}

const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
async function setUpAdmin() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ email: EMAIL, password: PASSWORD, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}

test("research: the second talk invites, the first does not; a talk recorded twice counts once; admin Plus is left out", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await login(CARL);

  await talked(ANNA, BEN);
  assert.equal((await researchOf(ANNA)).invitedAt, null, "first talk: no invitation");
  assert.equal((await researchOf(BEN)).invitedAt, null);
  let me = (await request(ctx.app).get("/me").set(auth(anna)).expect(200)).body.user;
  assert.deepEqual(me.research, { invitedAt: null, bookedAt: null, dismissedAt: null, doneAt: null });

  // The startup replay records the same call again: still one talk
  await talked(ANNA, BEN, "research-talk-1");
  assert.equal((await researchOf(ANNA)).invitedAt, null);

  await talked(ANNA, CARL);
  const invited = await researchOf(ANNA);
  assert.ok(invited.invitedAt instanceof Date, "second talk: invited");
  assert.equal((await researchOf(CARL)).invitedAt, null, "Carl's first talk");
  me = (await request(ctx.app).get("/me").set(auth(anna)).expect(200)).body.user;
  assert.equal(new Date(me.research.invitedAt).getTime(), invited.invitedAt.getTime());
  assert.equal(me.research.bookedAt, null);

  // Other people's profiles never carry it
  const ben = await login(BEN);
  const annaSeenByBen = (await request(ctx.app).get(`/me?phone=${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200)).body.user;
  assert.equal(annaSeenByBen.research, undefined);

  // Ben has Plus from the console: his second talk does not invite him.
  // Anna's third talk changes nothing, her date stays.
  await User.updateOne({ phone: BEN }, { plus: { active: true, until: null, since: new Date(), source: "admin" } });
  await talked(ANNA, BEN);
  assert.equal((await researchOf(BEN)).invitedAt, null, "admin grant: not asked");
  assert.equal((await researchOf(ANNA)).invitedAt.getTime(), invited.invitedAt.getTime());

  // Carl's second talk: a referral gift is no reason to skip him
  await User.updateOne({ phone: CARL }, { plus: { active: true, until: new Date(Date.now() + 864e5), since: new Date(), source: "referral" } });
  await talked(CARL, BEN);
  assert.ok((await researchOf(CARL)).invitedAt instanceof Date);
});

test("research: booked or dismissed once, only after an invitation", async () => {
  const anna = await login(ANNA);
  await login(BEN);
  await login(CARL);
  await request(ctx.app).post("/me/research").set(auth(anna)).send({ action: "booked" }).expect(409);
  await request(ctx.app).post("/me/research").set(auth(anna)).send({ action: "nope" }).expect(400);

  await talked(ANNA, BEN);
  await talked(ANNA, CARL);
  const booked = (await request(ctx.app).post("/me/research").set(auth(anna)).send({ action: "booked" }).expect(200)).body.research;
  assert.ok(booked.bookedAt);
  assert.equal(booked.dismissedAt, null);
  // Answering again keeps the first date
  const again = (await request(ctx.app).post("/me/research").set(auth(anna)).send({ action: "booked" }).expect(200)).body.research;
  assert.equal(again.bookedAt, booked.bookedAt);
  const me = (await request(ctx.app).get("/me").set(auth(anna)).expect(200)).body.user;
  assert.equal(me.research.bookedAt, booked.bookedAt);

  const carl = await login(CARL);
  await talked(CARL, BEN);
  const dismissed = (await request(ctx.app).post("/me/research").set(auth(carl)).send({ action: "dismissed" }).expect(200)).body.research;
  assert.ok(dismissed.dismissedAt);
  assert.equal(dismissed.bookedAt, null);
});

test("research: support marks the talk as done, audited; a viewer may not", async () => {
  const cookie = await setUpAdmin();
  await login(ANNA);
  await login(BEN);
  await login(CARL);
  const id = String((await User.findOne({ phone: ANNA }))._id);
  await request(ctx.app).post(`/admin/users/${id}/research-done`).set(admin(cookie)).expect(409);

  await talked(ANNA, BEN);
  await talked(ANNA, CARL);
  const done = (await request(ctx.app).post(`/admin/users/${id}/research-done`).set(admin(cookie)).expect(200)).body.research;
  assert.ok(done.doneAt);
  const first = (await researchOf(ANNA)).doneAt;
  await request(ctx.app).post(`/admin/users/${id}/research-done`).set(admin(cookie)).expect(200);
  assert.equal((await researchOf(ANNA)).doneAt.getTime(), first.getTime(), "set once");
  assert.equal(await AdminAudit.countDocuments({ action: "research_done", target: id }), 2);
  const detail = (await request(ctx.app).get(`/admin/users/${id}`).set("Cookie", cookie).expect(200)).body.user;
  assert.ok(detail.research.invitedAt);
  assert.ok(detail.research.doneAt);

  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  await request(ctx.app).post(`/admin/users/${id}/research-done`).set(admin(cookie)).expect(403);
});
