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

// --- Phase 10b: users, support, moderation -------------------------------------

const Report = require("../models/Report");
const CallMoment = require("../models/CallMoment");
const BannedNumber = require("../models/BannedNumber");
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

async function named(phone, name) {
  const token = await appLogin(phone);
  await User.updateOne({ phone }, { name });
  return { token, id: String((await User.findOne({ phone }))._id) };
}

test("users: search by name or number, masked; detail is audited; reveal is logged", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna Berg");
  await named(BEN, "Ben Koch");

  const byName = await request(ctx.app).get("/admin/users?q=anna").set("Cookie", cookie).expect(200);
  assert.deepEqual(byName.body.users.map((u) => u.name), ["Anna Berg"]);
  assert.equal(byName.body.users[0].phone, "+49 ••• 111");
  const byNumber = await request(ctx.app).get("/admin/users?q=0152 2222").set("Cookie", cookie).expect(200);
  assert.deepEqual(byNumber.body.users.map((u) => u.name), ["Ben Koch"]);
  const odd = await request(ctx.app).get("/admin/users?q=(.*").set("Cookie", cookie).expect(200);
  assert.equal(odd.body.users.length, 0);

  const detail = await request(ctx.app).get(`/admin/users/${anna.id}`).set("Cookie", cookie).expect(200);
  assert.equal(detail.body.user.name, "Anna Berg");
  assert.ok(!JSON.stringify(detail.body).includes(ANNA), "no full number in the detail");
  const revealed = await request(ctx.app).post(`/admin/users/${anna.id}/reveal`).set(admin(cookie)).expect(200);
  assert.equal(revealed.body.phone, ANNA);
  const actions = (await AdminAudit.find({ target: anna.id }).lean()).map((a) => a.action);
  assert.deepEqual(actions.sort(), ["phone_revealed", "user_view"]);

  // A viewer can't look at people
  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  await request(ctx.app).get("/admin/users").set("Cookie", cookie).expect(403);
});

test("support: end sessions, test push, reset push tokens", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await request(ctx.app).get("/me").set("Authorization", `Bearer ${anna.token}`).expect(200);

  await new Promise((r) => setTimeout(r, 1100)); // tokens carry seconds
  await request(ctx.app).post(`/admin/users/${anna.id}/logout`).set(admin(cookie)).expect(200);
  await request(ctx.app).get("/me").set("Authorization", `Bearer ${anna.token}`).expect(401);
  // Signing in again works
  await new Promise((r) => setTimeout(r, 1100));
  const fresh = await appLogin(ANNA);
  await request(ctx.app).get("/me").set("Authorization", `Bearer ${fresh}`).expect(200);

  let push = await request(ctx.app).post(`/admin/users/${anna.id}/test-push`).set(admin(cookie)).expect(200);
  assert.equal(push.body.result, "no_token");
  await User.updateOne({ phone: ANNA }, { pushToken: "ExponentPushToken[anna]" });
  push = await request(ctx.app).post(`/admin/users/${anna.id}/test-push`).set(admin(cookie)).expect(200);
  assert.equal(push.body.result, "sent");
  assert.equal(fakes.expoPushes.at(-1).data.type, "support_test");

  await request(ctx.app).post(`/admin/users/${anna.id}/reset-push`).set(admin(cookie)).expect(200);
  assert.equal((await User.findOne({ phone: ANNA })).pushToken, undefined);
});

