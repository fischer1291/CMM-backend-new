// Plan 2.7: the launch gate. lib/launchChecklist.js computes the automatic
// ticks (healthz, restore drill, backup, two owners, pentest) and keeps the
// manual ones; GET/PUT /admin/launch-checklist; paid reach ("media") in
// lib/marketingBudget.js waits for a complete list, the AI providers don't.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const AppConfig = require("../models/AppConfig");
const checklist = require("../lib/launchChecklist");
const budget = require("../lib/marketingBudget");
const { saveConfig } = require("../lib/appConfig");
const { signSession, COOKIE } = require("../lib/adminAuth");

let ctx;
before(async () => {
  process.env.MARKETING_AGENT_KEY = "agent-key-for-tests-0123456789";
  ctx = await setup();
});
after(async () => {
  delete process.env.MARKETING_AGENT_KEY;
  await teardown();
});
beforeEach(reset);

const DAY = 24 * 3600 * 1000;
const AGENT = { Authorization: "Bearer agent-key-for-tests-0123456789" };
const healthy = async () => ({ ok: true });
const ago = (days, now = new Date()) => new Date(now.getTime() - days * DAY);
const itemOf = (s, key) => s.items.find((i) => i.key === key);
async function adminWith(email, role = "owner") {
  const a = await Admin.create({ email, role, totpEnabled: true, passwordHash: "x", totpSecret: "x" });
  return { Cookie: `${COOKIE}=${encodeURIComponent(signSession(a))}`, "X-Admin-Request": "1" };
}
// Like routes/ops.js: a stored ops block of null takes no dotted $set
async function setOps(ops) {
  await AppConfig.updateOne({ key: "app", ops: null }, { $set: { ops: {} } });
  await setOpsFields(ops);
}
const setOpsFields = (ops) => AppConfig.updateOne({ key: "app" }, { $set: Object.fromEntries(Object.entries(ops).map(([k, v]) => [`ops.${k}`, v])) }, { upsert: true });
/** Everything green: dates, a second owner and every manual tick. */
async function completeAll(now = new Date()) {
  await setOps({ lastRestoreDrillAt: ago(10, now), lastBackupAt: ago(1, now), lastPentestAt: ago(100, now) });
  for (let n = await Admin.countDocuments({ role: "owner" }); n < 2; n++) await adminWith(`owner${n}@example.com`);
  for (const key of checklist.MANUAL_KEYS) await checklist.setManual(key, { done: true, note: "erledigt" }, "one@example.com", now);
}

test("checklist: automatic ticks from health, dates and owners; restore drill 89 vs 91 days", async () => {
  const now = new Date();
  let s = await checklist.status(now, { health: healthy });
  assert.equal(s.complete, false);
  assert.deepEqual(s.items.map((i) => i.key), [...checklist.AUTO_KEYS, ...checklist.MANUAL_KEYS]);
  assert.deepEqual(checklist.AUTO_KEYS, ["healthz", "restoreDrill", "backupFresh", "twoOwners", "pentest"]);
  assert.equal(itemOf(s, "healthz").done, true);
  assert.equal(itemOf(s, "healthz").kind, "auto");
  assert.equal(itemOf(s, "restoreDrill").done, false);
  assert.match(itemOf(s, "restoreDrill").detail, /Noch kein Restore-Test/);
  assert.equal(itemOf(s, "gewerbe").kind, "manual");
  assert.equal(itemOf(s, "gewerbe").done, false);

  const down = await checklist.status(now, { health: async () => ({ ok: false, reason: "tick_stale" }) });
  assert.equal(itemOf(down, "healthz").done, false);
  assert.match(itemOf(down, "healthz").detail, /tick_stale/);

  await setOps({ lastRestoreDrillAt: ago(89, now), lastBackupAt: ago(7, now), lastPentestAt: ago(364, now) });
  s = await checklist.status(now, { health: healthy });
  assert.equal(itemOf(s, "restoreDrill").done, true);
  assert.match(itemOf(s, "restoreDrill").detail, /^Restore-Test am /);
  assert.equal(itemOf(s, "backupFresh").done, true);
  assert.equal(itemOf(s, "pentest").done, true);
  await setOps({ lastRestoreDrillAt: ago(91, now), lastBackupAt: ago(9, now), lastPentestAt: ago(366, now) });
  s = await checklist.status(now, { health: healthy });
  assert.equal(itemOf(s, "restoreDrill").done, false);
  assert.match(itemOf(s, "restoreDrill").detail, /älter als 90 Tage/);
  assert.equal(itemOf(s, "backupFresh").done, false);
  assert.equal(itemOf(s, "pentest").done, false);

  // Two owners with TOTP; inactive ones, unconfirmed ones and other roles don't count
  await adminWith("one@example.com");
  await Admin.create({ email: "pending@example.com", role: "owner", totpEnabled: false, passwordHash: "x", totpSecret: "x" });
  await Admin.create({ email: "gone@example.com", role: "owner", totpEnabled: true, active: false, passwordHash: "x", totpSecret: "x" });
  await adminWith("help@example.com", "support");
  assert.equal(itemOf(await checklist.status(now, { health: healthy }), "twoOwners").done, false);
  await adminWith("two@example.com");
  assert.equal(itemOf(await checklist.status(now, { health: healthy }), "twoOwners").done, true);
});

