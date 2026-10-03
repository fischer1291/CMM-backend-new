// The weekly report (plan 2.11): the week condensed from MetricsDaily, sent
// Monday from 08:00 once per week, the review with the hours of operations,
// and the dead-man rule weekly_silent.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const AlertState = require("../models/AlertState");
const AppConfig = require("../models/AppConfig");
const MetricsDaily = require("../models/MetricsDaily");
const User = require("../models/User");
const WeeklyReview = require("../models/WeeklyReview");
const adminPush = require("../lib/adminPush");
const weeklyReport = require("../lib/weeklyReport");
const { saveConfig } = require("../lib/appConfig");
const { shiftDateKey, isoWeek } = require("../lib/localTime");
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

const DAY = 24 * 3600 * 1000;
const OWNER = { email: "owner@example.com", password: "a-long-admin-password" };
const SUB = { endpoint: "https://web.push.apple.com/QGx-weekly-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

async function ownerCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...OWNER, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...OWNER, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}

/** The owner invites `email` with `role`; returns that admin's cookie. */
async function teammate(cookie, email, role) {
  await request(ctx.app).post("/admin/admins").set(admin(cookie)).send({ email, role }).expect(200);
  const token = fakes.mails.findLast((m) => m.to === email).text.match(/#setup\/([a-f0-9]{48})/)[1];
  const started = await request(ctx.app).post("/admin/auth/setup").send({ inviteToken: token, password: "another-long-password" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ email, password: "another-long-password", code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}

/** Seven final snapshots for the week from `monday`; `extra(i)` adds to day i. */
async function seedWeek(monday, extra = () => ({})) {
  for (let i = 0; i < 7; i++) {
    const day = shiftDateKey(monday, i);
    const sunday = i === 6;
    await MetricsDaily.create({
      day,
      partial: false,
      users: { new: 2, dau: 10, wau: sunday ? 110 : 90, activation4w: sunday ? 37 : 35, activationSample: sunday ? 120 : 110, density: { c3plus: 52, c0: 10, sample: 60 } },
      talks: { count: 3, minutes: 20 },
      circles: { roomMinutes: 5 },
      growth: { invites: 4, joinedViaInvite: 1, inviteVisits: { total: 5, ios: 4, android: 1, other: 0 }, bySource: { friend: 1, tiktok: i === 0 ? 1 : 0, none: 0 }, byCampaign: { "campus-ms": { new: 1 } } },
      plus: {
        newPaid: i === 2 ? 2 : 0,
        cancelled: i === 3 ? 1 : 0,
        expired: 0,
        trialsStarted: i === 1 ? 3 : 0,
        trialsConverted: i === 5 ? 1 : 0,
        mrrCents: sunday ? 8400 : 7000,
        funnel: { paywallView: 10, purchaseStart: 2, purchaseSuccess: i === 2 ? 2 : 0, purchaseError: i === 4 ? 1 : 0 },
      },
      costs: { variableEurCents: 10.5 },
      ops: { smsStarted: 3 },
      ...extra(i),
    });
  }
}

test("weekly report: week sums, k, north star and the hours of the last review", async () => {
  // Monday 2026-09-28, 09:00 in Berlin: the last full week is 21.–27.09. (KW 39)
  const now = new Date("2026-09-28T07:00:00Z");
  await seedWeek("2026-09-21");
  await MetricsDaily.create({ day: "2026-09-20", partial: false, users: { wau: 100 } });
  await AlertState.create({ tag: "sms_cap", lastAt: new Date("2026-09-24T10:00:00Z"), lastText: "x" });
  await AlertState.create({ tag: "tick_late", lastAt: new Date("2026-09-28T03:00:00Z"), lastText: "x" });
  await User.create({ phone: "+4915100000001", name: "Ana", research: { invitedAt: new Date("2026-09-10T10:00:00Z"), doneAt: new Date("2026-09-23T10:00:00Z") } });
  await User.create({ phone: "+4915100000002", name: "Ben", research: { invitedAt: new Date("2026-09-10T10:00:00Z"), doneAt: new Date("2026-09-18T10:00:00Z") } });
  // Two admins acknowledged the week before: their hours add up
  await WeeklyReview.create({ week: "2026-W38", admin: new Admin()._id, email: "a@example.com", hours: { alerts: 1, support: 2, approvals: 0.5 }, ackAt: now });
  await WeeklyReview.create({ week: "2026-W38", admin: new Admin()._id, email: "b@example.com", hours: { alerts: 0, support: 1, approvals: 0 }, ackAt: now });
  await WeeklyReview.create({ week: "2026-W37", admin: new Admin()._id, email: "a@example.com", hours: { alerts: 9, support: 9, approvals: 9 }, ackAt: now });

  const r = await weeklyReport.report(undefined, now);
  assert.equal(r.week, "2026-W39");
  assert.equal(r.from, "2026-09-21");
  assert.equal(r.to, "2026-09-27");
  assert.equal(r.missingDays, 0);
  const section = (key) => r.sections.find((s) => s.key === key);

  const north = section("north").data;
  assert.equal(north.activation.pct4w, 37);
  assert.equal(north.activation.ok, false);
  assert.equal(north.density.ok, true);
  assert.equal(north.wau, 110);
  assert.equal(north.wauChangePct, 10);
  assert.deepEqual(north.talks, { count: 21, minutes: 175 });

  const invites = section("invites").data;
  assert.equal(invites.newUsers, 14);
  assert.equal(invites.joinedViaInvite, 7);
  assert.equal(invites.inviteVisits, 35);
  assert.equal(invites.invites, 28);
  assert.equal(invites.k, 0.5);

  assert.deepEqual(section("sources").data.bySource, { friend: 7, tiktok: 1, none: 0 });
  const plus = section("plus").data;
  assert.equal(plus.newPaid, 2);
  assert.equal(plus.cancelled, 1);
  assert.equal(plus.trialsStarted, 3);
  assert.equal(plus.trialsConverted, 1);
  assert.equal(plus.mrrCents, 8400, "MRR as of Sunday");
  const paywall = section("paywall").data;
  assert.equal(paywall.paywallView, 70);
  assert.equal(paywall.purchaseSuccess, 2);
  assert.equal(paywall.failures, 1);
  const costs = section("costs").data;
  assert.equal(costs.smsStarted, 21);
  assert.equal(costs.smsPerSignup, 1.5);
  assert.equal(costs.variableEurCents, 73.5);
  assert.deepEqual(section("alerts").data.tags.map((t) => t.tag), ["sms_cap"], "only alerts of that week");
  assert.equal(section("research").data.done, 1);
  // Without a seed campaign the seed cluster counts sign-ups through invites
  assert.deepEqual(section("seed").data, { campaign: null, signups: 7, goal: 30, ok: false });
  const hours = section("hours").data;
  assert.equal(hours.week, "2026-W38");
  assert.equal(hours.total, 4.5);
  assert.equal(hours.admins, 2);

  assert.match(r.text, /^Wanna yap\? Woche 39 \(21\.09\.–27\.09\.2026\)/);
  assert.match(r.text, /Aktivierung 4 W: 37 % \(Ziel 40\) 🔴/);
  assert.match(r.text, /WAU: 110 \(\+10 % zur Vorwoche\)/);
  assert.match(r.text, /k \(über Einladung \/ neu\): 0,5/);
  assert.match(r.text, /SMS je Registrierung: 1,5/);
  assert.match(r.text, /Variable Kosten: 0,74 €/);
  assert.match(r.text, /Plus: \+2 neu · 1 gekündigt · 0 abgelaufen/);
  assert.match(r.text, /MRR: 84 €/);
  assert.match(r.text, /Alarme: sms_cap\n/);
  assert.match(r.text, /Betrieb KW 38: 4,5 h \(Alarme 1 · Support 3 · Freigaben 0,5\), Ziel unter 5 h 🟢/);
  assert.match(r.text, /erst ab 200 Aufrufen je Woche aussagekräftig/);
  assert.equal(r.headline, "Aktivierung 37 % 🔴");

  // With a seed campaign: its sign-ups against the goal
  await AppConfig.updateOne({ key: "app" }, { $set: { goals: { seedCampaign: "campus-ms", seedSignupsPerWeek: 5 } } }, { upsert: true });
  const seeded = (await weeklyReport.report("2026-W39", now)).sections.find((s) => s.key === "seed");
  assert.deepEqual(seeded.data, { campaign: "campus-ms", signups: 7, goal: 5, ok: true });
  assert.match(seeded.lines[0], /Seed-Cluster \(campus-ms\): 7 Registrierungen \(Ziel 5, Annahme\) 🟢/);

  // The seed goal is a whole number from 1
  assert.equal((await saveConfig({ goals: { seedSignupsPerWeek: 0 } }, OWNER.email)).error, "invalid_goals");
  assert.equal((await saveConfig({ goals: { seedSignupsPerWeek: 40 } }, OWNER.email)).error, undefined);
  assert.equal((await AppConfig.findOne({ key: "app" }).lean()).goals.seedSignupsPerWeek, 40);

  // A Monday as a date is the same week; the running week and nonsense are not
  assert.equal(weeklyReport.resolveWeek("2026-09-21", now).week, "2026-W39");
  assert.equal(weeklyReport.resolveWeek("2026-09-22", now), null);
  assert.equal(weeklyReport.resolveWeek("2026-W40", now), null);
  assert.equal(weeklyReport.resolveWeek("2026-W60", now), null);
});

test("weekly report: sent Monday from 08:00, once per week, mail to the owners and push kind weekly", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: SUB }).expect(200);
  const push = (await request(ctx.app).get("/admin/push").set(admin(cookie)).expect(200)).body;
  assert.ok(push.kinds.includes("weekly"));
  assert.equal(push.notify.weekly, true);
  fakes.mails.length = 0;

  // Monday 28.09., 07:59 in Berlin: not yet
  assert.equal(await weeklyReport.weeklyDue(new Date("2026-09-28T05:59:00Z")), null);
  assert.equal(fakes.mails.length, 0);
  // 08:05: last week's report
  const first = await weeklyReport.weeklyDue(new Date("2026-09-28T06:05:00Z"));
  assert.deepEqual(first, { week: "2026-W39", mails: 1, pushes: 1 });
  assert.equal(fakes.mails[0].to, OWNER.email);
  assert.match(fakes.mails[0].subject, /^Wanna yap\? Woche 39: /);
  assert.match(fakes.mails[0].text, /Wanna yap\? Woche 39/);
  assert.match(fakes.mails[0].text, /console\/#weekly/);
  assert.match(fakes.mails[0].text, /DECISIONS\.md/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Wochenreport KW 39");
  assert.equal(sent[0].payload.url, "#weekly");
  const ops = (await AppConfig.findOne({ key: "app" }).lean()).ops;
  assert.equal(ops.weeklyReportFor, "2026-W39");
  const firstAt = ops.weeklyReportFirstAt;
  assert.ok(firstAt);

  // A second run that day or later that week sends nothing
  assert.equal(await weeklyReport.weeklyDue(new Date("2026-09-28T06:20:00Z")), null);
  assert.equal(await weeklyReport.weeklyDue(new Date("2026-10-01T10:00:00Z")), null);
  assert.equal(fakes.mails.length, 1);
  assert.equal(sent.length, 1);

  // Next Monday, two leaders at once: only one sends. The push follows the switch
  await request(ctx.app).put("/admin/push/settings").set(admin(cookie)).send({ weekly: false }).expect(200);
  const both = await Promise.all([weeklyReport.weeklyDue(new Date("2026-10-05T06:05:00Z")), weeklyReport.weeklyDue(new Date("2026-10-05T06:05:00Z"))]);
  assert.equal(both.filter(Boolean).length, 1);
  assert.deepEqual(both.find(Boolean), { week: "2026-W40", mails: 1, pushes: 0 });
  assert.equal(fakes.mails.length, 2);
  assert.equal(sent.length, 1);
  const later = (await AppConfig.findOne({ key: "app" }).lean()).ops;
  assert.equal(later.weeklyReportFor, "2026-W40");
  assert.equal(later.weeklyReportFirstAt.getTime(), firstAt.getTime(), "the first report stays the first");
});

test("weekly report: no owner yet, nothing is sent or claimed", async () => {
  assert.equal(await weeklyReport.weeklyDue(new Date("2026-09-28T06:05:00Z")), null);
  assert.equal(await AppConfig.countDocuments(), 0);
});

test("weekly review: GET for everyone, ack with hours for owners and support, validated and audited", async () => {
  const cookie = await ownerCookie();
  const viewer = await teammate(cookie, "vera@example.com", "viewer");
  const support = await teammate(cookie, "lea@example.com", "support");
  const last = weeklyReport.lastFullWeek(new Date());
  await seedWeek(last.monday);

  await request(ctx.app).get("/admin/weekly").expect(401);
  const read = (await request(ctx.app).get("/admin/weekly").set(admin(viewer)).expect(200)).body;
  assert.equal(read.report.week, last.week);
  assert.equal(read.reviews.length, 0);
  assert.equal(read.nextWeek, null);
  assert.equal(read.previousWeek, isoWeek(shiftDateKey(last.monday, -7)));
  assert.match(read.report.text, /k \(über Einladung \/ neu\): 0,5/);
  await request(ctx.app).get("/admin/weekly?week=2026-W99").set(admin(viewer)).expect(400);
  const older = (await request(ctx.app).get(`/admin/weekly?week=${read.previousWeek}`).set(admin(viewer)).expect(200)).body;
  assert.equal(older.nextWeek, last.week);

  const ack = (who, body) => request(ctx.app).post("/admin/weekly/ack").set(admin(who)).send(body);
  const hours = { alerts: 1.25, support: "2,5", approvals: 0 };
  await ack(viewer, { week: last.week, hours }).expect(403);
  assert.equal((await ack(cookie, { week: last.week }).expect(400)).body.error, "hours_required");
  assert.equal((await ack(cookie, { week: last.week, hours: { alerts: 1, support: 1 } }).expect(400)).body.error, "hours_required");
  assert.equal((await ack(cookie, { week: last.week, hours: { ...hours, alerts: 81 } }).expect(400)).body.error, "invalid_hours");
  assert.equal((await ack(cookie, { week: last.week, hours: { ...hours, support: "viel" } }).expect(400)).body.error, "invalid_hours");
  assert.equal((await ack(cookie, { week: last.week, hours, decisions: ["a", "b", "c", "d"] }).expect(400)).body.error, "invalid_decisions");
  assert.equal((await ack(cookie, { week: last.week, hours, decisions: ["x".repeat(301)] }).expect(400)).body.error, "invalid_decisions");
  assert.equal((await ack(cookie, { week: "2026-W99", hours }).expect(400)).body.error, "invalid_week");
  const future = isoWeek(shiftDateKey(last.monday, 14));
  assert.equal((await ack(cookie, { week: future, hours }).expect(400)).body.error, "invalid_week");

  const done = (await ack(cookie, { week: last.week, hours, decisions: ["Kanal + TikTok", "  ", "Hook: Erstis im Oktober"] }).expect(200)).body.review;
  assert.deepEqual(done.hours, { alerts: 1.3, support: 2.5, approvals: 0 });
  assert.deepEqual(done.decisions, ["Kanal + TikTok", "Hook: Erstis im Oktober"]);
  // A second ack replaces the first
  await ack(cookie, { week: last.week, hours: { alerts: 1, support: 2, approvals: 0.5 }, decisions: ["Budget bleibt"] }).expect(200);
  // The running week works as well
  await ack(support, { week: isoWeek(shiftDateKey(last.monday, 7)), hours: { alerts: 0, support: 1, approvals: 0 } }).expect(200);
  await ack(support, { week: last.week, hours: { alerts: 0, support: 3, approvals: 0 } }).expect(200);
  assert.equal(await WeeklyReview.countDocuments({ week: last.week }), 2);
  assert.equal(await AdminAudit.countDocuments({ action: "weekly_ack" }), 4);

  const after = (await request(ctx.app).get(`/admin/weekly?week=${last.week}`).set(admin(viewer)).expect(200)).body;
  assert.deepEqual(after.reviews.map((r) => r.email), [OWNER.email, "lea@example.com"]);
  assert.deepEqual(after.reviews[0].decisions, ["Budget bleibt"]);
  const hoursSection = after.report.sections.find((s) => s.key === "hours").data;
  assert.equal(hoursSection.total, 6.5);
});

test("dead-man: weekly_silent after 14 days of reports without an owner's acknowledgement, not before", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: SUB }).expect(200);
  const owner = await Admin.findOne({ email: OWNER.email }).lean();
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * DAY);
  const firstReport = (at) => AppConfig.updateOne({ key: "app" }, { $set: { "ops.weeklyReportFirstAt": at } }, { upsert: true });
  // The owner signs in, so owner_silent stays quiet throughout
  await Admin.updateOne({ _id: owner._id }, { lastLoginAt: now });

  // No report yet, then reports for only 13 days: quiet
  assert.equal(await adminPush.deadManCheck(now), null);
  await firstReport(ago(13));
  assert.equal(await adminPush.deadManCheck(now), null);

  // 15 days of reports, no acknowledgement: the owners get a push (no contact set)
  await firstReport(ago(15));
  assert.equal(await adminPush.deadManCheck(now), "push");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Wochenreport seit 14 Tagen offen");
  assert.equal(sent[0].payload.url, "#weekly");
  assert.match(sent[0].payload.body, /Seit 14 Tagen hat kein Owner den Wochenreport quittiert/);
  assert.equal(await AlertState.countDocuments({ tag: "owner_silent" }), 0);
  assert.equal((await AlertState.findOne({ tag: "weekly_silent" }).lean()).count, 1);
  // Once per 7 days
  assert.equal(await adminPush.deadManCheck(new Date(now.getTime() + DAY)), null);
  assert.equal(sent.length, 1);

  // An owner's acknowledgement within 14 days keeps it quiet; support's does not count
  await AlertState.deleteOne({ tag: "weekly_silent" });
  await WeeklyReview.create({ week: "2026-W39", admin: owner._id, email: OWNER.email, hours: { alerts: 1, support: 1, approvals: 1 }, ackAt: ago(10) });
  assert.equal(await adminPush.deadManCheck(now), null);
  await WeeklyReview.updateOne({ admin: owner._id }, { ackAt: ago(15) });
  await WeeklyReview.create({ week: "2026-W40", admin: new Admin()._id, email: "lea@example.com", hours: { alerts: 0, support: 2, approvals: 0 }, ackAt: ago(2) });

  // With an emergency contact: a mail that names the reason
  assert.equal((await saveConfig({ ops: { emergencyContact: "vertrauen@example.com" } }, OWNER.email)).error, undefined);
  fakes.mails.length = 0;
  assert.equal(await adminPush.deadManCheck(now), "mail");
  assert.equal(fakes.mails.length, 1);
  assert.equal(fakes.mails[0].to, "vertrauen@example.com");
  assert.match(fakes.mails[0].subject, /Wochenreport seit 14 Tagen nicht quittiert/);
  assert.match(fakes.mails[0].text, /Wochenreport quittiert/);
  assert.match(fakes.mails[0].text, /EMERGENCY\.md/);
  assert.match((await AlertState.findOne({ tag: "weekly_silent" }).lean()).lastText, /wurde informiert/);

  // An owner silent for 7 days: owner_silent speaks, not both
  await AlertState.deleteMany({});
  await Admin.updateOne({ _id: owner._id }, { lastLoginAt: ago(8), lastAckAt: null });
  fakes.mails.length = 0;
  assert.equal(await adminPush.deadManCheck(now), "mail");
  assert.equal(fakes.mails.length, 1);
  assert.match(fakes.mails[0].subject, /7 Tage nicht quittiert/);
  assert.equal(await AlertState.countDocuments({ tag: "weekly_silent" }), 0);
  assert.equal(await AlertState.countDocuments({ tag: "owner_silent" }), 1);
});
