// Alerts (lib/alerts.js): once an hour per tag, push + mail + SMS for errors,
// the rules on constructed data, the backup ping, and no double alarm after
// a leader change (the debounce lives in the database).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AlertState = require("../models/AlertState");
const SupportTicket = require("../models/SupportTicket");
const MetricsDaily = require("../models/MetricsDaily");
const AppConfig = require("../models/AppConfig");
const adminPush = require("../lib/adminPush");
const alerts = require("../lib/alerts");
const opsCounters = require("../lib/opsCounters");
const { saveConfig, getConfig } = require("../lib/appConfig");
const { todayKey } = require("../lib/metrics");
const { shiftDateKey } = require("../lib/localTime");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
let sent = [];
const PING_KEY = "backup-ping-key-for-tests-0123456789";

before(async () => {
  process.env.BACKUP_PING_KEY = PING_KEY;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test";
  process.env.TWILIO_SMS_FROM = "+4915799999999";
  // Fake Web Push service, as in admin-push.test.js
  adminPush.setSender(async (sub, payload, options) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
  });
  ctx = await setup();
});
after(async () => {
  delete process.env.BACKUP_PING_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
  await teardown();
});
beforeEach(async () => {
  await reset();
  await AlertState.syncIndexes();
  sent = [];
});

const EMAIL = "owner@example.com";
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
const SUB = { endpoint: "https://web.push.apple.com/QGx-alerts-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
/** An owner with a subscribed phone; returns the console cookie. */
async function owner() {
  const who = { email: EMAIL, password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  const cookie = cookieOf(done);
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: SUB }).expect(200);
  return cookie;
}
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

