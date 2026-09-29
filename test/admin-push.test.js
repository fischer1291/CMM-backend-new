const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AdDraft = require("../models/AdDraft");
const { AdminPushSubscription } = require("../models/AdminPush");
const adminPush = require("../lib/adminPush");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
let sent = [];
let failWith = null;

before(async () => {
  process.env.MARKETING_AGENT_KEY = "agent-key-for-tests-0123456789";
  // Fake Web Push service: records what would go to the phone
  adminPush.setSender(async (sub, payload, options) => {
    if (failWith) throw Object.assign(new Error("push failed"), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
  });
  ctx = await setup();
});
after(async () => {
  delete process.env.MARKETING_AGENT_KEY;
  await teardown();
});
beforeEach(async () => {
  await reset();
  sent = [];
  failWith = null;
});

const EMAIL = "owner@example.com";
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
async function ownerCookie() {
  const who = { email: EMAIL, password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}
const SUB = { endpoint: "https://web.push.apple.com/QGx-test-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
async function subscribed() {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)").send({ subscription: SUB }).expect(200);
  return cookie;
}
// notify() runs in the background: wait until it has sent (or clearly won't)
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
}

test("admin push: VAPID key, subscribe an iPhone, test push, unsubscribe", async () => {
  const cookie = await ownerCookie();
  const state = (await request(ctx.app).get("/admin/push").set(admin(cookie)).expect(200)).body;
  assert.match(state.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.deepEqual(state.kinds, ["approvals", "posting", "support", "reports", "daily"]);
  assert.equal(state.notify.dailyHour, 20);
  assert.equal(state.devices.length, 0);
  // Same key on the next call
  assert.equal((await request(ctx.app).get("/admin/push").set(admin(cookie))).body.publicKey, state.publicKey);

  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: { endpoint: "http://insecure.example/x", keys: SUB.keys } }).expect(400);
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: { endpoint: SUB.endpoint } }).expect(400);
  const after = (await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)").send({ subscription: SUB }).expect(200)).body;
  assert.deepEqual(after.devices.map((d) => d.device), ["iPhone"]);

  const test1 = await request(ctx.app).post("/admin/push/test").set(admin(cookie)).expect(200);
  assert.equal(test1.body.delivered, 1);
  assert.equal(sent[0].payload.title, "Mitteilungen sind an");
  assert.equal(sent[0].payload.url, "#notify");
  assert.equal(typeof sent[0].payload.badge, "number");
  assert.ok(sent[0].options.vapidDetails.privateKey, "signed with the VAPID key");

  await request(ctx.app).post("/admin/push/unsubscribe").set(admin(cookie)).send({ endpoint: SUB.endpoint }).expect(200);
  assert.equal(await AdminPushSubscription.countDocuments(), 0);
});

test("admin push: new drafts for approval reach the owner, with the count on the icon; switched off, nothing", async () => {
  const cookie = await subscribed();
  await AdDraft.create({ campaign: "yap-0929-a", title: "A", template: "chat", status: "pending" });
  await AdDraft.create({ campaign: "yap-0929-b", title: "B", template: "chat", status: "pending" });
  await request(ctx.app).post("/marketing/notify").set("Authorization", "Bearer agent-key-for-tests-0123456789").expect(200);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "2 Werbevideos warten auf dich");
  assert.equal(sent[0].payload.url, "#approvals");
  assert.equal(sent[0].payload.badge, 2);

  await request(ctx.app).put("/admin/push/settings").set(admin(cookie)).send({ approvals: false, dailyHour: 7 }).expect(200);
  await request(ctx.app).put("/admin/push/settings").set(admin(cookie)).send({ dailyHour: 24 }).expect(400);
  sent = [];
  await request(ctx.app).post("/marketing/notify").set("Authorization", "Bearer agent-key-for-tests-0123456789").expect(200);
  await settle();
  assert.equal(sent.length, 0);
  assert.equal((await Admin.findOne({ email: EMAIL })).notify.dailyHour, 7);
});

