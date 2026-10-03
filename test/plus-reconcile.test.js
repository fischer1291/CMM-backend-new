// The nightly RevenueCat reconcile (lib/plusReconcile.js, plan 2.4): every
// store Plus against GET /v1/subscribers/{id}, drift corrected and counted,
// one subscriber's error never stops the run, once a day in the night window.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { setup, teardown, reset } = require("./helpers");
const User = require("../models/User");
const AppConfig = require("../models/AppConfig");
const revenuecat = require("../lib/revenuecat");
const opsCounters = require("../lib/opsCounters");
const { reconcile, runDue, differs } = require("../lib/plusReconcile");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  process.env.REVENUECAT_API_KEY = "rc-api-key";
  revenuecat.setFetchSubscriber(null);
});

const DAY = 24 * 3600 * 1000;
let n = 0;
const person = (plus) => ({ phone: `+49151${String(++n).padStart(7, "0")}`, plus: { active: true, since: new Date("2026-09-01T00:00:00Z"), status: "active", productId: "wannayap_plus_monthly", ...plus } });
const subscription = (expiresAt, extra = {}) => ({ subscriptions: { wannayap_plus_monthly: { expires_date: expiresAt.toISOString(), period_type: "normal", is_sandbox: false, store: "app_store", ...extra } } });

