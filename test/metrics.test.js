// The north star (lib/metrics.js): rolling activation of the last four full
// weeks, address book density of new people, both in the day's snapshot, and
// the goals they are judged against (lib/appConfig.js goals). Also the keyed
// pseudonym of ActiveDay rows (plan 2.8, lib/pseudonyms.js), and the revenue
// series of plan 2.4: MetricsDaily.plus, version and recomputation, paid30,
// the onboarding funnel, the density histogram, DST days and the Plus line
// of the morning push.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const { setup, teardown, reset } = require("./helpers");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Talk = require("../models/Talk");
const ActiveDay = require("../models/ActiveDay");
const AppConfig = require("../models/AppConfig");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const MetricsDaily = require("../models/MetricsDaily");
const { activation4w, density, computeDay, todayKey, markActive, resetActivityCache, retention, funnel, runSnapshots, dayRange, saveDay, METRICS_VERSION, RECOMPUTE_DAYS, RAW_TTL_DAYS, FUNNEL_STEPS } = require("../lib/metrics");
const { shiftDateKey, weekKey } = require("../lib/localTime");
const { signSession, hashPassword, newTotpSecret, COOKIE } = require("../lib/adminAuth");
const adminPush = require("../lib/adminPush");
const { backfillPhoneHmac, rekeyActiveDays, migrationValue } = require("../lib/pseudonyms");
const AlertState = require("../models/AlertState");
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
  assert.deepEqual(day.users.density, { c3plus: 0, c0: 100, sample: 2, c1_2: 0, c3_5: 0, c6plus: 0 });

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
  const expected = { c3plus: 33, c0: 33, sample: 3, c1_2: 33, c3_5: 33, c6plus: 0 };
  assert.deepEqual(await density(now), expected);
  assert.deepEqual((await computeDay(todayKey(now), now)).users.density, expected);
  // The histogram: six and more are part of c3plus but not of c3_5
  await User.insertMany([signup(ago(12), { contacts: ["+491", "+492", "+493", "+494", "+495", "+496"] })]);
  assert.deepEqual(await density(now), { c3plus: 50, c0: 25, sample: 4, c1_2: 25, c3_5: 25, c6plus: 25 });
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
  // The fingerprint of the pepper, never the pepper itself
  assert.equal(config.migrations.phoneHmacKey, User.phonePepperFingerprint());
  assert.ok(!config.migrations.phoneHmacKey.includes(process.env.PHONE_HASH_PEPPER));
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
  // Nobody reads the start log: the owners get the alert, once
  const state = await AlertState.findOne({ tag: "pepper_changed" }).lean();
  assert.equal(state.count, 1);
  assert.match(state.lastText, /von 1 Konto wurden umgeschlüsselt/);
  assert.equal(await migrationValue("phoneHmacKey"), User.phonePepperFingerprint());
});

test("migration: with the stored pepper fingerprint only accounts without phoneHmac are read; a new pepper reads them all", async () => {
  const anna = "+4915111111111";
  const ben = "+4915222222222";
  await User.create({ phone: anna, phoneHash: User.hashPhone(anna), phoneHmac: User.hmacPhone(anna) });
  assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 0 });
  assert.equal(await migrationValue("phoneHmacKey"), User.phonePepperFingerprint());

  // The fingerprint matches: an account with a stale value is not looked at
  // (a second process with the wrong env would otherwise flip it back and
  // forth on every start), a new account without the field still gets it
  await User.updateOne({ phone: anna }, { $set: { phoneHmac: "stale" } });
  await User.create({ phone: ben, phoneHash: User.hashPhone(ben) });
  assert.deepEqual(await backfillPhoneHmac(), { added: 1, rekeyed: 0 });
  assert.equal((await User.findOne({ phone: anna }).lean()).phoneHmac, "stale");
  assert.equal((await User.findOne({ phone: ben }).lean()).phoneHmac, User.hmacPhone(ben));
  assert.equal(await AlertState.countDocuments({ tag: "pepper_changed" }), 0);

  // Another pepper: the fingerprint differs, every account is read once
  const pepper = process.env.PHONE_HASH_PEPPER;
  process.env.PHONE_HASH_PEPPER = "a-new-pepper-that-should-never-happen";
  try {
    assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 2 });
    assert.equal((await User.findOne({ phone: anna }).lean()).phoneHmac, User.hmacPhone(anna));
    assert.equal((await User.findOne({ phone: ben }).lean()).phoneHmac, User.hmacPhone(ben));
    assert.equal(await migrationValue("phoneHmacKey"), User.phonePepperFingerprint());
    assert.equal((await AlertState.findOne({ tag: "pepper_changed" }).lean()).count, 1);
    assert.deepEqual(await backfillPhoneHmac(), { added: 0, rekeyed: 0 });
  } finally {
    process.env.PHONE_HASH_PEPPER = pepper;
  }
});