test("suspend: offline, signed out, no sign-in until lifted", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await User.updateOne({ phone: ANNA }, { isAvailable: true });

  await request(ctx.app).post(`/admin/users/${anna.id}/suspend`).set(admin(cookie)).send({ days: 0 }).expect(400);
  await request(ctx.app).post(`/admin/users/${anna.id}/suspend`).set(admin(cookie)).send({ days: 7, reason: "Spam" }).expect(200);
  const suspended = await User.findOne({ phone: ANNA });
  assert.equal(suspended.isAvailable, false);
  assert.ok(suspended.suspendedUntil > new Date(Date.now() + 6 * 24 * 3600 * 1000));
  await request(ctx.app).get("/me").set("Authorization", `Bearer ${anna.token}`).expect(401);
  const start = await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(403);
  assert.match(start.body.error, /gesperrt/);
  await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(403);

  await request(ctx.app).post(`/admin/users/${anna.id}/unsuspend`).set(admin(cookie)).expect(200);
  await new Promise((r) => setTimeout(r, 1100));
  const token = await appLogin(ANNA);
  await request(ctx.app).get("/me").set("Authorization", `Bearer ${token}`).expect(200);
});

test("ban and delete: owner only, typed confirmation; a banned number can't come back", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  const ben = await named(BEN, "Ben");

  await request(ctx.app).post(`/admin/users/${anna.id}/ban`).set(admin(cookie)).send({ reason: "x" }).expect(400);
  await request(ctx.app).post(`/admin/users/${anna.id}/ban`).set(admin(cookie)).send({ reason: "Belästigung", confirm: "SPERREN" }).expect(200);
  assert.equal(await User.countDocuments({ phone: ANNA }), 0);
  assert.equal(await BannedNumber.countDocuments(), 1);
  await request(ctx.app).get("/status/get").set("Authorization", `Bearer ${anna.token}`).expect(401);
  const again = await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(403);
  assert.match(again.body.error, /gesperrt/);

  await Admin.updateOne({ email: EMAIL }, { role: "support" });
  await request(ctx.app).post(`/admin/users/${ben.id}/delete`).set(admin(cookie)).send({ confirm: "LÖSCHEN" }).expect(403);
  await Admin.updateOne({ email: EMAIL }, { role: "owner" });
  await request(ctx.app).post(`/admin/users/${ben.id}/delete`).set(admin(cookie)).send({ confirm: "LÖSCHEN" }).expect(200);
  assert.equal(await User.countDocuments({ phone: BEN }), 0);
  // Deleted, not banned: can sign up again
  await request(ctx.app).post("/verify/start").send({ phone: BEN }).expect(200);
});

test("reports: queue with context; hide the moment settles all its reports; suspend settles the person's", async () => {
  const { cookie } = await setUpAdmin();
  await named(ANNA, "Anna");
  await named(BEN, "Ben");
  const CARL = "+4915333333333";
  await named(CARL, "Carl");
  const moment = await CallMoment.create({
    userPhone: ANNA, userName: "Anna", targetPhone: BEN, targetName: "Ben",
    screenshot: "https://example.com/m.jpg", mood: "😊", callDuration: "05:00",
  });
  const r1 = await Report.create({ reporter: BEN, reported: ANNA, momentId: moment._id, reason: "inappropriate" });
  await Report.create({ reporter: CARL, reported: ANNA, momentId: moment._id, reason: "inappropriate" });
  const r3 = await Report.create({ reporter: CARL, reported: ANNA, reason: "harassment", note: "schreibt nachts" });

  const queue = await request(ctx.app).get("/admin/reports").set("Cookie", cookie).expect(200);
  assert.equal(queue.body.reports.length, 3);
  const first = queue.body.reports[0];
  assert.equal(first.reported.name, "Anna");
  assert.equal(first.reported.reportsAgainst, 3);
  assert.equal(first.moment.screenshot, "https://example.com/m.jpg");
  assert.equal(first.reporter.phone, "+49 ••• 222");

  await request(ctx.app).post(`/admin/reports/${r1._id}/resolve`).set(admin(cookie)).send({ action: "nope" }).expect(400);
  const hidden = await request(ctx.app).post(`/admin/reports/${r1._id}/resolve`).set(admin(cookie)).send({ action: "hide_moment" }).expect(200);
  assert.equal(hidden.body.settled, 2);
  assert.equal((await CallMoment.findById(moment._id)).hidden, true);
  await request(ctx.app).post(`/admin/reports/${r1._id}/resolve`).set(admin(cookie)).send({ action: "dismiss" }).expect(409);

  await Admin.updateOne({ email: EMAIL }, { role: "support" });
  await request(ctx.app).post(`/admin/reports/${r3._id}/resolve`).set(admin(cookie)).send({ action: "ban" }).expect(403);
  await request(ctx.app).post(`/admin/reports/${r3._id}/resolve`).set(admin(cookie)).send({ action: "suspend", days: 3 }).expect(200);
  assert.ok((await User.findOne({ phone: ANNA })).suspendedUntil > new Date());
  const resolved = await request(ctx.app).get("/admin/reports?status=resolved").set("Cookie", cookie).expect(200);
  assert.deepEqual(resolved.body.reports.map((r) => r.resolution).sort(), ["hide_moment", "hide_moment", "suspend"]);
  assert.equal((await request(ctx.app).get("/admin/reports").set("Cookie", cookie)).body.reports.length, 0);
});

