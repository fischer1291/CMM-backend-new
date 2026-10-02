// The north star (lib/metrics.js): rolling activation of the last four full
// weeks, address book density of new people, both in the day's snapshot, and
// the goals they are judged against (lib/appConfig.js goals). Also the keyed
// pseudonym of ActiveDay rows (plan 2.8, lib/pseudonyms.js).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const { setup, teardown, reset } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const ActiveDay = require("../models/ActiveDay");
const AppConfig = require("../models/AppConfig");
const { activation4w, density, computeDay, todayKey, markActive, resetActivityCache, retention } = require("../lib/metrics");
const { backfillPhoneHmac, rekeyActiveDays } = require("../lib/pseudonyms");
const { saveConfig, getConfig, publicConfig, goalsConfig } = require("../lib/appConfig");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const DAY = 24 * 3600 * 1000;
// Users carry their sign-up time in the ObjectId; `n` keeps ids apart
const idAt = (date, n) => new mongoose.Types.ObjectId(Math.floor(date.getTime() / 1000).toString(16).padStart(8, "0") + String(n).padStart(16, "0"));
let seq = 0;
const signup = (date, extra = {}) => ({ _id: idAt(date, ++seq), phone: `+49151${String(seq).padStart(7, "0")}`, ...extra });

test("activation4w: the sign-ups of the last four full weeks together, measured once their week is over", async () => {
  // A Wednesday: this week started Monday 2026-09-28, the four weeks before run 08-31 to 09-27
  const now = new Date("2026-09-30T10:00:00Z");
  const users = [
    signup(new Date("2026-09-01T09:00:00Z")), // talked two days later: activated
    signup(new Date("2026-09-10T09:00:00Z")), // never talked
    signup(new Date("2026-09-25T09:00:00Z")), // window not over: not measured yet
    signup(new Date("2026-09-28T09:00:00Z")), // this week: not in the cohorts
    signup(new Date("2026-08-20T09:00:00Z")), // too old
  ];
  await User.insertMany(users);
  await Talk.create([
    { callId: "t1", participants: [users[0].phone, "+499"], startedAt: new Date("2026-09-03T18:00:00Z"), seconds: 120 },
    { callId: "t2", participants: [users[3].phone, "+499"], startedAt: new Date("2026-09-29T18:00:00Z"), seconds: 120 },
  ]);
  assert.deepEqual(await activation4w(now), { pct: 50, measured: 2, size: 3, from: "2026-08-31", to: "2026-09-27" });

  // The snapshot carries the number and the sample
  const day = await computeDay(todayKey(now), now);
  assert.equal(day.users.activation4w, 50);
  assert.equal(day.users.activationSample, 2);
  // Two of them are 7 to 35 days in, both without contacts
  assert.deepEqual(day.users.density, { c3plus: 0, c0: 100, sample: 2 });

  // Nobody signed up in the window: nothing to judge
  await User.deleteMany({});
  assert.deepEqual(await activation4w(now), { pct: null, measured: 0, size: 0, from: "2026-08-31", to: "2026-09-27" });
});

test("density: of people 7 to 35 days in, the share with three registered contacts and the share with none", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const ago = (days) => new Date(now.getTime() - days * DAY);
  await User.insertMany([
    signup(ago(10), { contacts: ["+491", "+492", "+493"] }),
    signup(ago(20), { contacts: [] }),
    signup(ago(30), { contacts: ["+491"] }),
    signup(ago(3), { contacts: ["+491", "+492", "+493", "+494"] }), // too new
    signup(ago(40), { contacts: [] }), // too old
  ]);
  assert.deepEqual(await density(now), { c3plus: 33, c0: 33, sample: 3 });
  assert.deepEqual((await computeDay(todayKey(now), now)).users.density, { c3plus: 33, c0: 33, sample: 3 });
});

