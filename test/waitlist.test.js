const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const WaitlistEntry = require("../models/WaitlistEntry");
const AppConfig = require("../models/AppConfig");
const { totpAt, currentStep } = require("../lib/adminAuth");
const { runLaunchBatch } = require("../lib/waitlist");
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

const ADMIN = { email: "owner@example.com", password: "a-long-admin-password" };
const ANNA = "+4915111111111";
const DAY = 24 * 3600 * 1000;
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];

async function adminCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...ADMIN, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ ...ADMIN, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

/** Sign up and confirm via the link in the mail; returns the confirm answer. */
async function join(email, extra = {}) {
  await request(ctx.app).post("/waitlist").send({ email, ...extra }).expect(200);
  const mail = fakes.mails.findLast((m) => m.to === email.toLowerCase());
  const token = mail.text.match(/bestaetigen=([a-f0-9]{48})/)[1];
  return (await request(ctx.app).post("/waitlist/confirm").send({ token }).expect(200)).body;
}

test("sign-up: double opt-in, same answer for known addresses, honeypot, pending entries expire", async () => {
  await request(ctx.app).post("/waitlist").send({ email: "kein-mail" }).expect(400);
  await request(ctx.app).post("/waitlist").send({ email: "Lea@Example.com", source: "tiktok", campaign: "launch_1" }).expect(200);
  const entry = await WaitlistEntry.findOne({ email: "lea@example.com" });
  assert.equal(entry.status, "pending");
  assert.equal(entry.source, "tiktok");
  assert.ok(entry.consent.at && entry.consent.text);
  assert.equal(fakes.mails.length, 1);
  assert.match(fakes.mails[0].subject, /bestätige/);
  assert.match(fakes.mails[0].html, /Ja, ich bin dabei/);

  // Signing up again right away: same answer, no second mail
  await request(ctx.app).post("/waitlist").send({ email: "lea@example.com" }).expect(200);
  assert.equal(fakes.mails.length, 1);
  // Bots fill the hidden field: nothing stored
  await request(ctx.app).post("/waitlist").send({ email: "bot@example.com", website: "x" }).expect(200);
  assert.equal(await WaitlistEntry.countDocuments({ email: "bot@example.com" }), 0);

  // Unconfirmed entries go away after 7 days (partial TTL index)
  const ttl = (await WaitlistEntry.collection.indexes()).find((i) => i.expireAfterSeconds);
  assert.equal(ttl.expireAfterSeconds, 7 * 24 * 3600);
  assert.deepEqual(ttl.partialFilterExpression, { status: "pending" });
});