test("alert: push, mail and (for errors) SMS go out once; the same tag is silent for an hour, then again", async () => {
  await owner();
  await saveConfig({ ops: { alertPhone: "+49 171 1234567" } }, EMAIL);
  const t0 = new Date("2026-10-01T10:00:00Z");

  assert.equal(await alerts.alert("demo_tag", "Etwas ist kaputt.", { level: "error", title: "Demo", now: t0 }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Demo");
  assert.equal(sent[0].payload.body, "Etwas ist kaputt.");
  assert.equal(sent[0].options.urgency, "high");
  assert.equal(sent[0].options.topic, "alert-demo_tag");
  assert.equal(fakes.mails.length, 1);
  assert.equal(fakes.mails[0].to, EMAIL);
  assert.equal(fakes.mails[0].subject, "[Wanna yap?] Demo");
  assert.match(fakes.mails[0].text, /^Etwas ist kaputt\./);
  assert.deepEqual(fakes.alertSms.map((s) => s.to), ["+491711234567"]);
  assert.match(fakes.alertSms[0].body, /^Wanna yap\? Demo: Etwas ist kaputt\./);

  // Within the hour: nothing, not even with a new text
  assert.equal(await alerts.alert("demo_tag", "Immer noch kaputt.", { level: "error", now: new Date(t0.getTime() + 59 * 60000) }), false);
  assert.equal(sent.length, 1);
  assert.equal(fakes.mails.length, 1);
  const state = await AlertState.findOne({ tag: "demo_tag" }).lean();
  assert.equal(state.count, 1);
  assert.equal(state.lastText, "Etwas ist kaputt.");

  // An hour later it goes out again; a warning gets no SMS
  assert.equal(await alerts.alert("demo_tag", "Noch immer.", { level: "warn", now: new Date(t0.getTime() + HOUR + 1000) }), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].options.urgency, "normal");
  assert.equal(fakes.alertSms.length, 1);
  assert.equal((await AlertState.findOne({ tag: "demo_tag" }).lean()).count, 2);

  // Without a number no SMS, even for errors
  await saveConfig({ ops: { alertPhone: null } }, EMAIL);
  assert.equal((await saveConfig({ ops: { alertPhone: "nope" } }, EMAIL)).error, "invalid_ops");
  assert.equal(await alerts.alert("other_tag", "Fehler.", { level: "error", now: t0 }), true);
  assert.equal(fakes.alertSms.length, 1);
});

test("rules: sms_failures, support_overdue, backup_stale, no_talks and sms_cap fire on constructed data", async () => {
  await owner();
  const now = new Date();
  const today = todayKey(now);
  // 2 of 5 sign-up SMS failed (40 %), and 5 of 6 is over 80 % of the cap
  await saveConfig({ ops: { smsPerDay: 6 } }, EMAIL);
  await opsCounters.count("smsStarted", now, 5);
  await opsCounters.count("smsFailed", now, 2);
  // A ticket the user wrote two days ago, still open
  const old = new Date(now.getTime() - 2 * DAY);
  await SupportTicket.create({ phone: "+4915111111111", category: "bug", status: "open", messages: [{ from: "user", text: "Hilfe", at: old }], createdAt: old, updatedAt: old });
  // One answered yesterday: not overdue
  await SupportTicket.create({ phone: "+4915222222222", category: "bug", status: "open", messages: [{ from: "user", text: "Hilfe", at: old }, { from: "support", text: "Moment", by: EMAIL, at: now }], createdAt: old, updatedAt: now });
  // The last dump reported nine days ago
  await AppConfig.updateOne({ key: "app" }, { $set: { "ops.lastBackupAt": new Date(now.getTime() - 9 * DAY) } }, { upsert: true });
  // Yesterday 25 active people, no talk
  await MetricsDaily.create({ day: shiftDateKey(today, -1), users: { dau: 25 }, talks: { count: 0 } });

  const fired = await alerts.runRules(now);
  assert.deepEqual(fired.sort(), ["backup_stale", "no_talks", "sms_cap", "sms_failures", "support_overdue"]);
  const texts = Object.fromEntries(sent.map((s) => [s.options.topic, s.payload.body]));
  assert.match(texts["alert-sms_failures"], /2 von 5 Anmelde-SMS .* \(40 %\)/);
  assert.match(texts["alert-support_overdue"], /^1 Ticket wartet seit über 24 Stunden/);
  assert.match(texts["alert-no_talks"], /25 Leute aktiv, aber kein Gespräch/);
  assert.match(texts["alert-sms_cap"], /5 von 6 Anmelde-SMS .* \(83 %\)/);
  assert.match(texts["alert-backup_stale"], /letzte Datenbank-Dump/);
  // Errors reach the mailbox too (owner), warnings as well
  assert.equal(fakes.mails.length, 5);

  // The morning push names the night's alerts
  assert.match(await adminPush.daySummary(now), /Alarme der Nacht: (\w+, ){4}\w+ · SMS/);
});

test("rules: nothing fires on an empty day; quiet thresholds hold", async () => {
  await owner();
  const now = new Date();
  await opsCounters.count("smsStarted", now, 4);
  await opsCounters.count("smsFailed", now, 4); // 100 %, but under 5 starts
  await MetricsDaily.create({ day: shiftDateKey(todayKey(now), -1), users: { dau: 20 }, talks: { count: 0 } }); // dau not over 20
  assert.deepEqual(await alerts.runRules(now), []);
  assert.equal(sent.length, 0);
});

test("rules: push_credentials, revenuecat and client_errors count through the day counters", async () => {
  await owner();
  const now = new Date();
  const { noteCredentialError } = require("../lib/push");
  noteCredentialError("DeviceNotRegistered"); // a dead token is no credential problem
  noteCredentialError("InvalidProviderToken");
  await new Promise((r) => setTimeout(r, 50));
  // A wrong webhook secret and a purchase for an unknown user
  await request(ctx.app).post("/webhooks/revenuecat").set("Authorization", "Bearer wrong").send({ event: { type: "INITIAL_PURCHASE" } }).expect(401);
  // Ten app errors today, none yesterday
  for (let i = 0; i < 10; i++) await request(ctx.app).post("/diagnostics/errors").send({ message: `Boom ${i}`, stack: `at f${i}` }).expect(200);
  await new Promise((r) => setTimeout(r, 50));

  const fired = await alerts.runRules(now);
  assert.deepEqual(fired.sort(), ["client_errors", "push_credentials", "revenuecat"]);
  const texts = Object.fromEntries(sent.map((s) => [s.options.topic, s.payload.body]));
  assert.match(texts["alert-push_credentials"], /heute 1× unsere Push-Zugangsdaten/);
  assert.match(texts["alert-revenuecat"], /1× abgelehnt \(Secret stimmt nicht\)/);
  assert.match(texts["alert-client_errors"], /Heute 10 gemeldete App-Fehler, gestern 0/);
});

test("backup ping: refused without the key, stores time and size with it; the alert history is for the console", async () => {
  const cookie = await owner();
  await request(ctx.app).post("/ops/backup-done").send({ bytes: 1234 }).expect(401);
  await request(ctx.app).post("/ops/backup-done").set("Authorization", "Bearer nope").send({ bytes: 1234 }).expect(401);
  const before = Date.now();
  const res = await request(ctx.app).post("/ops/backup-done").set("Authorization", `Bearer ${PING_KEY}`).send({ bytes: 1234, name: "2026-10-01.archive.gz.age" }).expect(200);
  assert.ok(new Date(res.body.lastBackupAt).getTime() >= before);
  const ops = (await getConfig()).ops;
  assert.equal(ops.lastBackupBytes, 1234);
  assert.equal(ops.lastBackupName, "2026-10-01.archive.gz.age");
  assert.ok(new Date(ops.lastBackupAt).getTime() >= before);
  // The console's own settings leave it alone
  await saveConfig({ ops: { smsPerDay: 50 } }, EMAIL);
  assert.equal((await getConfig()).ops.lastBackupBytes, 1234);
  // A fresh dump is no alert
  assert.deepEqual(await alerts.runRules(new Date()), []);

  await alerts.alert("demo_tag", "Text", { now: new Date() });
  const list = (await request(ctx.app).get("/admin/alerts").set(admin(cookie)).expect(200)).body.alerts;
  assert.equal(list.length, 1);
  assert.equal(list[0].tag, "demo_tag");
  assert.equal(list[0].count, 1);
  assert.equal(list[0].level, "warn");
  // Viewers see it too
  await Admin.updateOne({ email: EMAIL }, { role: "viewer" });
  await request(ctx.app).get("/admin/alerts").set(admin(cookie)).expect(200);
  // The config endpoint shows the last backup to the console
  assert.equal((await request(ctx.app).get("/admin/config").set(admin(cookie)).expect(200)).body.config.ops.lastBackupBytes, 1234);
});

test("leader change: two runs shortly after each other send one alarm, because the debounce is in the database", async () => {
  await owner();
  const now = new Date();
  await AppConfig.updateOne({ key: "app" }, { $set: { "ops.lastBackupAt": new Date(now.getTime() - 9 * DAY) } }, { upsert: true });
  assert.deepEqual(await alerts.runRules(now), ["backup_stale"]);
  // The next instance takes over the jobs and runs the rules again
  assert.deepEqual(await alerts.runRules(new Date(now.getTime() + 60000)), []);
  // Even both at once: exactly one wins
  await AlertState.deleteMany({});
  sent = [];
  const results = await Promise.all([alerts.runRules(now), alerts.runRules(now)]);
  assert.equal(results.flat().length, 1);
  assert.equal(sent.length, 1);
  assert.equal((await AlertState.findOne({ tag: "backup_stale" }).lean()).count, 1);
});