test("goals: validated on their own, defaults filled in, never sent to the app", async () => {
  assert.deepEqual(await goalsConfig(), { activationPct: 40, densityPct: 50 });
  for (const bad of [{ activationPct: 0 }, { activationPct: 101 }, { activationPct: 1.5 }, { activationPct: "40" }, { densityPct: null }, { retentionPct: 20 }]) {
    assert.equal((await saveConfig({ goals: bad }, "owner@test")).error, "invalid_goals", JSON.stringify(bad));
  }
  await saveConfig({ goals: { activationPct: 30 } }, "owner@test");
  assert.deepEqual((await getConfig()).goals, { activationPct: 30, densityPct: 50 });
  assert.equal("goals" in (await publicConfig()), false);
  assert.equal("goals" in (await request(ctx.app).get("/app-config").expect(200)).body, false);
  // Other settings leave the block alone
  await saveConfig({ ops: { smsPerDay: 50 } }, "owner@test");
  assert.deepEqual(await goalsConfig(), { activationPct: 30, densityPct: 50 });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

test("hmacPhone: keyed with the pepper, never the plain SHA-256 the app can compute", () => {
  const phone = "+4915111111111";
  const pepper = process.env.PHONE_HASH_PEPPER;
  const keyed = User.hmacPhone(phone);
  assert.match(keyed, /^[0-9a-f]{64}$/);
  assert.notEqual(keyed, User.hashPhone(phone));
  assert.equal(User.hmacPhone(phone), keyed);
  assert.equal(User.phonePepperConfigured(), true);
  try {
    // Another pepper, another key: the pepper is set once and never changed
    process.env.PHONE_HASH_PEPPER = "other-pepper";
    assert.notEqual(User.hmacPhone(phone), keyed);
    // Without the variable a value derived from JWT_SECRET keeps the server working
    delete process.env.PHONE_HASH_PEPPER;
    assert.equal(User.phonePepperConfigured(), false);
    assert.match(User.hmacPhone(phone), /^[0-9a-f]{64}$/);
    assert.notEqual(User.hmacPhone(phone), User.hashPhone(phone));
    assert.notEqual(User.hmacPhone(phone), keyed);
  } finally {
    process.env.PHONE_HASH_PEPPER = pepper;
  }
  assert.equal(User.hmacPhone(phone), keyed);
});

test("markActive writes the keyed hash; sign-up stores phoneHmac; retention reads the same key", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const phone = "+4915111111111";
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  await request(ctx.app).post("/verify/check").send({ phone, code: "123456" }).expect(200);
  const user = await User.findOne({ phone }).lean();
  assert.equal(user.phoneHmac, User.hmacPhone(phone));
  assert.equal(user.phoneHash, User.hashPhone(phone));

  resetActivityCache();
  markActive(phone, now);
  await flush();
  const rows = await ActiveDay.find({ day: todayKey(now) }).lean();
  assert.deepEqual(rows.map((r) => r.who), [User.hmacPhone(phone)]);
  assert.equal(await ActiveDay.countDocuments({ who: User.hashPhone(phone) }), 0);

  // A user who signed up last week and was active this week counts in retention
  await User.deleteMany({});
  const lastWeek = new Date(now.getTime() - 7 * DAY);
  const u = signup(lastWeek, { phoneHash: User.hashPhone("+491510000001"), phoneHmac: User.hmacPhone("+491510000001") });
  u.phone = "+491510000001";
  await User.create(u);
  await ActiveDay.create({ day: todayKey(now), who: User.hmacPhone(u.phone) });
  const cohorts = await retention(2, now);
  assert.equal(cohorts[0].size, 1);
  assert.deepEqual(cohorts[0].weeks, [1]);
});

test("migration: phoneHmac is added to older accounts, SHA-256 activity rows are re-keyed once, both idempotent", async () => {
  const anna = "+4915111111111";
  const ben = "+4915222222222";
  const gone = "+4915333333333"; // deleted long ago: no account to re-key its rows
  await User.create([
    { phone: anna, phoneHash: User.hashPhone(anna) },
    { phone: ben, phoneHash: User.hashPhone(ben), phoneHmac: User.hmacPhone(ben) },
  ]);
  await ActiveDay.create([
    { day: "2026-09-01", who: User.hashPhone(anna) },
    { day: "2026-09-02", who: User.hashPhone(anna) },
    // The same day already exists under the new key (deploy overlap): the old row goes
    { day: "2026-09-03", who: User.hashPhone(anna) },
    { day: "2026-09-03", who: User.hmacPhone(anna) },
    { day: "2026-09-01", who: User.hashPhone(ben) },
    { day: "2026-09-01", who: User.hashPhone(gone) },
  ]);

  assert.deepEqual(await backfillPhoneHmac(), { added: 1, rekeyed: 0 });
  assert.equal((await User.findOne({ phone: anna }).lean()).phoneHmac, User.hmacPhone(anna));
  assert.equal((await User.findOne({ phone: ben }).lean()).phoneHmac, User.hmacPhone(ben));
  assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 0 });

  assert.equal(await rekeyActiveDays(), 3);
  const days = async (who) => (await ActiveDay.find({ who }).sort({ day: 1 }).lean()).map((r) => r.day);
  assert.deepEqual(await days(User.hmacPhone(anna)), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(await days(User.hashPhone(anna)), []);
  assert.deepEqual(await days(User.hmacPhone(ben)), ["2026-09-01"]);
  // Nobody is left to re-key this one; it expires with the TTL
  assert.deepEqual(await days(User.hashPhone(gone)), ["2026-09-01"]);
  assert.equal(await ActiveDay.countDocuments(), 5);
  const config = await AppConfig.findOne({ key: "app" }).lean();
  assert.ok(config.migrations.activeDayHmac instanceof Date);
  assert.ok(config.migrations.phoneHmac instanceof Date);
  assert.equal(config.ops, undefined, "the marker creates no null subtrees on a fresh database");

  // Already done: a new SHA-256 row (an old instance still writing) is left alone
  await ActiveDay.create({ day: "2026-09-04", who: User.hashPhone(anna) });
  assert.equal(await rekeyActiveDays(), null);
  assert.deepEqual(await days(User.hashPhone(anna)), ["2026-09-04"]);
});

