const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const AlertState = require("../models/AlertState");
const adminPush = require("../lib/adminPush");
const { saveConfig } = require("../lib/appConfig");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
let sent = [];
before(async () => {
  // Fake Web Push service: records what would go to the phone
  adminPush.setSender(async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  });
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  await AlertState.syncIndexes();
  sent = [];
});

const OWNER = { email: "owner@example.com", password: "a-long-admin-password" };
const PASSWORD = "another-long-password";
const DAY = 24 * 3600 * 1000;
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

async function ownerCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...OWNER, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ ...OWNER, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}

/** The owner invites `email`; returns the token from the mail. */
async function invite(cookie, email, role) {
  const res = await request(ctx.app).post("/admin/admins").set(admin(cookie)).send({ email, role }).expect(200);
  const mail = fakes.mails.findLast((m) => m.to === email);
  return { res: res.body, token: mail.text.match(/#setup\/([a-f0-9]{48})/)[1] };
}

/** Finish the setup behind an invitation; returns the new admin's cookie. */
async function acceptInvite(token, email, password = PASSWORD) {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: token, password }).expect(200);
  assert.equal(started.body.email, email);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email, password, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}

test("team: an invitation creates an inactive admin with a one-time link; the link sets up and activates", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/admins").set(admin(cookie)).send({ email: "kein-mail", role: "support" }).expect(400);
  await request(ctx.app).post("/admin/admins").set(admin(cookie)).send({ email: "lea@example.com", role: "boss" }).expect(400);
  await request(ctx.app).post("/admin/admins").set(admin(cookie)).send({ email: OWNER.email, role: "support" }).expect(409);

  const { res, token } = await invite(cookie, "lea@example.com", "support");
  assert.equal(res.mailed, true);
  assert.equal(res.link, null);
  assert.equal(res.admin.invitePending, true);
  assert.match(fakes.mails[0].subject, /eingeladen/);
  assert.match(fakes.mails[0].text, /\/console\/#setup\//);
  const lea = await Admin.findOne({ email: "lea@example.com" });
  assert.equal(lea.active, false);
  assert.equal(lea.totpEnabled, false);
  assert.equal(lea.role, "support");
  assert.equal(lea.invitedBy, OWNER.email);
  assert.ok(lea.inviteTokenHash && lea.inviteTokenHash !== token, "only the hash is stored");
  assert.ok(lea.inviteExpiresAt - Date.now() > 6 * DAY);

  const list = (await request(ctx.app).get("/admin/admins").set(admin(cookie)).expect(200)).body;
  assert.deepEqual(list.admins.map((a) => [a.email, a.role, a.active, a.invitePending, a.me]), [[OWNER.email, "owner", true, false, true], ["lea@example.com", "support", false, true, false]]);
  assert.ok(!JSON.stringify(list).includes("Hash") && !JSON.stringify(list).includes("totpSecret"), "no secrets in the list");

  // The first-admin route stays shut; the token opens its own door
  await request(ctx.app).post("/admin/auth/setup").send({ email: "x@example.com", password: PASSWORD, setupKey: "admin-key" }).expect(409);
  await request(ctx.app).get("/admin/auth/invite/ffff").expect(404);
  const who = (await request(ctx.app).get(`/admin/auth/invite/${token}`).expect(200)).body;
  assert.deepEqual([who.email, who.role, who.invitedBy], ["lea@example.com", "support", OWNER.email]);
  await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: token, password: "short" }).expect(400);
  await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: "f".repeat(48), password: PASSWORD }).expect(404);
  // Not signed in before the setup is done
  await request(ctx.app).post("/admin/auth/login").send({ email: "lea@example.com", password: PASSWORD, code: "000000" }).expect(401);

  // An interrupted first step can start over: the token holds until the code is confirmed
  await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: token, password: "a-first-try-password" }).expect(200);
  const leaCookie = await acceptInvite(token, "lea@example.com");
  const me = (await request(ctx.app).get("/admin/me").set(admin(leaCookie)).expect(200)).body.admin;
  assert.deepEqual([me.email, me.role], ["lea@example.com", "support"]);
  const after = await Admin.findOne({ email: "lea@example.com" });
  assert.equal(after.active, true);
  assert.equal(after.totpEnabled, true);
  assert.equal(after.inviteTokenHash, null);
  await request(ctx.app).get(`/admin/auth/invite/${token}`).expect(404);
  await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: token, password: PASSWORD }).expect(404);
  // Support sees no team
  await request(ctx.app).get("/admin/admins").set(admin(leaCookie)).expect(403);

  const actions = (await AdminAudit.find({}).sort({ at: 1 }).lean()).map((a) => a.action);
  assert.ok(actions.includes("admin_invited"));
  assert.equal(actions.filter((a) => a === "setup_done").length, 2);
});