test("confirm, place, referrals via ?ref, status by code, unsubscribe deletes", async () => {
  const lea = await join("lea@example.com");
  assert.equal(lea.position, 1);
  assert.equal(lea.referrals, 0);
  assert.match(lea.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Confirming twice changes nothing
  const token = (await WaitlistEntry.findOne({ email: "lea@example.com" })).token;
  assert.equal((await request(ctx.app).post("/waitlist/confirm").send({ token }).expect(200)).body.position, 1);
  await request(ctx.app).post("/waitlist/confirm").send({ token: "f".repeat(48) }).expect(404);

  // Friends through Lea's link; only confirmed ones count
  await join("ben@example.com", { ref: lea.code.toLowerCase() });
  await request(ctx.app).post("/waitlist").send({ email: "carl@example.com", ref: lea.code }).expect(200);
  let status = (await request(ctx.app).get(`/waitlist/status/${lea.code}`).expect(200)).body;
  assert.equal(status.referrals, 1);
  assert.equal(status.total, 2);
  await request(ctx.app).get("/waitlist/status/NOPE1234").expect(404);

  // Unsubscribe from the landing page, and one-click from the mail client
  await request(ctx.app).post("/waitlist/unsubscribe").send({ token }).expect(200);
  assert.equal(await WaitlistEntry.countDocuments({ email: "lea@example.com" }), 0);
  const benToken = (await WaitlistEntry.findOne({ email: "ben@example.com" })).token;
  await request(ctx.app).post(`/waitlist/unsubscribe/${benToken}`).type("form").send("List-Unsubscribe=One-Click").expect(200);
  assert.equal(await WaitlistEntry.countDocuments({ email: "ben@example.com" }), 0);
});

test("redeem in the app: badge for everyone, Plus days for three confirmed friends, once", async () => {
  const lea = await join("lea@example.com");
  for (const f of ["a", "b", "c"]) await join(`${f}@example.com`, { ref: lea.code });

  await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(200);
  const token = (await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(200)).body.token;
  const auth = { Authorization: `Bearer ${token}` };
  await request(ctx.app).post("/me/waitlist/redeem").set(auth).send({ code: "WRONG123" }).expect(400);

  const res = await request(ctx.app).post("/me/waitlist/redeem").set(auth).send({ code: lea.code.replace("-", " ") }).expect(200);
  assert.deepEqual({ badge: res.body.badge, referrals: res.body.referrals, plusDays: res.body.plusDays }, { badge: "pioneer", referrals: 3, plusDays: 30 });
  const user = await User.findOne({ phone: ANNA });
  assert.equal(user.plus.source, "waitlist");
  assert.ok(Math.abs(user.plus.until - Date.now() - 30 * DAY) < 60 * 1000);
  const { badges } = (await request(ctx.app).get("/me/badges").set(auth).expect(200)).body;
  assert.equal(badges.find((b) => b.id === "pioneer").earned, true);

  // Once per person and once per code
  const again = await request(ctx.app).post("/me/waitlist/redeem").set(auth).send({ code: lea.code }).expect(400);
  assert.equal(again.body.error, "already_redeemed");
});

test("launch: owner only, typed confirmation, test mail, background batches send each address once", async () => {
  const cookie = await adminCookie();
  const lea = await join("lea@example.com");
  await join("ben@example.com", { ref: lea.code });
  await request(ctx.app).post("/waitlist").send({ email: "pending@example.com" }).expect(200);
  fakes.mails.length = 0;

  const overview = (await request(ctx.app).get("/admin/waitlist").set(admin(cookie)).expect(200)).body;
  assert.deepEqual({ confirmed: overview.confirmed, pending: overview.pending, viaReferral: overview.viaReferral }, { confirmed: 2, pending: 1, viaReferral: 1 });
  assert.equal(overview.mailConfigured, true);

  await request(ctx.app).post("/admin/waitlist/test-mail").set(admin(cookie)).send({ email: "me@example.com" }).expect(200);
  assert.equal(fakes.mails[0].to, "me@example.com");
  assert.match(fakes.mails[0].subject, /ist da/);
  assert.equal(fakes.mails[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  await request(ctx.app).post("/admin/waitlist/launch").set(admin(cookie)).send({ confirm: "ja" }).expect(400);
  assert.equal(await runLaunchBatch(), null); // not started: nothing happens
  await request(ctx.app).post("/admin/waitlist/launch").set(admin(cookie)).send({ confirm: "STARTEN" }).expect(200);
  fakes.mails.length = 0;
  fakes.failMailTo = "ben@example.com";

  assert.deepEqual(await runLaunchBatch(), { sent: 1, failed: 1 });
  assert.deepEqual(await runLaunchBatch(), { done: true });
  assert.equal(await runLaunchBatch(), null);
  assert.deepEqual(fakes.mails.map((m) => m.to), ["lea@example.com"]);
  assert.match(fakes.mails[0].text, new RegExp(lea.code));
  // A failed address is not retried endlessly; nobody gets it twice
  assert.equal(await WaitlistEntry.countDocuments({ launchMailAt: null, status: "confirmed" }), 0);
  const state = (await AppConfig.findOne({ key: "app" })).waitlistLaunch;
  assert.deepEqual({ sent: state.sent, failed: state.failed, finished: !!state.finishedAt }, { sent: 1, failed: 1, finished: true });

  // Starting again does nothing
  const again = await request(ctx.app).post("/admin/waitlist/launch").set(admin(cookie)).send({ confirm: "STARTEN" }).expect(200);
  assert.equal(again.body.already, true);

  const csv = await request(ctx.app).get("/admin/waitlist/export").set(admin(cookie)).expect(200);
  assert.match(csv.text, /lea@example\.com/);
  assert.doesNotMatch(csv.text, /pending@example\.com/);
});