// --- Wanna yap+ as a time series (plan 2.4) ---------------------------------------

let evt = 0;
/** A stored RevenueCat event as the webhook keeps it (routes/plus.js recordEvent). */
const storeEvent = (userId, type, at, extra = {}) => ({
  rcEventId: `evt-${++evt}`,
  userId,
  appUserId: String(userId),
  type,
  productId: "wannayap_plus_monthly",
  store: "APP_STORE",
  environment: "PRODUCTION",
  periodType: "NORMAL",
  priceCents: 549,
  currency: "EUR",
  priceInPurchasedCurrencyCents: 499,
  eventAt: at,
  purchasedAt: at,
  result: "ok",
  ...extra,
});
const plusOf = (source, until, status = "active") => ({ active: true, until, since: new Date("2026-09-01T00:00:00Z"), source, status });

test("plus: purchases, trials, refunds and MRR from the day's production events; sandbox never counts; expiry lowers activeStore the next day", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const day1 = "2026-09-28";
  const day2 = "2026-09-29";
  const at1 = new Date("2026-09-28T12:00:00Z");
  const at2 = new Date("2026-09-29T12:00:00Z");
  const until = new Date("2026-10-28T12:00:00Z");
  const [anna, ben, carl, dora, emma] = [
    signup(new Date("2026-09-10T09:00:00Z"), { plus: plusOf("store", until) }),
    signup(new Date("2026-09-10T09:00:00Z"), { plus: { ...plusOf("store", new Date("2027-09-28T12:00:00Z")), productId: "wannayap_plus_yearly" } }),
    signup(new Date("2026-09-10T09:00:00Z"), { plus: plusOf("sandbox", until) }),
    signup(new Date("2026-09-10T09:00:00Z"), { plus: plusOf("referral", until, null) }),
    signup(new Date("2026-09-10T09:00:00Z"), { plus: plusOf("store", until, "trial") }),
  ];
  await User.insertMany([anna, ben, carl, dora, emma]);
  await SubscriptionEvent.create([
    storeEvent(anna._id, "INITIAL_PURCHASE", at1),
    storeEvent(ben._id, "INITIAL_PURCHASE", at1, { productId: "wannayap_plus_yearly", priceCents: 3299, priceInPurchasedCurrencyCents: 2999 }),
    // A tester's purchase: Plus for them, never revenue
    storeEvent(carl._id, "INITIAL_PURCHASE", at1, { environment: "SANDBOX" }),
    // A free trial starts: no revenue yet
    storeEvent(emma._id, "INITIAL_PURCHASE", at1, { periodType: "TRIAL", priceCents: 0, priceInPurchasedCurrencyCents: 0 }),
  ]);

  const d1 = await computeDay(day1, now);
  assert.equal(d1.version, METRICS_VERSION);
  assert.equal(d1.partial, false);
  assert.deepEqual(d1.plus, {
    activeStore: 3,
    activeGift: 1,
    activeSandbox: 1,
    newPaid: 2,
    renewed: 0,
    cancelled: 0,
    billingIssue: 0,
    expired: 0,
    refunds: 0,
    trialsStarted: 1,
    trialsConverted: 0,
    mrrCents: 499 + Math.round(2999 / 12),
    giftDaysGranted: { referral: 0, waitlist: 0, admin: 0 },
    giftToStore: 0,
  });

  // The next day: Ben's yearly plan expires (the webhook ended his Plus), Emma's
  // trial renews into a paid month, Anna asks Apple for a refund
  await SubscriptionEvent.create([
    storeEvent(ben._id, "EXPIRATION", at2, { productId: "wannayap_plus_yearly", priceCents: null, priceInPurchasedCurrencyCents: null }),
    storeEvent(emma._id, "RENEWAL", at2),
    storeEvent(anna._id, "CANCELLATION", at2, { cancelReason: "CUSTOMER_SUPPORT" }),
  ]);
  await User.updateOne({ _id: ben._id }, { "plus.active": false, "plus.status": "expired" });
  const d2 = await computeDay(day2, now);
  assert.equal(d2.plus.activeStore, 2);
  assert.equal(d2.plus.expired, 1);
  assert.equal(d2.plus.renewed, 1);
  assert.equal(d2.plus.trialsConverted, 1);
  assert.equal(d2.plus.cancelled, 1);
  assert.equal(d2.plus.refunds, 1);
  assert.equal(d2.plus.newPaid, 0);
  // Anna's month and Emma's first paid month; Ben is gone
  assert.equal(d2.plus.mrrCents, 499 + 499);

  // A later renewal without a trial before it is no conversion
  await SubscriptionEvent.create(storeEvent(anna._id, "RENEWAL", new Date("2026-09-30T08:00:00Z")));
  const d3 = await computeDay("2026-09-30", now);
  assert.equal(d3.partial, true);
  assert.deepEqual([d3.plus.renewed, d3.plus.trialsConverted], [1, 0]);
});