test("checklist over HTTP: everyone reads, only owners tick manual items, audited; complete once all are done", async () => {
  const viewer = await adminWith("look@example.com", "viewer");
  const support = await adminWith("help@example.com", "support");
  const owner = await adminWith("one@example.com");

  const seen = (await request(ctx.app).get("/admin/launch-checklist").set(viewer).expect(200)).body;
  assert.equal(seen.complete, false);
  assert.equal(seen.items.length, checklist.KEYS.length);
  assert.ok(seen.items.every((i) => ["auto", "manual"].includes(i.kind) && "detail" in i));

  await request(ctx.app).put("/admin/launch-checklist/gewerbe").set(viewer).send({ done: true }).expect(403);
  await request(ctx.app).put("/admin/launch-checklist/gewerbe").set(support).send({ done: true }).expect(403);
  assert.equal((await request(ctx.app).put("/admin/launch-checklist/healthz").set(owner).send({ done: true }).expect(400)).body.error, "automatic_item");
  await request(ctx.app).put("/admin/launch-checklist/nope").set(owner).send({ done: true }).expect(404);
  await request(ctx.app).put("/admin/launch-checklist/gewerbe").set(owner).send({ done: "ja" }).expect(400);
  await request(ctx.app).put("/admin/launch-checklist/gewerbe").set(owner).send({ done: true, note: "x".repeat(301) }).expect(400);

  const ticked = (await request(ctx.app).put("/admin/launch-checklist/insurance").set(owner).send({ done: true, note: " Hiscox, 500 k€ " }).expect(200)).body;
  const ins = itemOf(ticked, "insurance");
  assert.equal(ins.done, true);
  assert.equal(ins.by, "one@example.com");
  assert.equal(ins.note, "Hiscox, 500 k€");
  assert.ok(new Date(ins.at) > ago(1));
  const entry = await AdminAudit.findOne({ action: "launch_checklist" }).lean();
  assert.deepEqual(entry.meta, { key: "insurance", done: true, note: "Hiscox, 500 k€" });
  // Unticking keeps who and when
  const off = itemOf((await request(ctx.app).put("/admin/launch-checklist/insurance").set(owner).send({ done: false }).expect(200)).body, "insurance");
  assert.equal(off.done, false);
  assert.equal(off.by, "one@example.com");

  await completeAll();
  const done = (await request(ctx.app).get("/admin/launch-checklist").set(viewer).expect(200)).body;
  assert.deepEqual(done.items.filter((i) => !i.done).map((i) => i.key), []);
  assert.equal(done.complete, true);
});

test("launch: two owners ticking different items at the same time both count", async () => {
  await AppConfig.updateOne({ key: "app" }, { $set: { launchChecklist: null } }, { upsert: true });
  await Promise.all([
    checklist.setManual("trademark", { done: true }, "one@example.com"),
    checklist.setManual("ageRating", { done: true }, "two@example.com"),
    checklist.setManual("privacyLabel", { done: true }, "one@example.com"),
  ]);
  const ticks = (await AppConfig.findOne({ key: "app" }).lean()).launchChecklist;
  assert.deepEqual(Object.keys(ticks).sort(), ["ageRating", "privacyLabel", "trademark"]);
  assert.equal(ticks.ageRating.by, "two@example.com");
});

test("budget: media waits for the launch gate, the AI providers don't", async () => {
  const res = await budget.reserve({ provider: "media", purpose: "tiktok-ads", estimateEur: 2 });
  assert.equal(res.error, "launch_checklist_incomplete");
  assert.ok((await budget.reserve({ provider: "anthropic", purpose: "plan", estimateEur: 0.5 })).reservation);
  assert.ok((await budget.reserve({ provider: "google", purpose: "video-clip", estimateEur: 0.5 })).reservation);
  const http = await request(ctx.app).post("/marketing/budget/reserve").set(AGENT).send({ provider: "media", purpose: "tiktok-ads", estimateEur: 1 }).expect(403);
  assert.equal(http.body.error, "launch_checklist_incomplete");

  await completeAll();
  const open = await budget.reserve({ provider: "media", purpose: "tiktok-ads", estimateEur: 2 });
  assert.ok(open.reservation, JSON.stringify(open));
  // Still within the same caps: 1 € (AI) + 2 € (media) of 5 € today
  assert.equal((await budget.reserve({ provider: "media", purpose: "tiktok-ads", estimateEur: 2.5 })).error, "budget_exceeded");
  // One unticked item closes the gate again
  await checklist.setManual("trademark", { done: false }, "one@example.com");
  assert.equal((await budget.reserve({ provider: "media", purpose: "tiktok-ads", estimateEur: 0.1 })).error, "launch_checklist_incomplete");
});

test("config: restore drill and pentest dates are set under ops, validated", async () => {
  const drill = ago(13).toISOString().slice(0, 10);
  const ok = await saveConfig({ ops: { lastRestoreDrillAt: drill, lastPentestAt: null } }, "one@example.com");
  assert.ok(!ok.error, ok.error);
  const stored = (await AppConfig.findOne({ key: "app" }).lean()).ops;
  assert.equal(new Date(stored.lastRestoreDrillAt).toISOString(), `${drill}T00:00:00.000Z`);
  assert.equal(stored.lastPentestAt, null);
  for (const bad of ["morgen", "2099-01-01", "2019-05-01", 20260920, "", { at: drill }]) {
    assert.equal((await saveConfig({ ops: { lastPentestAt: bad } }, "x")).error, "invalid_ops", String(bad));
  }
  // Other ops keys stay as they were
  assert.equal((await AppConfig.findOne({ key: "app" }).lean()).ops.smsPerDay, 100);
});
