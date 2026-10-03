// Unit economics (plan 2.5): the cost columns of the day's snapshot
// (lib/metrics.js computeDay, priceCosts), the prices and fixed costs in the
// app config (lib/appConfig.js saveConfig), the console numbers
// (lib/economics.js summary, GET /admin/economics), the day counters
// cloudinaryUploads and voipSent, the plan limit momentsPerDay on
// /upload/moment and /moment/callmoment, the per-person upload brake and the
// plan limit video in lib/calls.js startCall.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes, befriend } = require("./helpers");
// After the helpers: node-apn is their fake
const apn = require("node-apn");
const cloudinary = require("cloudinary").v2;
const Admin = require("../models/Admin");
const User = require("../models/User");
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const CallMoment = require("../models/CallMoment");
const ActiveDay = require("../models/ActiveDay");
const OpsTally = require("../models/OpsTally");
const MetricsDaily = require("../models/MetricsDaily");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const AppConfig = require("../models/AppConfig");
const { computeDay, saveDay, todayKey, priceCosts, RAW_TTL_DAYS } = require("../lib/metrics");
const { saveConfig, getConfig, DEFAULT_PRICES } = require("../lib/appConfig");
const { resetLimitsCache, DEFAULT_LIMITS } = require("../lib/plan");
const { summary } = require("../lib/economics");
const { voipProviders } = require("../lib/push");
const opsCounters = require("../lib/opsCounters");
const { signSession, hashPassword, newTotpSecret, COOKIE } = require("../lib/adminAuth");
const { shiftDateKey } = require("../lib/localTime");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  resetLimitsCache();
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const DAY = 24 * 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, pushToken: `ExponentPushToken[${name}]` });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const adminCookie = async (role) => {
  const admin = await Admin.create({ email: `${role}@example.com`, passwordHash: hashPassword("a-long-admin-password"), totpSecret: newTotpSecret(), totpEnabled: true, role });
  return `${COOKIE}=${encodeURIComponent(signSession(admin))}`;
};
// Round prices, so the expected cents can be read off
const PRICES = { smsEurCents: 8, agoraAudioUsdCentsPer1000Min: 100, agoraVideoUsdCentsPer1000Min: 400, agoraFreeMinutesPerMonth: 0, cloudinaryEurCentsPerUpload: 1, pushEurCentsPer1000: 10, eurPerUsd: 1 };

test("computeDay: Agora minutes by mode from Talk and Call, counters, and their price at AppConfig.prices", async () => {
  const day = "2026-09-15";
  const at = new Date("2026-09-15T12:00:00Z");
  const now = new Date("2026-09-30T10:00:00Z");
  assert.equal((await saveConfig({ prices: PRICES }, "test")).error, undefined);
  await Call.create([
    { callId: "audio", channel: "c_audio", caller: ANNA, callee: BEN, status: "ended", video: false, createdAt: at, acceptedAt: at, endedAt: at },
    { callId: "video", channel: "c_video", caller: BEN, callee: ANNA, status: "ended", video: true, createdAt: at, acceptedAt: at, endedAt: at },
  ]);
  await Talk.create([
    // 10 minutes, two participants: 20 audio minutes
    { callId: "audio", participants: [ANNA, BEN], startedAt: at, seconds: 600 },
    // 15 minutes, two participants: 30 video minutes
    { callId: "video", participants: [BEN, ANNA], startedAt: at, seconds: 900 },
    // A round: one record per participant, each counted once, video
    { callId: "room1:a", participants: [ANNA, BEN], startedAt: at, seconds: 300, group: true, owner: ANNA },
    { callId: "room1:b", participants: [BEN, ANNA], startedAt: at, seconds: 300, group: true, owner: BEN },
    // Its Call has expired: counted in the mode calls start in, video
    { callId: "gone", participants: [ANNA, BEN], startedAt: at, seconds: 60 },
    // Another day
    { callId: "other", participants: [ANNA, BEN], startedAt: new Date("2026-09-16T12:00:00Z"), seconds: 6000 },
  ]);
  await OpsTally.create({ _id: `ops:${day}`, counts: { smsStarted: 3, smsChecked: 2, cloudinaryUploads: 5, voipSent: 4 } });
  await ActiveDay.insertMany(["a", "b", "c", "d"].map((who) => ({ day, who })));

  const doc = await computeDay(day, now);
  // 3 SMS × 8 + (42 video × 400 + 20 audio × 100) / 1000 + 5 uploads × 1 + 4 VoIP × 10 / 1000
  assert.deepEqual(doc.costs, {
    smsStarted: 3,
    smsChecked: 2,
    agoraAudioMinutes: 20,
    agoraVideoMinutes: 42,
    cloudinaryUploads: 5,
    pushSent: 0,
    voipSent: 4,
    variableEurCents: 47.84,
    perMauEurCents: 11.96,
  });

  // Free minutes: a September day gets 1/30 of the month's pool, video first
  await saveConfig({ prices: { agoraFreeMinutesPerMonth: 45 * 30 } }, "test");
  const free = await computeDay(day, now);
  // 42 video minutes are free, the 3 left offset audio: 17 × 100 / 1000 = 1.7
  assert.equal(free.costs.variableEurCents, 24 + 1.7 + 5 + 0.04);

  // Stored with the snapshot; without MAU no per-MAU value
  await ActiveDay.deleteMany({});
  await saveDay(day, now);
  const stored = await MetricsDaily.findOne({ day }).lean();
  assert.equal(stored.costs.agoraVideoMinutes, 42);
  assert.equal(stored.costs.perMauEurCents, null);
});