test("version: runSnapshots recomputes finished days of the last 30 days with an older version, five per run, and leaves older ones alone", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const today = todayKey(now);
  // Every day of the backfill window is already final, so the run only recomputes
  const docs = [];
  for (let day = shiftDateKey(today, -60); day < today; day = shiftDateKey(day, 1)) {
    docs.push({ day, partial: false, version: METRICS_VERSION, users: { total: 1 } });
  }
  const outdated = [shiftDateKey(today, -1), shiftDateKey(today, -3), shiftDateKey(today, -(RECOMPUTE_DAYS - 1))];
  const tooOld = shiftDateKey(today, -(RECOMPUTE_DAYS + 5));
  for (const d of docs) {
    if (outdated.includes(d.day)) d.version = METRICS_VERSION - 1;
    if (d.day === tooOld) d.version = null;
  }
  await MetricsDaily.insertMany(docs);

  assert.equal(await runSnapshots(now), 1 + outdated.length);
  for (const day of outdated) {
    const doc = await MetricsDaily.findOne({ day }).lean();
    assert.equal(doc.version, METRICS_VERSION, day);
    assert.equal(doc.plus.activeStore, 0, "the new block is filled in");
  }
  assert.equal((await MetricsDaily.findOne({ day: tooOld }).lean()).version, null, "beyond the raw data's life nothing is touched");
  assert.equal((await MetricsDaily.findOne({ day: today }).lean()).partial, true);
  // Nothing left to do: only today is refreshed
  assert.equal(await runSnapshots(now), 1);
});

test("version: a recomputed day keeps the columns whose raw rows have expired and counts the rest again", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const today = todayKey(now);
  assert.deepEqual(RAW_TTL_DAYS, { push: 3, "rituals.nudges": 7, calls: 30, "circles.rooms": 30, "circles.ritualRooms": 30, "costs.agoraAudioMinutes": 30, "costs.agoraVideoMinutes": 30 });
  const stored = (day, version) => ({
    day,
    partial: false,
    version,
    users: { total: 1 },
    push: { sent: 12, skipped: 4, failed: 1 },
    rituals: { dailyJoined: 2, moments: 1, nudges: 3 },
    calls: { started: 7, answered: 5, missed: 2, declined: 0, busy: 0, cancelled: 0, audio: 7 },
    circles: { total: 1, new: 0, rooms: 2, ritualRooms: 1, roomMinutes: 9 },
  });
  const docs = [];
  for (let day = shiftDateKey(today, -60); day < today; day = shiftDateKey(day, 1)) docs.push(stored(day, METRICS_VERSION));
  // Yesterday: every raw row is still there, everything is counted again
  const fresh = shiftDateKey(today, -1);
  // Ten days ago: push decisions (3 days) and nudges (7) are gone, calls (30) are not
  const middle = shiftDateKey(today, -10);
  // 29 days ago: the first calls of that day expire tonight, they stay too
  const edge = shiftDateKey(today, -29);
  for (const d of docs) if ([fresh, middle, edge].includes(d.day)) d.version = METRICS_VERSION - 1;
  await MetricsDaily.insertMany(docs);

  assert.equal(await runSnapshots(now), 4);
  const pick = async (day) => {
    const d = await MetricsDaily.findOne({ day }).lean();
    assert.equal(d.version, METRICS_VERSION, day);
    assert.equal(d.plus.activeStore, 0, "the new block is filled in");
    return [d.push.sent, d.rituals.nudges, d.calls.started, d.circles.rooms, d.circles.roomMinutes, d.rituals.moments];
  };
  assert.deepEqual(await pick(fresh), [0, 0, 0, 0, 0, 0], "no raw rows in the test database: the honest count is zero");
  assert.deepEqual(await pick(middle), [12, 3, 0, 0, 0, 0], "pushes and nudges kept, calls and rooms recounted");
  assert.deepEqual(await pick(edge), [12, 3, 7, 2, 0, 0], "calls and rooms kept at the edge; talks and moments live long enough to recount");

  // A stored day whose block is missing altogether (an older schema) takes the fresh count
  await MetricsDaily.updateOne({ day: middle }, { $unset: { push: 1 }, $set: { version: METRICS_VERSION - 1 } });
  await runSnapshots(now);
  assert.deepEqual((await MetricsDaily.findOne({ day: middle }).lean()).push, { sent: 0, skipped: 0, failed: 0 });
});

