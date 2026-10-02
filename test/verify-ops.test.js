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
  // The morning push reports the day before
  assert.match(await daySummary(new Date(Date.now() + 24 * 3600 * 1000)), /· SMS 2\/2$/);
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
  assert.deepEqual((await opsConfig()), { smsPerDay: 100, smsPaused: false, smsRegions: ["DE", "AT", "CH"], alertPhone: null, emergencyContact: null, bankBalanceEurCents: null });
  for (const bad of [{ smsPerDay: 0 }, { smsPerDay: 1.5 }, { smsPerDay: 100001 }, { smsPaused: "yes" }, { smsRegions: [] }, { smsRegions: ["de"] }, { smsRegions: "DE" }, { smsChannel: "whatsapp" }]) {
    assert.equal((await saveConfig({ ops: bad }, "owner@test")).error, "invalid_ops", JSON.stringify(bad));
  }
  await saveConfig({ ops: { smsPerDay: 50, smsRegions: ["DE", "DE", "AT"] } }, "owner@test");
  assert.deepEqual((await getConfig()).ops, { smsPerDay: 50, smsPaused: false, smsRegions: ["DE", "AT"], alertPhone: null, emergencyContact: null, bankBalanceEurCents: null });
  assert.equal("ops" in (await publicConfig()), false);
  assert.equal("ops" in (await request(ctx.app).get("/app-config").expect(200)).body, false);
  // Other settings leave the block alone
  await saveConfig({ flags: { group_calls: true } }, "owner@test");
  assert.equal((await opsConfig()).smsPerDay, 50);
});

// --- REVIEW_UNTIL: the demo login ends with its last day (plan 2.1) -----------

const REVIEW = "+4915999999999";
const { reviewLoginStatus, reviewUntil } = require("../routes/verify");
const alerts = require("../lib/alerts");
const { shiftDateKey } = require("../lib/localTime");
const reviewRule = alerts.RULES.find((r) => r.tag === "review_login");
/** Run `fn` with the REVIEW_* variables set, and remove them afterwards. */
async function withReview(vars, fn) {
  const keys = ["REVIEW_PHONE", "REVIEW_CODE", "REVIEW_UNTIL"];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of keys) delete process.env[k];
  }
}

test("review login: on through the last day of REVIEW_UNTIL (Europe/Berlin), expired from the next midnight", async () => {
  const env = { REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: "2026-10-02" };
  // 23:59 and 00:00 Berlin time (CEST, UTC+2)
  assert.equal(reviewLoginStatus(new Date("2026-10-02T21:59:00Z"), env), "on");
  assert.equal(reviewLoginStatus(new Date("2026-10-02T22:00:00Z"), env), "expired");
  // Without REVIEW_UNTIL it stays on, as before
  assert.equal(reviewLoginStatus(new Date("2030-01-01T00:00:00Z"), { REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810" }), "on");
  // Not a real date: off, and said so
  for (const bad of ["2026-02-30", "02.10.2026", "morgen", "2026-1-5"]) {
    assert.equal(reviewLoginStatus(new Date("2026-01-01T12:00:00Z"), { ...env, REVIEW_UNTIL: bad }), "invalid_until", bad);
    assert.equal(reviewUntil({ REVIEW_UNTIL: bad }), "invalid", bad);
  }
  assert.equal(reviewUntil({ REVIEW_UNTIL: " 2026-10-02 " }), "2026-10-02");
  assert.equal(reviewUntil({}), null);
  assert.equal(reviewLoginStatus(new Date(), {}), "off");
});

test("review login: after REVIEW_UNTIL the number gets an SMS like everyone and the demo code no longer signs in", async () => {
  const today = todayKey();
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: today }, async () => {
    assert.equal((await request(ctx.app).get("/api/push-health").expect(200)).body.reviewLogin, "on");
    await start(REVIEW).expect(200);
    assert.deepEqual(fakes.sms, [], "no SMS while the demo login runs");
    await request(ctx.app).post("/verify/check").send({ phone: REVIEW, code: "246810" }).expect(200);
  });
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: shiftDateKey(today, -1) }, async () => {
    assert.equal((await request(ctx.app).get("/api/push-health").expect(200)).body.reviewLogin, "expired");
    await start(REVIEW).expect(200);
    assert.deepEqual(fakes.sms, [REVIEW], "an ordinary sign-up SMS");
    const refused = await request(ctx.app).post("/verify/check").send({ phone: REVIEW, code: "246810" }).expect(200);
    assert.equal(refused.body.success, false);
    assert.equal(refused.body.error, "Code nicht korrekt");
  });
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: "bald" }, async () => {
    assert.equal((await request(ctx.app).get("/api/push-health").expect(200)).body.reviewLogin, "invalid_until");
  });
});

test("alert review_login: asks for an end date, then for removing the variables; quiet when off or dated", async () => {
  const now = new Date();
  const today = todayKey(now);
  await withReview({}, async () => assert.equal(await reviewRule.check(now), null));
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: today }, async () => assert.equal(await reviewRule.check(now), null));
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810" }, async () => {
    assert.match(await reviewRule.check(now), /^Demo-Zugang ohne Ablaufdatum aktiv: REVIEW_UNTIL/);
  });
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: "2026-02-30" }, async () => {
    assert.match(await reviewRule.check(now), /^REVIEW_UNTIL ist kein Datum/);
  });
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "246810", REVIEW_UNTIL: shiftDateKey(today, -3) }, async () => {
    const text = await reviewRule.check(now);
    assert.match(text, /^Demo-Zugang abgelaufen: REVIEW_PHONE und REVIEW_CODE auf Render entfernen/);
    assert.doesNotMatch(text, /4915999999999|246810/, "never the number or the code");
    // Through runRules it goes out as a warning
    await require("../models/AlertState").syncIndexes();
    assert.deepEqual(await alerts.runRules(now), ["review_login"]);
    const state = await require("../models/AlertState").findOne({ tag: "review_login" }).lean();
    assert.equal(state.level, "warn");
  });
  // Expired with a broken leftover (code too short, number unparsable): still asks for removal
  await withReview({ REVIEW_PHONE: REVIEW, REVIEW_CODE: "12", REVIEW_UNTIL: shiftDateKey(today, -3) }, async () => {
    assert.equal(reviewLoginStatus(now), "expired");
    assert.match(await reviewRule.check(now), /^Demo-Zugang abgelaufen/);
  });
  await withReview({ REVIEW_PHONE: "keine Nummer", REVIEW_UNTIL: shiftDateKey(today, -3) }, async () => {
    assert.match(await reviewRule.check(now), /^Demo-Zugang abgelaufen/);
  });
  // Removed again: quiet
  await withReview({ REVIEW_UNTIL: shiftDateKey(today, -3) }, async () => assert.equal(await reviewRule.check(now), null));
});