test("team: roles change, the last owner stays, nobody deactivates themselves, a deactivated admin is out and can be invited again", async () => {
  const cookie = await ownerCookie();
  const owner = await Admin.findOne({ email: OWNER.email });
  await request(ctx.app).delete(`/admin/admins/${owner._id}`).set(admin(cookie)).expect(400);
  assert.equal((await request(ctx.app).put(`/admin/admins/${owner._id}`).set(admin(cookie)).send({ role: "support" }).expect(409)).body.error, "last_owner");
  await request(ctx.app).put(`/admin/admins/${owner._id}`).set(admin(cookie)).send({ role: "chef" }).expect(400);
  await request(ctx.app).delete("/admin/admins/nope").set(admin(cookie)).expect(400);
  await request(ctx.app).delete(`/admin/admins/${"0".repeat(24)}`).set(admin(cookie)).expect(404);

  const { token } = await invite(cookie, "lea@example.com", "viewer");
  const leaCookie = await acceptInvite(token, "lea@example.com");
  const lea = await Admin.findOne({ email: "lea@example.com" });
  // Promoted to owner: now the first owner may step down and back up again
  await request(ctx.app).put(`/admin/admins/${lea._id}`).set(admin(cookie)).send({ role: "owner" }).expect(200);
  await request(ctx.app).put(`/admin/admins/${owner._id}`).set(admin(cookie)).send({ role: "support" }).expect(200);
  // Not an owner any more: no team for them
  await request(ctx.app).get("/admin/admins").set(admin(cookie)).expect(403);
  await request(ctx.app).put(`/admin/admins/${owner._id}`).set(admin(leaCookie)).send({ role: "owner" }).expect(200);

  // Deactivated: signed out at once, listed as inactive, no longer counted as an owner
  const gone = (await request(ctx.app).delete(`/admin/admins/${lea._id}`).set(admin(cookie)).expect(200)).body.admin;
  assert.equal(gone.active, false);
  await request(ctx.app).get("/admin/me").set(admin(leaCookie)).expect(401);
  await request(ctx.app).post("/admin/auth/login").send({ email: "lea@example.com", password: PASSWORD, code: totpAt(lea.totpSecret, currentStep()) }).expect(401);
  assert.equal((await Admin.findOne({ email: "lea@example.com" })).sessionVersion, lea.sessionVersion + 1);
  assert.equal((await request(ctx.app).delete(`/admin/admins/${owner._id}`).set(admin(cookie)).expect(400)).body.error, "self");
  assert.equal((await request(ctx.app).put(`/admin/admins/${owner._id}`).set(admin(cookie)).send({ role: "viewer" }).expect(409)).body.error, "last_owner");
  // Pushes and alert mails skip a deactivated owner
  assert.equal(await adminPush.notify("alerts", { title: "x", body: "y" }), 0);

  // Invited again: a fresh start with the old record
  const again = await invite(cookie, "lea@example.com", "support");
  assert.equal(again.res.admin.invitePending, true);
  const back = await acceptInvite(again.token, "lea@example.com", "a-brand-new-password");
  assert.equal((await request(ctx.app).get("/admin/me").set(admin(back)).expect(200)).body.admin.role, "support");
  assert.equal(await Admin.countDocuments({ email: "lea@example.com" }), 1);

  const actions = (await AdminAudit.find({ admin: OWNER.email }).lean()).map((a) => a.action);
  for (const a of ["admin_invited", "admin_role", "admin_deactivated"]) assert.ok(actions.includes(a), a);
});