test("GET /admin/metrics/funnel: viewers get the steps and the weeks, clamped to 2..16; no session, no numbers", async () => {
  const viewer = await Admin.create({ email: "viewer@example.com", passwordHash: hashPassword("a-long-admin-password"), totpSecret: newTotpSecret(), totpEnabled: true, role: "viewer" });
  const cookie = `${COOKIE}=${encodeURIComponent(signSession(viewer))}`;
  // Two sign-ups right after this week's Monday midnight (Europe/Berlin), whatever today is
  const thisWeek = weekKey(new Date(), "Europe/Berlin");
  const t = new Date(dayRange(thisWeek)[0].getTime() + 1000);
  await User.insertMany([signup(t, { milestones: { verifiedAt: t, contactsSyncedAt: t } }), signup(t, { milestones: { verifiedAt: t } })]);

  await request(ctx.app).get("/admin/metrics/funnel").expect(401);
  const res = await request(ctx.app).get("/admin/metrics/funnel").set("Cookie", cookie).expect(200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.steps, FUNNEL_STEPS.map(([name]) => name));
  assert.equal(res.body.weeks.length, 8);
  const current = res.body.weeks.at(-1);
  assert.equal(current.week, thisWeek);
  assert.equal(current.size, 2);
  assert.deepEqual([current.steps.verified, current.steps.contactsSynced, current.steps.firstTalk], [100, 50, 0]);
  assert.equal((await request(ctx.app).get("/admin/metrics/funnel?weeks=99").set("Cookie", cookie).expect(200)).body.weeks.length, 16);
  assert.equal((await request(ctx.app).get("/admin/metrics/funnel?weeks=1").set("Cookie", cookie).expect(200)).body.weeks.length, 2);
  assert.equal((await request(ctx.app).get("/admin/metrics/funnel?weeks=abc").set("Cookie", cookie).expect(200)).body.weeks.length, 8);
});

test("retention: paid30 is the share that bought within 30 days of signing up, judged only once the cohort's 30 days are over", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  // Week of 2026-08-10: 30 days are long over
  const paid = signup(new Date("2026-08-11T09:00:00Z"));
  const late = signup(new Date("2026-08-12T09:00:00Z"));
  const free = signup(new Date("2026-08-13T09:00:00Z"));
  const sandbox = signup(new Date("2026-08-13T10:00:00Z"));
  // Last week: the window is still open
  const fresh = signup(new Date("2026-09-22T09:00:00Z"));
  await User.insertMany([paid, late, free, sandbox, fresh]);
  await SubscriptionEvent.create([
    storeEvent(paid._id, "INITIAL_PURCHASE", new Date("2026-08-20T09:00:00Z")),
    // Day 31: not within the window
    storeEvent(late._id, "INITIAL_PURCHASE", new Date("2026-09-12T10:00:00Z")),
    storeEvent(sandbox._id, "INITIAL_PURCHASE", new Date("2026-08-14T09:00:00Z"), { environment: "SANDBOX" }),
    storeEvent(fresh._id, "INITIAL_PURCHASE", new Date("2026-09-23T09:00:00Z")),
  ]);
  const cohorts = await retention(8, now);
  const august = cohorts.find((c) => c.week === "2026-08-10");
  assert.equal(august.size, 4);
  assert.equal(august.paid30, 0.25);
  const lastWeek = cohorts.find((c) => c.week === "2026-09-21");
  assert.equal(lastWeek.size, 1);
  assert.equal(lastWeek.paid30, null);
  assert.equal(cohorts.find((c) => c.week === "2026-09-07").paid30, null, "an empty cohort has nothing to judge");
});