test("priceCosts: defaults are the assumed list prices, pushes come from push.sent, expired Agora columns are kept", async () => {
  assert.deepEqual(DEFAULT_PRICES, {
    smsEurCents: 8,
    agoraAudioUsdCentsPer1000Min: 99,
    agoraVideoUsdCentsPer1000Min: 399,
    agoraFreeMinutesPerMonth: 10000,
    cloudinaryEurCentsPerUpload: 0,
    pushEurCentsPer1000: 0,
    appleCommissionPct: 15,
    eurPerUsd: 0.92,
    plusMonthlyEurCents: null,
    plusYearlyEurCents: null,
  });
  const doc = { day: "2026-02-10", users: { mau: 0 }, push: { sent: 2000 }, costs: { smsStarted: 0, smsChecked: 0, agoraAudioMinutes: 1000, agoraVideoMinutes: 0, cloudinaryUploads: 0, pushSent: 0, voipSent: 0 } };
  // February 2026 has 28 days: 1000 free minutes a month are 35.71 a day
  priceCosts(doc, { ...DEFAULT_PRICES, agoraFreeMinutesPerMonth: 1000, pushEurCentsPer1000: 5 });
  assert.equal(doc.costs.pushSent, 2000);
  assert.equal(doc.costs.variableEurCents, Math.round((((1000 - 1000 / 28) * 99) / 1000 * 0.92 + 10) * 100) / 100);
  assert.equal(doc.costs.perMauEurCents, null);

  assert.equal(RAW_TTL_DAYS["costs.agoraVideoMinutes"], 30);
  const now = new Date("2026-09-30T10:00:00Z");
  const old = shiftDateKey(todayKey(now), -10);
  await saveConfig({ prices: PRICES }, "test");
  await MetricsDaily.create({ day: old, partial: false, version: 1, users: { total: 1 }, push: { sent: 1000 }, costs: { agoraAudioMinutes: 0, agoraVideoMinutes: 500 } });
  // Ten days ago the push decisions are gone, the calls are not: the stored
  // push.sent is kept and priced, the minutes are counted again (zero here)
  const saved = await saveDay(old, now);
  assert.equal(saved.costs.agoraVideoMinutes, 0);
  assert.equal(saved.costs.pushSent, 1000);
  assert.equal(saved.costs.variableEurCents, 10);
  // 29 days ago the Agora minutes are kept from the stored day, and priced again
  const edge = shiftDateKey(todayKey(now), -29);
  await MetricsDaily.create({ day: edge, partial: false, version: 1, users: { total: 1 }, push: { sent: 0 }, costs: { agoraAudioMinutes: 0, agoraVideoMinutes: 500 } });
  const kept = await saveDay(edge, now);
  assert.equal(kept.costs.agoraVideoMinutes, 500);
  assert.equal(kept.costs.variableEurCents, 200);
});