// --- Phase 10c: support tickets, app config, export ------------------------------

const SupportTicket = require("../models/SupportTicket");

test("support: the app opens a ticket, support answers with a push, the user replies", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await User.updateOne({ phone: ANNA }, { pushToken: "ExponentPushToken[anna]" });
  const app = (req) => req.set("Authorization", `Bearer ${anna.token}`);

  await app(request(ctx.app).post("/support")).send({ category: "nope", message: "Hallo" }).expect(400);
  const opened = await app(request(ctx.app).post("/support"))
    .send({ category: "bug", message: "Anrufe klingeln nicht", app: { version: "1.0.0", build: "21", platform: "ios", os: "18.6" } })
    .expect(200);
  const id = opened.body.ticket.id;

  const queue = await request(ctx.app).get("/admin/tickets").set("Cookie", cookie).expect(200);
  assert.equal(queue.body.tickets.length, 1);
  assert.equal(queue.body.tickets[0].user.name, "Anna");
  assert.equal(queue.body.tickets[0].app.build, "21");
  assert.equal(queue.body.counts.open, 1);

  await request(ctx.app).post(`/admin/tickets/${id}/reply`).set(admin(cookie)).send({ text: "" }).expect(400);
  await request(ctx.app).post(`/admin/tickets/${id}/reply`).set(admin(cookie)).send({ text: "Schau mal in die Mitteilungen-Einstellungen." }).expect(200);
  assert.equal(fakes.expoPushes.at(-1).title, "Antwort vom Support");

  let mine = await app(request(ctx.app).get("/support")).expect(200);
  assert.equal(mine.body.tickets[0].status, "answered");
  assert.equal(mine.body.tickets[0].unread, true);
  assert.deepEqual(mine.body.tickets[0].messages.map((m) => m.from), ["user", "support"]);
  assert.ok(!("by" in mine.body.tickets[0].messages[1]), "no admin e-mail in the app");

  await app(request(ctx.app).post(`/support/${id}/reply`)).send({ message: "Danke, klappt!" }).expect(200);
  mine = await app(request(ctx.app).get("/support")).expect(200);
  assert.equal(mine.body.tickets[0].status, "open");
  assert.equal(mine.body.tickets[0].unread, false);

  // Someone else can't read or answer it
  const ben = await named(BEN, "Ben");
  await request(ctx.app).post(`/support/${id}/reply`).set("Authorization", `Bearer ${ben.token}`).send({ message: "x" }).expect(404);
  assert.equal((await request(ctx.app).get("/support").set("Authorization", `Bearer ${ben.token}`)).body.tickets.length, 0);

  await request(ctx.app).post(`/admin/tickets/${id}/status`).set(admin(cookie)).send({ status: "closed" }).expect(200);
  assert.equal((await SupportTicket.findById(id)).status, "closed");
});