test("funnel: onboarding steps per sign-up week as shares of the cohort", async () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const t = new Date("2026-09-22T09:00:00Z");
  await User.insertMany([
    signup(t, { milestones: { verifiedAt: t, contactsSyncedAt: t, firstRegisteredContactAt: t, pushGrantedAt: t, firstCallAt: t, firstTalkAt: t }, firstInviteAt: t }),
    signup(t, { milestones: { verifiedAt: t, contactsSyncedAt: t, pushGrantedAt: t } }),
    signup(t, { milestones: { verifiedAt: t, contactsSyncedAt: t } }),
    signup(t, { milestones: { verifiedAt: t } }),
    // This week, alone
    signup(new Date("2026-09-29T09:00:00Z"), { milestones: { verifiedAt: t, contactsSyncedAt: t, firstRegisteredContactAt: t } }),
  ]);
  const weeks = await funnel(3, now);
  assert.deepEqual(weeks.map((w) => [w.week, w.size]), [["2026-09-14", 0], ["2026-09-21", 4], ["2026-09-28", 1]]);
  assert.deepEqual(weeks[0].steps, { verified: null, contactsSynced: null, firstRegisteredContact: null, pushGranted: null, firstInvite: null, firstCall: null, firstTalk: null });
  assert.deepEqual(weeks[1].steps, { verified: 100, contactsSynced: 75, firstRegisteredContact: 25, pushGranted: 50, firstInvite: 25, firstCall: 25, firstTalk: 25 });
  assert.deepEqual(weeks[2].steps, { verified: 100, contactsSynced: 100, firstRegisteredContact: 100, pushGranted: 0, firstInvite: 0, firstCall: 0, firstTalk: 0 });
});

test("DST: the day the clocks go forward has 23 hours, the day they go back 25, and events land in the right day", async () => {
  const [from, to] = dayRange("2026-03-29");
  assert.equal(from.toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(to.toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal((to - from) / 3600000, 23);
  const [f2, t2] = dayRange("2026-10-25");
  assert.equal(f2.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(t2.toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal((t2 - f2) / 3600000, 25);

  const user = signup(new Date("2026-03-01T09:00:00Z"), { plus: plusOf("store", new Date("2026-04-29T00:00:00Z")) });
  await User.create(user);
  await SubscriptionEvent.create([
    // 23:30 Berlin on the 29th (summer time already)
    storeEvent(user._id, "INITIAL_PURCHASE", new Date("2026-03-29T21:30:00Z")),
    // 00:30 Berlin on the 30th
    storeEvent(user._id, "RENEWAL", new Date("2026-03-29T22:30:00Z")),
  ]);
  const now = new Date("2026-04-01T10:00:00Z");
  assert.deepEqual([(await computeDay("2026-03-29", now)).plus.newPaid, (await computeDay("2026-03-29", now)).plus.renewed], [1, 0]);
  assert.deepEqual([(await computeDay("2026-03-30", now)).plus.newPaid, (await computeDay("2026-03-30", now)).plus.renewed], [0, 1]);
});

test("morning push: the Plus line appears only on days with subscription events or MRR", async () => {
  const now = new Date("2026-09-30T06:30:00Z");
  assert.doesNotMatch(await adminPush.daySummary(now), /Plus:/);

  const user = signup(new Date("2026-09-10T09:00:00Z"), { plus: plusOf("store", new Date("2026-10-29T12:00:00Z")) });
  await User.create(user);
  await SubscriptionEvent.create(storeEvent(user._id, "INITIAL_PURCHASE", new Date("2026-09-29T12:00:00Z")));
  // Yesterday's snapshot is counted again when it was still partial
  await saveDay("2026-09-29", new Date("2026-09-29T20:00:00Z"));
  const body = await adminPush.daySummary(now);
  assert.match(body, /· Plus: \+1 neu · 0 gekündigt · MRR 5 € · /);
  // Order: before the SMS line, which stays last
  assert.match(body, /· SMS \d+\/\d+$/);
});