test("saveConfig: prices and fixed costs are validated on their own, the bank balance is stamped", async () => {
  const bad = [
    { prices: { smsEurCents: -1 } },
    { prices: { smsEurCents: "8" } },
    { prices: { unknown: 1 } },
    { prices: { appleCommissionPct: 101 } },
    { prices: { agoraFreeMinutesPerMonth: 10.5 } },
    { prices: { eurPerUsd: 0 } },
    { prices: [] },
  ];
  for (const input of bad) assert.equal((await saveConfig(input, "test")).error, "invalid_prices", JSON.stringify(input));
  const badFixed = [
    { fixedCosts: {} },
    { fixedCosts: [{ service: "", monthlyEurCents: 100 }] },
    { fixedCosts: [{ service: "x".repeat(61), monthlyEurCents: 100 }] },
    { fixedCosts: [{ service: "Render", monthlyEurCents: 12.5 }] },
    { fixedCosts: [{ service: "Render", monthlyEurCents: 10_000_001 }] },
    { fixedCosts: [{ service: "Render", monthlyEurCents: 100, until: "not a date" }] },
    { fixedCosts: Array.from({ length: 51 }, (_, i) => ({ service: `S${i}`, monthlyEurCents: 1 })) },
  ];
  for (const input of badFixed) assert.equal((await saveConfig(input, "test")).error, "invalid_fixed_costs", JSON.stringify(input).slice(0, 80));
  assert.equal((await saveConfig({ ops: { bankBalanceEurCents: 1.5 } }, "test")).error, "invalid_ops");

  assert.equal((await saveConfig({ prices: { smsEurCents: 7.5, plusYearlyEurCents: 2999 }, fixedCosts: [{ service: " Render ", monthlyEurCents: 2500, note: "Starter" }, { service: "Credits", monthlyEurCents: -1000, until: "2026-12-31" }], ops: { bankBalanceEurCents: 150000 } }, "test")).error, undefined);
  const c = await getConfig();
  assert.equal(c.prices.smsEurCents, 7.5);
  assert.equal(c.prices.plusYearlyEurCents, 2999);
  assert.equal(c.prices.agoraVideoUsdCentsPer1000Min, 399, "untouched keys keep their default");
  assert.deepEqual(c.fixedCosts.map((f) => [f.service, f.monthlyEurCents, f.note, f.until && f.until.toISOString().slice(0, 10)]), [["Render", 2500, "Starter", null], ["Credits", -1000, "", "2026-12-31"]]);
  assert.equal(c.ops.bankBalanceEurCents, 150000);
  const stamped = c.ops.bankBalanceAt;
  assert.ok(stamped instanceof Date);
  // The same balance again keeps the stamp; null clears both
  await saveConfig({ ops: { bankBalanceEurCents: 150000 } }, "test");
  assert.equal(+(await getConfig()).ops.bankBalanceAt, +stamped);
  await saveConfig({ ops: { bankBalanceEurCents: null }, prices: { plusYearlyEurCents: null } }, "test");
  assert.equal((await getConfig()).ops.bankBalanceAt, null);
  assert.equal((await getConfig()).prices.plusYearlyEurCents, null);
  // Only the overrides are stored, so a corrected default still applies to
  // every untouched key; null puts a price back to its default
  assert.deepEqual((await AppConfig.findOne({ key: "app" }).lean()).prices, { smsEurCents: 7.5 });
  await saveConfig({ prices: { smsEurCents: null, eurPerUsd: 0.9 } }, "test");
  assert.deepEqual((await AppConfig.findOne({ key: "app" }).lean()).prices, { eurPerUsd: 0.9 });
  assert.equal((await getConfig()).prices.smsEurCents, DEFAULT_PRICES.smsEurCents);
  // Never sent to the app
  const pub = await request(ctx.app).get("/app-config").expect(200);
  assert.equal(JSON.stringify(pub.body).includes("smsEurCents"), false);
});