test("app config: public min version, banner and flags; only the owner changes them", async () => {
  const { cookie } = await setUpAdmin();
  let pub = await request(ctx.app).get("/app-config").expect(200);
  assert.deepEqual({ minVersion: pub.body.minVersion, banner: pub.body.banner, flags: pub.body.flags }, { minVersion: null, banner: null, flags: {} });

  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ minVersion: "one" }).expect(400);
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ banner: { enabled: true, text: "" } }).expect(400);
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ flags: { "Bad Key": true } }).expect(400);
  await request(ctx.app)
    .put("/admin/config")
    .set(admin(cookie))
    .send({ minVersion: "1.0.0", minBuild: 21, updateUrl: "https://testflight.apple.com/join/abc", banner: { enabled: true, text: "Heute Abend kurz Wartung", level: "warning" }, flags: { group_calls: true } })
    .expect(200);
  pub = await request(ctx.app).get("/app-config").expect(200);
  assert.equal(pub.body.minBuild, 21);
  assert.equal(pub.body.banner.text, "Heute Abend kurz Wartung");
  assert.deepEqual(pub.body.flags, { group_calls: true });

  // An expired banner disappears
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ banner: { enabled: true, text: "Vorbei", until: "2020-01-01" } }).expect(200);
  assert.equal((await request(ctx.app).get("/app-config")).body.banner, null);

  await Admin.updateOne({ email: EMAIL }, { role: "support" });
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ minBuild: 22 }).expect(403);
  await request(ctx.app).get("/admin/config").set("Cookie", cookie).expect(200);
});

test("app versions: remembered from request headers, shown per version", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await request(ctx.app)
    .get("/status/get")
    .set({ Authorization: `Bearer ${anna.token}`, "X-App-Version": "1.0.0", "X-App-Build": "21", "X-Platform": "ios", "X-OS-Version": "18.6" })
    .expect(200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await User.findOne({ phone: ANNA })).app.build, "21");
  const config = await request(ctx.app).get("/admin/config").set("Cookie", cookie).expect(200);
  assert.deepEqual(config.body.versions, [{ version: "1.0.0", build: "21", platform: "ios", users: 1 }]);
  const detail = await request(ctx.app).get(`/admin/users/${anna.id}`).set("Cookie", cookie).expect(200);
  assert.equal(detail.body.user.app.version, "1.0.0");
});

test("export: the owner downloads everything about a person; it's audited", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await SupportTicket.create({ phone: ANNA, category: "idea", messages: [{ from: "user", text: "Dark mode für Android" }] });
  const res = await request(ctx.app).get(`/admin/users/${anna.id}/export`).set("Cookie", cookie).expect(200);
  assert.match(res.headers["content-disposition"], /attachment/);
  assert.equal(res.body.profile.name, "Anna");
  assert.equal(res.body.support[0].messages[0].text, "Dark mode für Android");
  assert.equal(await AdminAudit.countDocuments({ action: "user_exported", target: anna.id }), 1);
  await Admin.updateOne({ email: EMAIL }, { role: "support" });
  await request(ctx.app).get(`/admin/users/${anna.id}/export`).set("Cookie", cookie).expect(403);
});

// --- Moments in the console --------------------------------------------------------