test("migration: a changed pepper re-keys phoneHmac and the activity rows under the old value, once", async () => {
  const anna = "+4915111111111";
  const ben = "+4915222222222";
  // The first deploy ran on the JWT_SECRET fallback; the owner set the real pepper afterwards
  const pepper = process.env.PHONE_HASH_PEPPER;
  delete process.env.PHONE_HASH_PEPPER;
  const oldKey = User.hmacPhone(anna);
  process.env.PHONE_HASH_PEPPER = pepper;
  assert.notEqual(oldKey, User.hmacPhone(anna));
  await User.create([
    { phone: anna, phoneHash: User.hashPhone(anna), phoneHmac: oldKey },
    { phone: ben, phoneHash: User.hashPhone(ben), phoneHmac: User.hmacPhone(ben) },
  ]);
  await ActiveDay.create([
    { day: "2026-09-01", who: oldKey },
    { day: "2026-09-02", who: oldKey },
    // Written by the new process already (deploy overlap): the old row goes
    { day: "2026-09-02", who: User.hmacPhone(anna) },
    { day: "2026-09-01", who: User.hmacPhone(ben) },
  ]);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 1 });
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => w.includes("re-keyed for 1 user")), warnings.join("\n"));
  assert.equal((await User.findOne({ phone: anna }).lean()).phoneHmac, User.hmacPhone(anna));
  const days = async (who) => (await ActiveDay.find({ who }).sort({ day: 1 }).lean()).map((r) => r.day);
  assert.deepEqual(await days(User.hmacPhone(anna)), ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(await days(oldKey), []);
  assert.deepEqual(await days(User.hmacPhone(ben)), ["2026-09-01"]);
  assert.equal(await ActiveDay.countDocuments(), 3);
  assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 0 });
});
