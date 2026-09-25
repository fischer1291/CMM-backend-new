const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const User = require("../models/User");
const Talk = require("../models/Talk");
const Call = require("../models/Call");
const Circle = require("../models/Circle");
const { totpAt, currentStep } = require("../lib/adminAuth");
const { dayStart } = require("../lib/metrics");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const EMAIL = "owner@example.com";
const PASSWORD = "a-long-admin-password";
const ANNA = "+4915111111111";
const BEN = "+4915222222222";

const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];

/** Sets up the first admin; returns { secret, cookie }. */
async function setUpAdmin() {
  const started = await request(ctx.app)
    .post("/admin/auth/setup")
    .send({ email: EMAIL, password: PASSWORD, setupKey: "admin-key" })
    .expect(200);
  const { secret } = started.body;
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: totpAt(secret, currentStep()) })
    .expect(200);
  return { secret, cookie: cookieOf(done) };
}

async function appLogin(phone) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  return res.body.token;
}

test("setup: needs the setup key and a strong password, works once", async () => {
  assert.equal((await request(ctx.app).get("/admin/auth/state").expect(200)).body.setupNeeded, true);
  await request(ctx.app).post("/admin/auth/setup").send({ email: EMAIL, password: PASSWORD, setupKey: "nope" }).expect(403);
  await request(ctx.app).post("/admin/auth/setup").send({ email: EMAIL, password: "short", setupKey: "admin-key" }).expect(400);

  const started = await request(ctx.app)
    .post("/admin/auth/setup")
    .send({ email: EMAIL, password: PASSWORD, setupKey: "admin-key" })
    .expect(200);
  assert.match(started.body.otpauth, /^otpauth:\/\/totp\//);
  assert.match(started.body.qr, /<svg/);
  // Not done until confirmed with a code
  assert.equal((await request(ctx.app).get("/admin/auth/state")).body.setupNeeded, true);
  await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: "000000" })
    .expect(401);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  assert.match(done.headers["set-cookie"][0], /HttpOnly/);
  assert.match(done.headers["set-cookie"][0], /SameSite=Strict/);

  assert.equal((await request(ctx.app).get("/admin/auth/state")).body.setupNeeded, false);
  await request(ctx.app).post("/admin/auth/setup").send({ email: "x@example.com", password: PASSWORD, setupKey: "admin-key" }).expect(409);
  const stored = await Admin.findOne({ email: EMAIL }).lean();
  assert.ok(!stored.passwordHash.includes(PASSWORD));
});

test("login: password and a fresh code; codes work once; lockout after 5 failures", async () => {
  const { secret } = await setUpAdmin();
  const login = (body) => request(ctx.app).post("/admin/auth/login").send({ email: EMAIL, ...body });

  await login({ password: "wrong-password-123", code: totpAt(secret, currentStep()) }).expect(401);
  // The setup already used the current step
  await login({ password: PASSWORD, code: totpAt(secret, currentStep()) }).expect(401);
  const ok = await login({ password: PASSWORD, code: totpAt(secret, currentStep() + 1) }).expect(200);
  assert.equal(ok.body.admin.role, "owner");
  await login({ password: PASSWORD, code: totpAt(secret, currentStep() + 1) }).expect(401);

  await Admin.updateOne({ email: EMAIL }, { totpLastStep: 0, failedLogins: 0 });
  for (let i = 0; i < 5; i++) await login({ password: "wrong-password-123", code: "123456" }).expect(401);
  await login({ password: PASSWORD, code: totpAt(secret, currentStep()) }).expect(429);
  assert.ok((await AdminAudit.countDocuments({ action: "login_failed" })) >= 5);
});

test("session: cookie only, no app tokens, header for changes, logout everywhere", async () => {
  const { cookie } = await setUpAdmin();
  await request(ctx.app).get("/admin/me").expect(401);
  const appToken = await appLogin(ANNA);
  await request(ctx.app).get("/admin/me").set("Authorization", `Bearer ${appToken}`).expect(401);
  await request(ctx.app).get("/admin/me").set("Cookie", `cmm_admin=${appToken}`).expect(401);

  const me = await request(ctx.app).get("/admin/me").set("Cookie", cookie).expect(200);
  assert.equal(me.body.admin.email, EMAIL);

  await request(ctx.app).post("/admin/auth/logout-all").set("Cookie", cookie).expect(403);
  await request(ctx.app).post("/admin/auth/logout-all").set("Cookie", cookie).set("X-Admin-Request", "1").expect(200);
  await request(ctx.app).get("/admin/me").set("Cookie", cookie).expect(401);
});

test("roles: a viewer sees numbers, not the audit log", async () => {
  const { cookie } = await setUpAdmin();
  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  await request(ctx.app).get("/admin/metrics?days=7").set("Cookie", cookie).expect(200);
  await request(ctx.app).get("/admin/audit").set("Cookie", cookie).expect(403);
});

test("metrics: today's users, activity, calls, talks and circles", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await appLogin(ANNA);
  await appLogin(BEN);
  // Anna uses the app twice (counted once), Ben only signed up
  await request(ctx.app).get("/status/get").set("Authorization", `Bearer ${anna}`);
  await request(ctx.app).get("/status/get").set("Authorization", `Bearer ${anna}`);
  await new Promise((r) => setTimeout(r, 100));

  const now = new Date();
  await Call.create({ callId: "c1", channel: "ch1", caller: ANNA, callee: BEN, status: "ended", acceptedAt: now, endedAt: now });
  await Call.create({ callId: "c2", channel: "ch2", caller: ANNA, callee: BEN, status: "missed", video: false });
  await Talk.create({ callId: "c1", participants: [ANNA, BEN], startedAt: now, seconds: 600 });
  await Circle.create({ name: "Familie", createdBy: ANNA, members: [{ phone: ANNA }], code: "ABCDEFGH" });

  const res = await request(ctx.app).get("/admin/metrics?days=7").set("Cookie", cookie).expect(200);
  const today = res.body.series.at(-1);
  assert.equal(today.partial, true);
  assert.equal(today.users.total, 2);
  assert.equal(today.users.new, 2);
  // Both signed in (verify/check is not an authenticated request), Anna used it
  assert.equal(today.users.dau, 1);
  assert.deepEqual(
    { started: today.calls.started, answered: today.calls.answered, missed: today.calls.missed, audio: today.calls.audio },
    { started: 2, answered: 1, missed: 1, audio: 1 },
  );
  assert.deepEqual(today.talks, { count: 1, minutes: 10, people: 2 });
  assert.equal(today.circles.total, 1);
  assert.equal(res.body.now.openReports, 0);

  const retention = await request(ctx.app).get("/admin/metrics/retention?weeks=4").set("Cookie", cookie).expect(200);
  assert.equal(retention.body.cohorts.length, 4);
  assert.equal(retention.body.cohorts.at(-1).size, 2);
});

test("metrics: local days across daylight saving time", () => {
  assert.equal(dayStart("2026-03-29").toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(dayStart("2026-03-30").toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal(dayStart("2026-10-25").toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(dayStart("2026-10-26").toISOString(), "2026-10-25T23:00:00.000Z");
});

test("console: static page with a strict content policy", async () => {
  const res = await request(ctx.app).get("/console/").expect(200);
  assert.match(res.text, /<div id="app">/);
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  await request(ctx.app).get("/console/vendor/standalone.module.js").expect(200);
});