test("moments: list with filters and report counts; hide, unhide, delete settle the reports", async () => {
  const { cookie } = await setUpAdmin();
  await named(ANNA, "Anna");
  await named(BEN, "Ben");
  const base = { userPhone: ANNA, userName: "Anna", targetPhone: BEN, targetName: "Ben", screenshot: "data:image/jpeg;base64,AAAA", mood: "😊", callDuration: "03:00" };
  const m1 = await CallMoment.create({ ...base, note: "Eins" });
  const m2 = await CallMoment.create({ ...base, note: "Zwei" });
  await Report.create({ reporter: BEN, reported: ANNA, momentId: m1._id, reason: "inappropriate" });

  const all = await request(ctx.app).get("/admin/moments").set("Cookie", cookie).expect(200);
  assert.equal(all.body.moments.length, 2);
  assert.equal(all.body.counts.reported, 1);
  assert.equal(all.body.moments.find((m) => m.id === String(m1._id)).reports.open, 1);
  assert.equal(all.body.moments[0].author.name, "Anna");
  assert.equal(all.body.moments[0].author.phone, "+49 ••• 111");

  const reported = await request(ctx.app).get("/admin/moments?filter=reported").set("Cookie", cookie).expect(200);
  assert.deepEqual(reported.body.moments.map((m) => m.note), ["Eins"]);

  const hide = await request(ctx.app).post(`/admin/moments/${m1._id}/hide`).set(admin(cookie)).expect(200);
  assert.equal(hide.body.settled, 1);
  assert.equal((await Report.findOne({ momentId: m1._id })).resolution, "hide_moment");
  assert.deepEqual((await request(ctx.app).get("/admin/moments?filter=hidden").set("Cookie", cookie)).body.moments.map((m) => m.note), ["Eins"]);
  await request(ctx.app).post(`/admin/moments/${m1._id}/unhide`).set(admin(cookie)).expect(200);
  assert.equal((await CallMoment.findById(m1._id)).hidden, false);

  await request(ctx.app).post(`/admin/moments/${m2._id}/delete`).set(admin(cookie)).expect(200);
  assert.equal(await CallMoment.countDocuments({ _id: m2._id }), 0);
  const byUser = await request(ctx.app).get(`/admin/moments?user=${(await User.findOne({ phone: BEN }))._id}`).set("Cookie", cookie).expect(200);
  assert.equal(byUser.body.moments.length, 1);
  assert.deepEqual((await AdminAudit.find({ action: /^moment_/ }).lean()).map((a) => a.action).sort(), ["moment_deleted", "moment_hidden", "moment_unhidden"]);

  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  await request(ctx.app).get("/admin/moments").set("Cookie", cookie).expect(403);
});

// --- Wanna yap+ in the console -------------------------------------------------------

test("plus: owner grants and revokes, stats count subscribers and interest, limits are editable", async () => {
  const { cookie } = await setUpAdmin();
  const anna = await named(ANNA, "Anna");
  await request(ctx.app).post("/me/plus-interest").set("Authorization", `Bearer ${anna.token}`).send({ features: ["family"] }).expect(200);

  await request(ctx.app).post(`/admin/users/${anna.id}/plus`).set(admin(cookie)).send({ days: 0 }).expect(400);
  await request(ctx.app).post(`/admin/users/${anna.id}/plus`).set(admin(cookie)).send({ days: 30 }).expect(200);
  let stats = (await request(ctx.app).get("/admin/plus").set("Cookie", cookie).expect(200)).body;
  assert.equal(stats.active, 1);
  assert.equal(stats.bySource.admin, 1);
  assert.equal(stats.interest.total, 1);
  assert.equal(stats.interest.features.family, 1);
  const detail = await request(ctx.app).get(`/admin/users/${anna.id}`).set("Cookie", cookie).expect(200);
  assert.equal(detail.body.user.plan, "plus");

  await request(ctx.app).post(`/admin/users/${anna.id}/plus`).set(admin(cookie)).send({ revoke: true }).expect(200);
  stats = (await request(ctx.app).get("/admin/plus").set("Cookie", cookie)).body;
  assert.equal(stats.active, 0);

  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ limits: { free: { circles: 0 } } }).expect(400);
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ limits: { free: { circleMembers: 999 } } }).expect(400);
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ limits: { free: { circles: 5, memoriesDays: null } } }).expect(200);
  const plan = (await request(ctx.app).get("/me/plan").set("Authorization", `Bearer ${anna.token}`)).body;
  assert.equal(plan.limits.circles, 5);
  assert.equal(plan.limits.memoriesDays, null);

  await Admin.updateOne({ email: EMAIL }, { role: "support" });
  await request(ctx.app).post(`/admin/users/${anna.id}/plus`).set(admin(cookie)).send({ days: 30 }).expect(403);
});