test("reconcile: corrects what differs from RevenueCat, leaves matching and gifted Plus alone, counts, survives one failing subscriber", async () => {
  const now = new Date("2026-09-30T02:00:00Z");
  const until = new Date(now.getTime() + 20 * DAY);
  const [anna, ben, carl, dora, erik, fritz, greta] = await User.create([
    // The store says expired (a missed EXPIRATION webhook): Plus ends
    person({ source: "store", until }),
    // Everything matches: untouched
    person({ source: "store", until }),
    // Gifted: not the store's business
    person({ source: "referral", until, status: null }),
    // RevenueCat no longer knows the subscriber: the sandbox Plus ends
    person({ source: "sandbox", until }),
    // RevenueCat answers 500 for this one
    person({ source: "store", until }),
    // Cancelled in the store, still running: the status follows
    person({ source: "store", until }),
    // From before the status field existed: active and until match, no drift
    person({ source: "store", until, status: null }),
  ]);
  const asked = [];
  revenuecat.setFetchSubscriber(async (id) => {
    asked.push(id);
    if (id === String(anna._id)) return subscription(new Date(now.getTime() - DAY));
    if (id === String(ben._id)) return subscription(until);
    if (id === String(dora._id)) return null;
    if (id === String(erik._id)) throw new Error("revenuecat_500");
    if (id === String(fritz._id)) return subscription(until, { unsubscribe_detected_at: new Date(now.getTime() - DAY).toISOString() });
    if (id === String(greta._id)) return subscription(until);
    throw new Error(`unexpected ${id}`);
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let result;
  try {
    result = await reconcile(now);
  } finally {
    console.error = original;
  }
  assert.deepEqual(result, { checked: 5, fixed: 3, failed: 1 });
  assert.equal(asked.length, 6, "every store or sandbox Plus is asked, the gift is not");
  assert.ok(!asked.includes(String(carl._id)));
  assert.ok(errors.some((e) => e.includes(String(erik._id)) && e.includes("revenuecat_500")));

  const plus = async (u) => (await User.findById(u._id).lean()).plus;
  assert.equal((await plus(anna)).active, false);
  assert.equal((await plus(anna)).status, "expired");
  assert.equal((await plus(ben)).eventAt, null, "nothing written for a matching plan");
  assert.equal((await plus(carl)).active, true);
  assert.equal((await plus(dora)).active, false);
  assert.equal((await plus(dora)).status, "expired");
  assert.equal((await plus(erik)).active, true, "an error leaves the user as they were");
  assert.deepEqual([(await plus(fritz)).active, (await plus(fritz)).status], [true, "cancelled"]);
  assert.deepEqual([(await plus(greta)).status, (await plus(greta)).eventAt], [null, null], "a missing status alone is no drift");
  // A corrected user keeps everything the projection did not load
  assert.equal((await User.findById(anna._id).lean()).phone, anna.phone);

  const counts = await opsCounters.countsOf("2026-09-30");
  assert.deepEqual(counts, { plusReconcileChecked: 5, plusReconcileFixed: 3, plusReconcileFailed: 1 });

  // A second run finds nothing to fix
  revenuecat.setFetchSubscriber(async (id) => {
    if (id === String(anna._id)) return subscription(new Date(now.getTime() - DAY));
    if (id === String(dora._id)) return null;
    if (id === String(fritz._id)) return subscription(until, { unsubscribe_detected_at: new Date(now.getTime() - DAY).toISOString() });
    return subscription(until);
  });
  assert.deepEqual(await reconcile(now), { checked: 6, fixed: 0, failed: 0 });
});

test("differs: only active, until and status count; a gifted plan next to an expired store answer is no drift", () => {
  const until = new Date("2026-10-20T00:00:00Z");
  const store = { plus: { active: true, until, status: "active", source: "store" } };
  assert.equal(differs(store, { active: true, until: new Date(until), status: "active" }), false);
  assert.equal(differs(store, { active: true, until: new Date(until.getTime() + DAY), status: "active" }), true);
  assert.equal(differs(store, { active: true, until, status: "cancelled" }), true);
  assert.equal(differs(store, { active: false, until, status: "expired" }), true);
  assert.equal(differs(store, null), true);
  assert.equal(differs({ plus: { active: false, until, status: "expired", source: "store" } }, null), false);
  assert.equal(differs({ plus: { active: true, until, source: "referral" } }, { active: false, until, status: "expired" }), false);
  // A status the store cannot report (none yet, or paused on Google Play) is compared by active and until alone
  assert.equal(differs({ plus: { active: true, until, status: null, source: "store" } }, { active: true, until, status: "active" }), false);
  assert.equal(differs({ plus: { active: true, until, status: "paused", source: "store" } }, { active: true, until, status: "active" }), false);
  assert.equal(differs({ plus: { active: true, until, status: null, source: "store" } }, { active: false, until, status: "expired" }), true);
});

test("runDue: once a day between 03:00 and 05:00 Europe/Berlin, nothing without the API key", async () => {
  const until = new Date("2026-10-20T00:00:00Z");
  const anna = await User.create(person({ source: "store", until }));
  let asked = 0;
  revenuecat.setFetchSubscriber(async () => {
    asked++;
    return subscription(new Date("2026-09-01T00:00:00Z"));
  });
  // 02:30 Berlin (CEST): too early
  assert.equal(await runDue(new Date("2026-09-30T00:30:00Z")), null);
  // 05:10 Berlin: too late
  assert.equal(await runDue(new Date("2026-09-30T03:10:00Z")), null);
  assert.equal(asked, 0);
  // 03:30 Berlin: runs
  assert.deepEqual(await runDue(new Date("2026-09-30T01:30:00Z")), { checked: 1, fixed: 1, failed: 0 });
  assert.equal((await User.findById(anna._id).lean()).plus.active, false);
  assert.equal((await AppConfig.findOne({ key: "app" }).lean()).ops.plusReconcileFor, "2026-09-30");
  // Same window, again (a restart or a second instance): already done today
  assert.equal(await runDue(new Date("2026-09-30T02:30:00Z")), null);
  assert.equal(asked, 1);
  // The next night runs again
  assert.deepEqual(await runDue(new Date("2026-10-01T01:30:00Z")), { checked: 1, fixed: 0, failed: 0 });
  // Without the key nothing runs and nothing is claimed
  delete process.env.REVENUECAT_API_KEY;
  assert.equal(await runDue(new Date("2026-10-02T01:30:00Z")), null);
  assert.equal((await AppConfig.findOne({ key: "app" }).lean()).ops.plusReconcileFor, "2026-10-01");
  assert.equal(ctx.app != null, true);
});