test("economics.summary: month from the last 30 days, fixed costs with credits, break-even and runway; GET /admin/economics for viewers", async () => {
  // Relative to the real day: the route counts as of now
  const now = new Date();
  const today = todayKey(now);
  const dateIn = (days) => shiftDateKey(today, days);
  // Ten counted days, 1 € each: scaled to 30 days
  await MetricsDaily.insertMany(
    Array.from({ length: 10 }, (_, i) => ({
      day: shiftDateKey(today, -(i + 1)),
      partial: false,
      version: 3,
      talks: { minutes: 40 },
      circles: { roomMinutes: 10 },
      costs: { agoraAudioMinutes: 5, agoraVideoMinutes: 20, variableEurCents: 100 },
    })),
  );
  // A day before the cost columns: not counted, not scaled in
  await MetricsDaily.create({ day: shiftDateKey(today, -12), partial: false, version: 2, talks: { minutes: 999 } });
  // Ten active people today, two store plans at 4,99 €
  await ActiveDay.insertMany(Array.from({ length: 10 }, (_, i) => ({ day: today, who: `who${i}` })));
  const users = await User.insertMany([
    { phone: ANNA, plus: { active: true, until: new Date(now.getTime() + 20 * DAY), source: "store" } },
    { phone: BEN, plus: { active: true, until: new Date(now.getTime() + 20 * DAY), source: "store" } },
  ]);
  let n = 0;
  await SubscriptionEvent.insertMany(
    users.map((u) => ({ rcEventId: `e${++n}`, userId: u._id, appUserId: String(u._id), type: "INITIAL_PURCHASE", productId: "wannayap_plus_monthly", store: "APP_STORE", environment: "PRODUCTION", periodType: "NORMAL", priceCents: 549, currency: "EUR", priceInPurchasedCurrencyCents: 499, eventAt: new Date(now.getTime() - 5 * DAY) })),
  );
  await saveConfig(
    {
      fixedCosts: [
        { service: "Render", monthlyEurCents: 2500 },
        { service: "Sentry", monthlyEurCents: 2600, until: dateIn(90) },
        { service: "Startup-Credits", monthlyEurCents: -1000, until: dateIn(30) },
        // Ran out before today: no longer counted
        { service: "Alte Credits", monthlyEurCents: -5000, until: dateIn(-1) },
        // Ends today: still counted
        { service: "Domain", monthlyEurCents: 200, until: today },
      ],
      ops: { bankBalanceEurCents: 100000 },
    },
    "test",
  );

  const s = await summary(now);
  assert.equal(s.days, 10);
  assert.deepEqual(s.month, {
    variableEurCents: 3000,
    variablePerDayEurCents: 100,
    fixedEurCents: 2500 + 2600 - 1000 + 200,
    mrrCents: 998,
    netRevenueCents: 848,
    contributionCents: 848 - 3000,
    perMau: 300,
    contributionPerMau: (848 - 3000) / 10,
    minutesPerMau: { audio: 15, video: 60 },
    perTalkMinute: 2,
    perPlusSub: 124.15,
    mau: 10,
    activeStore: 2,
    agoraMinutes: { audio: 150, video: 600 },
    talkMinutes: 1500,
  });
  assert.deepEqual(s.fixedCosts.map((f) => f.service), ["Render", "Sentry", "Startup-Credits", "Domain"]);
  // (fixed 4,300 + variable of the free users 3,000 - 2 × 300) / (499 × 0.85 - 300)
  assert.deepEqual(s.planPriceMonthlyCents, { yearly: null, monthly: 499 });
  assert.equal(s.breakEvenMonthlySubs, Math.ceil((4300 + 2400) / (499 * 0.85 - 300)));
  assert.equal(s.breakEvenYearlySubs, null, "no yearly purchase and no list price");
  assert.equal(s.burnEurCents, 4300 + 3000 - 848);
  assert.equal(s.runwayMonths, Math.round((100000 / 6452) * 10) / 10);

  // A yearly list price before the first yearly purchase; too cheap to cover its costs: no break-even
  await saveConfig({ prices: { plusYearlyEurCents: 2999 } }, "test");
  assert.equal((await summary(now)).breakEvenYearlySubs, null);
  await saveConfig({ prices: { plusYearlyEurCents: 4800 } }, "test");
  assert.equal((await summary(now)).breakEvenYearlySubs, Math.ceil(6700 / (400 * 0.85 - 300)));
  // Without a bank balance no runway
  await saveConfig({ ops: { bankBalanceEurCents: null } }, "test");
  assert.equal((await summary(now)).runwayMonths, null);

  const viewer = await adminCookie("viewer");
  await request(ctx.app).get("/admin/economics").expect(401);
  const res = await request(ctx.app).get("/admin/economics").set("Cookie", viewer).expect(200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.month.fixedEurCents, 4300);
  assert.equal(res.body.prices.appleCommissionPct, 15);
  assert.equal(res.body.bankBalanceEurCents, null);
  // The bank balance stays with the owners; the runway is for everyone
  await saveConfig({ ops: { bankBalanceEurCents: 100000 } }, "test");
  const seen = await request(ctx.app).get("/admin/economics").set("Cookie", viewer).expect(200);
  assert.equal(seen.body.bankBalanceEurCents, "•••");
  assert.equal(seen.body.runwayMonths, s.runwayMonths);
  assert.equal((await request(ctx.app).get("/admin/config").set("Cookie", viewer).expect(200)).body.config.ops.bankBalanceEurCents, "•••");
  const owner = await adminCookie("owner");
  assert.equal((await request(ctx.app).get("/admin/economics").set("Cookie", owner).expect(200)).body.bankBalanceEurCents, 100000);
  assert.equal((await request(ctx.app).get("/admin/config").set("Cookie", owner).expect(200)).body.config.ops.bankBalanceEurCents, 100000);
});

