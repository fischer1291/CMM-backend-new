// Cost brakes on sign-up SMS (routes/verify.js, AppConfig.ops): the daily
// cap, the country allowlist, the kill switch, and the day's counters.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const { saveConfig, getConfig, publicConfig, opsConfig } = require("../lib/appConfig");
const { computeDay, todayKey } = require("../lib/metrics");
const { daySummary } = require("../lib/adminPush");
const { todayNumbers } = require("../lib/today");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const WIEN = "+436641234567";
const BERN = "+41791234567";
const US = "+12025550123";

const start = (phone) => request(ctx.app).post("/verify/start").send({ phone });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test("sms cap: the third start of the day is refused once smsPerDay is 2, and the day counts it", async () => {
  assert.equal((await saveConfig({ ops: { smsPerDay: 2 } }, "owner@test")).error, undefined);
  await start(ANNA).expect(200);
  await start(BEN).expect(200);
  const full = await start(CARL).expect(429);
  assert.equal(full.body.error, "Heute sind keine Anmeldungen mehr möglich. Bitte versuch es morgen noch einmal.");
  assert.deepEqual(fakes.sms, [ANNA, BEN]);

  // Checking a code still works for those who got one
  await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(200);
  await settle();
  const ops = (await computeDay(todayKey())).ops;
  assert.equal(ops.smsStarted, 2);
  assert.equal(ops.smsChecked, 1);
  assert.equal(ops.smsFailed, 0);

  const today = await todayNumbers();
  assert.deepEqual(today.sms, { started: 2, cap: 2, paused: false });
  assert.match(await daySummary(), /· SMS 2\/2$/);
});

test("sms allowlist: only DE, AT and CH by default; the console narrows it", async () => {
  const refused = await start(US).expect(403);
  assert.equal(refused.body.error, "Wanna yap? gibt es derzeit nur in Deutschland, Österreich und der Schweiz.");
  await start(WIEN).expect(200);
  await start(BERN).expect(200);
  assert.deepEqual(fakes.sms, [WIEN, BERN]);

  await saveConfig({ ops: { smsRegions: ["DE"] } }, "owner@test");
  await start(WIEN).expect(403);
  await start(ANNA).expect(200);
  await settle();
  assert.equal((await computeDay(todayKey())).ops.smsStarted, 3, "a refused number never counts against the cap");
});

test("sms allowlist: existing accounts outside the list keep signing in, new numbers don't", async () => {
  const MOVED = "+12025550199";
  await User.create({ phone: MOVED, phoneHash: User.hashPhone(MOVED) });
  await start(MOVED).expect(200);
  await start(US).expect(403);
  assert.deepEqual(fakes.sms, [MOVED]);
  await settle();
  assert.equal((await computeDay(todayKey())).ops.smsStarted, 1, "the existing account counts against the cap");
});

test("sms kill switch: smsPaused stops every start except the review login", async () => {
  await saveConfig({ ops: { smsPaused: true } }, "owner@test");
  const paused = await start(ANNA).expect(503);
  assert.equal(paused.body.error, "Die Anmeldung per SMS ist gerade pausiert. Bitte versuch es später noch einmal.");
  assert.deepEqual(fakes.sms, []);
  assert.match(await daySummary(), /· SMS pausiert$/);

  process.env.REVIEW_PHONE = US;
  process.env.REVIEW_CODE = "246810";
  try {
    await start(US).expect(200);
    await request(ctx.app).post("/verify/check").send({ phone: US, code: "246810" }).expect(200);
  } finally {
    delete process.env.REVIEW_PHONE;
    delete process.env.REVIEW_CODE;
  }
  await settle();
  const ops = (await computeDay(todayKey())).ops;
  assert.deepEqual([ops.smsStarted, ops.smsChecked], [0, 0], "the review login counts nothing");

  await saveConfig({ ops: { smsPaused: false } }, "owner@test");
  await start(ANNA).expect(200);
});

test("sms failures: a Twilio error answers 502 and counts smsFailed", async () => {
  fakes.failSmsTo = BEN;
  await start(ANNA).expect(200);
  await start(BEN).expect(502);
  await settle();
  const ops = (await computeDay(todayKey())).ops;
  assert.equal(ops.smsStarted, 2);
  assert.equal(ops.smsFailed, 1);
});

test("ops config: validated on its own, defaults filled in, never sent to the app", async () => {
  assert.deepEqual((await opsConfig()), { smsPerDay: 100, smsPaused: false, smsRegions: ["DE", "AT", "CH"] });
  for (const bad of [{ smsPerDay: 0 }, { smsPerDay: 1.5 }, { smsPerDay: 100001 }, { smsPaused: "yes" }, { smsRegions: [] }, { smsRegions: ["de"] }, { smsRegions: "DE" }, { smsChannel: "whatsapp" }]) {
    assert.equal((await saveConfig({ ops: bad }, "owner@test")).error, "invalid_ops", JSON.stringify(bad));
  }
  await saveConfig({ ops: { smsPerDay: 50, smsRegions: ["DE", "DE", "AT"] } }, "owner@test");
  assert.deepEqual((await getConfig()).ops, { smsPerDay: 50, smsPaused: false, smsRegions: ["DE", "AT"] });
  assert.equal("ops" in (await publicConfig()), false);
  assert.equal("ops" in (await request(ctx.app).get("/app-config").expect(200)).body, false);
  // Other settings leave the block alone
  await saveConfig({ flags: { group_calls: true } }, "owner@test");
  assert.equal((await opsConfig()).smsPerDay, 50);
});
