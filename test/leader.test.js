const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { setup, teardown, reset } = require("./helpers");
const Lock = require("../models/Lock");
const { holdLease, releaseLease } = require("../lib/leader");

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await Lock.syncIndexes();
});

test("leader: one instance holds the lease, renews it, and another takes over when it runs out", async () => {
  const t0 = new Date("2026-09-26T10:00:00Z");
  const later = (s) => new Date(t0.getTime() + s * 1000);

  assert.equal(await holdLease("jobs", { owner: "a", now: t0 }), true);
  assert.equal(await holdLease("jobs", { owner: "b", now: later(10) }), false, "a still holds it");
  assert.equal(await holdLease("jobs", { owner: "a", now: later(60) }), true, "a renews");
  assert.equal(await holdLease("jobs", { owner: "b", now: later(120) }), false, "renewed lease runs to 150 s");
  assert.equal(await holdLease("jobs", { owner: "b", now: later(151) }), true, "a is gone: b takes over");
  assert.equal(await holdLease("jobs", { owner: "a", now: later(160) }), false);
  assert.equal(await Lock.countDocuments(), 1);
});

test("leader: releasing hands over at once; both racing for a free lease get exactly one winner", async () => {
  const now = new Date();
  assert.equal(await holdLease("jobs", { owner: "a", now }), true);
  await releaseLease("jobs", { owner: "b" }); // not b's to release
  assert.equal(await holdLease("jobs", { owner: "b", now }), false);
  await releaseLease("jobs", { owner: "a" });
  assert.equal(await holdLease("jobs", { owner: "b", now }), true);

  await Lock.deleteMany({});
  const results = await Promise.all(["x", "y", "z"].map((owner) => holdLease("race", { owner, now })));
  assert.equal(results.filter(Boolean).length, 1);
});
