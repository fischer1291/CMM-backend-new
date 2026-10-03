const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const Lock = require("../models/Lock");
const { asLeader } = require("../lib/leader");
const { healthStatus, STARTUP_GRACE_SEC } = require("../lib/health");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  await Lock.syncIndexes();
});

const ago = (sec) => new Date(Date.now() - sec * 1000);
const lock = (lastRunAt) => Lock.create({ key: "jobs", owner: "a", expiresAt: new Date(Date.now() + 90_000), lastRunAt });

test("healthz: 200 while the leader ticked recently, never cached", async () => {
  await lock(ago(30));
  const res = await request(ctx.app).get("/healthz").expect(200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.db, "connected");
  assert.ok(res.body.lastTickAgeSec >= 30 && res.body.lastTickAgeSec < 35, `age ${res.body.lastTickAgeSec}`);
  assert.equal(res.body.version, "dev");
});

test("healthz: 503 tick_stale once the last tick is older than three minutes", async () => {
  await lock(ago(10 * 60));
  const res = await request(ctx.app).get("/healthz").expect(503);
  assert.deepEqual(res.body, { ok: false, reason: "tick_stale", lastTickAgeSec: res.body.lastTickAgeSec });
  assert.ok(res.body.lastTickAgeSec >= 600);
});

test("healthz: no lock yet is fine for a young process, no_tick for an old one", async () => {
  // The test process itself is well within the grace period
  const res = await request(ctx.app).get("/healthz").expect(200);
  assert.deepEqual(res.body, { ok: true, db: "connected", lastTickAgeSec: null, version: "dev" });
  assert.deepEqual(await healthStatus({ uptimeSec: 10 }), { ok: true, db: "connected", lastTickAgeSec: null, version: "dev" });
  assert.deepEqual(await healthStatus({ uptimeSec: STARTUP_GRACE_SEC }), { ok: false, reason: "no_tick" });
  // A lease without a finished job counts as no tick, too
  await lock(undefined);
  assert.deepEqual(await healthStatus({ uptimeSec: STARTUP_GRACE_SEC + 1 }), { ok: false, reason: "no_tick" });
});

test("healthz: a finished leader job stamps the lock and the age counts from there", async () => {
  await asLeader("jobs", async () => "done", { owner: "a" });
  const res = await request(ctx.app).get("/healthz").expect(200);
  assert.ok(res.body.lastTickAgeSec <= 1);
  const stamped = (await Lock.findOne({ key: "jobs" })).lastRunAt;
  // A failing job leaves the stamp alone
  await assert.rejects(asLeader("jobs", async () => Promise.reject(new Error("boom")), { owner: "a" }), /boom/);
  assert.equal(String((await Lock.findOne({ key: "jobs" })).lastRunAt), String(stamped));
  // Someone who doesn't hold the lease neither runs nor stamps
  assert.equal(await asLeader("jobs", async () => "ran", { owner: "b" }), undefined);
  assert.equal(String((await Lock.findOne({ key: "jobs" })).lastRunAt), String(stamped));
  assert.equal((await healthStatus({ now: new Date(stamped.getTime() + 181_000) })).reason, "tick_stale");
  assert.equal((await healthStatus({ now: new Date(stamped.getTime() + 180_000) })).ok, true);
});
