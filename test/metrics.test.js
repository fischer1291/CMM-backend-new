// The north star (lib/metrics.js): rolling activation of the last four full
// weeks, address book density of new people, both in the day's snapshot, and
// the goals they are judged against (lib/appConfig.js goals).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const mongoose = require("mongoose");
const { setup, teardown, reset } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const { activation4w, density, computeDay, todayKey } = require("../lib/metrics");
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