test("summary: an empty database has no costs yet, nothing divides by zero", async () => {
  const s = await summary(new Date());
  assert.equal(s.days, 0);
  assert.equal(s.month.variableEurCents, null);
  assert.equal(s.month.perMau, null);
  assert.equal(s.month.perTalkMinute, null);
  assert.equal(s.month.perPlusSub, null);
  assert.equal(s.month.contributionCents, null);
  assert.equal(s.breakEvenMonthlySubs, null);
  assert.equal(s.runwayMonths, null);
});

test("momentsPerDay: the 31st moment of a free day is refused before Cloudinary; uploads are counted", async () => {
  const anna = await login(ANNA, "Anna");
  const original = cloudinary.uploader.upload_stream;
  const uploaded = [];
  cloudinary.uploader.upload_stream = (opts, cb) => ({
    end: () => {
      uploaded.push(opts.public_id);
      cb(null, { secure_url: `https://res.cloudinary.com/testcloud/image/upload/${opts.folder}/${opts.public_id}.jpg` });
    },
  });
  const upload = () => request(ctx.app).post("/upload/moment").set(auth(anna)).attach("image", Buffer.from("jpeg"), { filename: "m.jpg", contentType: "image/jpeg" });
  const moment = (timestamp) => ({ userPhone: ANNA, userName: "Anna", targetPhone: BEN, targetName: "Ben", screenshot: "https://res.cloudinary.com/testcloud/image/upload/x.jpg", mood: "😊", callDuration: "01:00", timestamp });
  try {
    // 29 moments today and one from yesterday: one more is fine
    await CallMoment.insertMany([...Array.from({ length: 29 }, () => moment(new Date())), moment(new Date(Date.now() - 2 * DAY))]);
    const ok = await upload().expect(200);
    assert.match(ok.body.url, /^https:\/\/res\.cloudinary\.com\/testcloud\//);
    await CallMoment.create(moment(new Date()));
    const refused = await upload().expect(403);
    assert.deepEqual(refused.body, { success: false, error: "plan_limit", limit: "momentsPerDay", value: 30, plus: 100 });
    assert.equal(uploaded.length, 1, "the refused picture never reached Cloudinary");

    // The app's fallback, an inline picture, is refused the same way
    await Call.create({ callId: "m1", channel: "c_m1", caller: ANNA, callee: BEN, status: "ended", createdAt: new Date(), acceptedAt: new Date(), endedAt: new Date() });
    const inline = { targetPhone: BEN, screenshot: "data:image/jpeg;base64,/9j/AAAA", mood: "😊", callDuration: "01:00" };
    const posted = await request(ctx.app).post("/moment/callmoment").set(auth(anna)).send(inline).expect(403);
    assert.equal(posted.body.limit, "momentsPerDay");
    assert.equal(await CallMoment.countDocuments({ userPhone: ANNA }), 31);

    // Plus lifts it to 100
    await User.updateOne({ phone: ANNA }, { plus: { active: true, until: new Date(Date.now() + DAY), source: "admin" } });
    await upload().expect(200);
    await request(ctx.app).post("/moment/callmoment").set(auth(anna)).send(inline).expect(200);
    // The avatar counts as an upload too
    await request(ctx.app).post("/upload/avatar").set(auth(anna)).attach("avatar", Buffer.from("jpeg"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await opsCounters.countsOf(todayKey())).cloudinaryUploads, 3);
  } finally {
    cloudinary.uploader.upload_stream = original;
  }
  assert.deepEqual([DEFAULT_LIMITS.free.momentsPerDay, DEFAULT_LIMITS.plus.momentsPerDay], [30, 100]);
  assert.equal((await saveConfig({ limits: { plus: { momentsPerDay: 201 } } }, "test")).error, "invalid_limits");
});

test("upload brake: more than 200 moment uploads a day per person are refused, others are not affected", async () => {
  // Carla: the brake lives in memory for the app's lifetime, other tests upload as Anna
  const carla = await login("+4915333333333", "Carla");
  const ben = await login(BEN, "Ben");
  const original = cloudinary.uploader.upload_stream;
  let uploaded = 0;
  cloudinary.uploader.upload_stream = (opts, cb) => ({ end: () => (uploaded++, cb(null, { secure_url: `https://res.cloudinary.com/testcloud/image/upload/m${uploaded}.jpg` })) });
  const upload = (token) => request(ctx.app).post("/upload/moment").set(auth(token)).attach("image", Buffer.from("jpeg"), { filename: "m.jpg", contentType: "image/jpeg" });
  try {
    // Uploads that never become a moment: momentsPerDay never sees them
    for (let i = 0; i < 200; i++) await upload(carla).expect(200);
    const braked = await upload(carla).expect(429);
    assert.equal(braked.body.error, "upload_limit");
    assert.equal(uploaded, 200);
    await upload(ben).expect(200);
  } finally {
    cloudinary.uploader.upload_stream = original;
  }
});

test("video limit: the default keeps video; false or a used-up monthly allowance starts the call as audio", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  const start = async (channel) => {
    const result = await ctx.calls.startCall({ from: ANNA, to: BEN, channel });
    assert.equal(result.ok, true, channel);
    await ctx.calls.endCall({ me: ANNA, other: BEN, channel });
    return [result.videoDowngraded ?? null, (await Call.findOne({ channel })).video];
  };
  assert.deepEqual([DEFAULT_LIMITS.free.video, DEFAULT_LIMITS.plus.video], [true, true]);
  assert.deepEqual(await start("call_default"), [null, true], "nothing changes with the defaults");

  // Video off for free: the call starts as audio, the push says so
  assert.equal((await saveConfig({ limits: { free: { video: false } } }, "test")).error, undefined);
  fakes.expoPushes.length = 0;
  assert.deepEqual(await start("call_off"), ["plan_limit", false]);
  const ring = fakes.expoPushes.find((p) => p.data?.channel === "call_off" && "hasVideo" in p.data);
  assert.equal(ring.data.hasVideo, false);
  // An audio call is never "downgraded"
  const audio = await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_audio", video: false });
  assert.equal(audio.videoDowngraded, undefined);
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_audio" });
  // Plus keeps video
  await User.updateOne({ phone: ANNA }, { plus: { active: true, until: new Date(Date.now() + DAY), source: "admin" } });
  assert.deepEqual(await start("call_plus"), [null, true]);
  await User.updateOne({ phone: ANNA }, { $unset: { plus: 1 } });

  // Ten video minutes a month: 599 seconds used so far, then 600
  await saveConfig({ limits: { free: { video: 10 } } }, "test");
  await Talk.deleteMany({});
  await Call.deleteMany({});
  const now = new Date();
  await Call.create({ callId: "v1", channel: "c_v1", caller: ANNA, callee: BEN, status: "ended", video: true, createdAt: now, acceptedAt: now, endedAt: now });
  await Talk.create({ callId: "v1", participants: [ANNA, BEN], startedAt: now, seconds: 599 });
  // Ben's video call to Anna is not Anna's allowance, nor is an audio call
  await Call.create({ callId: "v2", channel: "c_v2", caller: BEN, callee: ANNA, status: "ended", video: true, createdAt: now, acceptedAt: now, endedAt: now });
  await Talk.create({ callId: "v2", participants: [BEN, ANNA], startedAt: now, seconds: 3000 });
  assert.deepEqual(await start("call_quota_left"), [null, true]);
  await Talk.updateOne({ callId: "v1" }, { seconds: 600 });
  assert.deepEqual(await start("call_quota_used"), ["plan_limit", false]);

  // The caller's app hears it by socket
  const socket = await new Promise((resolve, reject) => {
    const s = connect(ctx.url, { transports: ["websocket"], auth: { token: anna }, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
  try {
    const heard = new Promise((resolve) => socket.once("callVideoDowngraded", resolve));
    socket.emit("callRequest", { to: BEN, channel: "call_socket", video: true });
    assert.deepEqual(await heard, { reason: "plan_limit", target: BEN, channel: "call_socket" });
  } finally {
    socket.close();
  }

  for (const video of ["yes", 0, -5, 1.5]) assert.equal((await saveConfig({ limits: { free: { video } } }, "test")).error, "invalid_limits", String(video));
});

test("voipSent: every VoIP push APNs accepted is counted for the day", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  await User.updateOne({ phone: BEN }, { voipToken: "voip-ben", voipTokenMetadata: { environment: "production" } });
  const saved = { ...voipProviders };
  voipProviders.production = new apn.Provider();
  voipProviders.sandbox = new apn.Provider();
  try {
    const result = await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_voip" });
    assert.equal(result.ok, true);
    assert.equal(fakes.voipPushes.length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await opsCounters.countsOf(todayKey())).voipSent, 1);
    await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_voip" });
  } finally {
    Object.assign(voipProviders, saved);
  }
  // The day's snapshot carries it
  assert.equal((await computeDay(todayKey())).costs.voipSent, 1);
});

// The console has no browser test. Two cheap guards: the file parses, and
// the Plus panel's "Grenzen speichern" sends only the limits (a copied
// prices/fixed-cost check there once threw before the request went out).
test("console: app.js parses and the limits save touches only the limits", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const file = path.join(__dirname, "..", "admin-ui", "app.js");
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function PlusPanel(");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
  const save = body.slice(body.indexOf("const save = async"), body.indexOf("const field = "));
  assert.match(save, /body: \{ limits: form \}/);
  for (const foreign of ["form.prices", "form.fixedCosts", "form.bank", "form.pricesLoaded"]) {
    assert.ok(!save.includes(foreign), `PlusPanel save liest ${foreign}`);
  }
});