test("admin push: support and reports reach owners and support, not viewers", async () => {
  await subscribed();
  assert.equal(await adminPush.notify("support", { title: "x", body: "y", url: "#support" }), 1);
  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  assert.equal(await adminPush.notify("support", { title: "x", body: "y", url: "#support" }), 0);
  assert.equal(await adminPush.notify("daily", { title: "x", body: "y", url: "#dashboard" }), 1);
});

test("admin push: a device that is gone is forgotten", async () => {
  await subscribed();
  failWith = 410;
  assert.equal(await adminPush.notify("approvals", { title: "x", body: "y" }), 0);
  assert.equal(await AdminPushSubscription.countDocuments(), 0);
});

test("admin push: the day's numbers once a day at the chosen hour (Berlin)", async () => {
  await subscribed();
  await Admin.updateOne({ email: EMAIL }, { "notify.dailyHour": 20 });
  // 19:30 Berlin (summer time): not yet
  assert.equal(await adminPush.dailyDue(new Date("2026-09-29T17:30:00Z")), 0);
  // 20:05 Berlin: now, and only once
  assert.equal(await adminPush.dailyDue(new Date("2026-09-29T18:05:00Z")), 1);
  assert.equal(await adminPush.dailyDue(new Date("2026-09-29T19:00:00Z")), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Heute bei Wanna yap?");
  assert.match(sent[0].payload.body, /neue Nutzer · \d+ aktiv · \d+ Gespräche · \d+ Besuche auf der Website/);
  // Next day again
  assert.equal(await adminPush.dailyDue(new Date("2026-09-30T18:10:00Z")), 1);
});

test("admin push: a support message from the app arrives as a push", async () => {
  await subscribed();
  await request(ctx.app).post("/verify/start").send({ phone: "+4915111111111" }).expect(200);
  const token = (await request(ctx.app).post("/verify/check").send({ phone: "+4915111111111", code: fakes.approvedCode }).expect(200)).body.token;
  const opened = await request(ctx.app).post("/support").set("Authorization", `Bearer ${token}`).send({ category: "bug", message: "Anrufe klingeln nicht" }).expect(200);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Neue Support-Anfrage: Fehler");
  assert.equal(sent[0].payload.body, "Anrufe klingeln nicht");
  assert.equal(sent[0].payload.url, `#support/${opened.body.ticket.id}`);
});

test("today: numbers so far next to last week, and what is waiting (by role)", async () => {
  const cookie = await ownerCookie();
  const LandingVisit = require("../models/LandingVisit");
  const WaitlistEntry = require("../models/WaitlistEntry");
  const { localParts, shiftDateKey } = require("../lib/localTime");
  const day = localParts(new Date(), "Europe/Berlin").dateKey;
  await LandingVisit.create({ day, source: "tiktok", campaign: "", visits: 7 });
  await LandingVisit.create({ day: shiftDateKey(day, -7), source: "direkt", campaign: "", visits: 3 });
  await WaitlistEntry.create({ email: "a@example.com", code: "AAAA2222", token: "t".repeat(48), status: "confirmed", confirmedAt: new Date() });
  await AdDraft.create({ campaign: "yap-0929-c", title: "C", template: "chat", status: "pending" });

  const data = (await request(ctx.app).get("/admin/today").set(admin(cookie)).expect(200)).body;
  assert.equal(data.day, day);
  assert.equal(data.today.visits, 7);
  assert.equal(data.lastWeekDay.visits, 3);
  assert.equal(data.today.waitlist, 1);
  assert.equal(typeof data.today.newUsers, "number");
  assert.deepEqual(data.todo, { approvals: 1, support: 0, reports: 0 });

  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  assert.equal((await request(ctx.app).get("/admin/today").set(admin(cookie)).expect(200)).body.todo, null);
});