test("ack: the morning push links to #ack, acknowledging sets lastAckAt", async () => {
  const cookie = await ownerCookie();
  assert.equal((await Admin.findOne({ email: OWNER.email })).lastAckAt, null);
  const before = Date.now();
  const res = await request(ctx.app).post("/admin/daily/ack").set(admin(cookie)).expect(200);
  const owner = await Admin.findOne({ email: OWNER.email });
  assert.ok(owner.lastAckAt >= new Date(before - 1000));
  assert.equal(new Date(res.body.lastAckAt).getTime(), owner.lastAckAt.getTime());

  const SUB = { endpoint: "https://web.push.apple.com/QGx-test-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: SUB }).expect(200);
  assert.equal(await adminPush.dailyDue(new Date("2026-09-29T06:05:00Z")), 1);
  assert.equal(sent[0].payload.url, "#ack");
});

test("dead-man: without a sign of life for 7 days a mail to the emergency contact, else a push; once per 7 days", async () => {
  const cookie = await ownerCookie();
  const now = new Date();
  const at = (days) => new Date(now.getTime() + days * DAY);
  // Fresh sign-in: all quiet
  assert.equal(await adminPush.deadManCheck(now), null);
  assert.equal(await AlertState.countDocuments({ tag: "owner_silent" }), 0);

  // Nothing for 8 days and no emergency contact: the owners get a push
  const SUB = { endpoint: "https://web.push.apple.com/QGx-test-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: SUB }).expect(200);
  await Admin.updateOne({ email: OWNER.email }, { lastLoginAt: at(-8), lastAckAt: null });
  assert.equal(await adminPush.deadManCheck(now), "push");
  assert.equal(fakes.mails.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Quittung fehlt seit 7 Tagen");
  assert.equal(sent[0].payload.url, "#ack");
  // Not again right away
  assert.equal(await adminPush.deadManCheck(at(1)), null);
  assert.equal(sent.length, 1);

  // With an emergency contact: a mail, once per 7 days
  assert.equal((await saveConfig({ ops: { emergencyContact: "kein-mail" } }, OWNER.email)).error, "invalid_ops");
  assert.equal((await saveConfig({ ops: { emergencyContact: " Vertrauen@Example.com " } }, OWNER.email)).error, undefined);
  const masked = (await request(ctx.app).get("/admin/config").set(admin(cookie)).expect(200)).body.config.ops.emergencyContact;
  assert.equal(masked, "vertrauen@example.com");
  assert.equal(await adminPush.deadManCheck(at(8)), "mail");
  assert.equal(fakes.mails.length, 1);
  assert.equal(fakes.mails[0].to, "vertrauen@example.com");
  assert.match(fakes.mails[0].subject, /7 Tage nicht quittiert/);
  assert.match(fakes.mails[0].text, /EMERGENCY\.md/);
  assert.equal(await adminPush.deadManCheck(at(9)), null);
  assert.equal(fakes.mails.length, 1);
  const state = await AlertState.findOne({ tag: "owner_silent" }).lean();
  assert.equal(state.count, 2);

  // An acknowledgement is a sign of life
  await AlertState.deleteOne({ tag: "owner_silent" });
  await request(ctx.app).post("/admin/daily/ack").set(admin(cookie)).expect(200);
  assert.equal(await adminPush.deadManCheck(new Date()), null);
  await Admin.updateOne({ email: OWNER.email }, { lastAckAt: at(-8) });
  assert.equal(await adminPush.deadManCheck(now), "mail");
  assert.equal(fakes.mails.length, 2);

  // The mail cannot go out: a push to the owners that says so, nothing claims
  // the contact knows
  await AlertState.deleteOne({ tag: "owner_silent" });
  fakes.failMailTo = "vertrauen@example.com";
  sent = [];
  assert.equal(await adminPush.deadManCheck(now), "push");
  fakes.failMailTo = null;
  assert.equal(fakes.mails.length, 2);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].payload.body, /wurde informiert/);
  assert.match(sent[0].payload.body, /konnte nicht per Mail erreicht werden/);
  assert.match((await AlertState.findOne({ tag: "owner_silent" }).lean()).lastText, /konnte nicht per Mail erreicht werden/);

  // Support sees only that a contact is set
  const { token } = await invite(cookie, "lea@example.com", "support");
  const leaCookie = await acceptInvite(token, "lea@example.com");
  assert.equal((await request(ctx.app).get("/admin/config").set(admin(leaCookie)).expect(200)).body.config.ops.emergencyContact, "•••");
});
