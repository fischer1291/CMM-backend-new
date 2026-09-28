const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const budget = require("../lib/marketingBudget");
const marketing = require("../lib/marketing");
const MarketingSpend = require("../models/MarketingSpend");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
before(async () => {
  process.env.MARKETING_AGENT_KEY = "agent-key-for-tests-0123456789";
  marketing.setUploader(async (buffer, publicId, opts = {}) => ({
    url: `https://res.cloudinary.com/testcloud/${opts.resourceType || "video"}/upload/v1/${opts.folder || "marketing"}/${publicId}`,
    publicId,
    bytes: buffer.length,
  }));
  ctx = await setup();
});
after(async () => {
  delete process.env.MARKETING_AGENT_KEY;
  await teardown();
});
beforeEach(reset);

const AGENT = { Authorization: "Bearer agent-key-for-tests-0123456789" };
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
async function ownerCookie() {
  const who = { email: "owner@example.com", password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000)]);

// Monday 2026-09-28, 10:00 in Berlin
const MON = new Date("2026-09-28T08:00:00Z");
const day = (n) => new Date(MON.getTime() + n * 24 * 3600 * 1000);
const reserve = (eur, now = MON, purpose = "video-clip") => budget.reserve({ provider: "google", purpose, estimateEur: eur }, now);

test("budget: 5 € a day and 25 € a week from the start, never exceeded, settle and release adjust", async () => {
  const start = await budget.status(MON);
  assert.equal(start.dailyEur, 5);
  assert.equal(start.weeklyEur, 25);
  assert.equal(start.leftEur, 5);

  const a = await reserve(0.96);
  const b = await reserve(0.96);
  const c = await reserve(0.96);
  assert.ok(a.reservation && b.reservation && c.reservation);
  // 2.88 reserved: 2.12 left, so another 2.50 does not fit
  const denied = await reserve(2.5);
  assert.equal(denied.error, "budget_exceeded");
  assert.equal(denied.budget.spentTodayEur, 2.88);

  // A clip that cost nothing gives its money back; a real cost replaces the estimate
  await budget.release(c.reservation.id);
  await budget.settle(a.reservation.id, 0.8);
  assert.equal((await budget.status(MON)).spentTodayEur, 1.76);
  assert.equal((await budget.settle(a.reservation.id, 0.5)).error, "not_reserved");
  assert.ok((await reserve(3.2)).reservation);
  assert.equal((await reserve(0.1)).error, "budget_exceeded");

  // Reservations nobody settles keep counting (the agent may have died mid-call)
  assert.equal((await budget.status(MON)).spentTodayEur, 4.96);
  assert.equal(await MarketingSpend.countDocuments({ status: "reserved" }), 2);

  // The week: 4.96 on Monday, 5 each on Tuesday to Thursday = 19.96; Friday only 5.04 left
  for (const n of [1, 2, 3]) assert.ok((await reserve(5, day(n))).reservation);
  const friday = await budget.status(day(4));
  assert.equal(friday.spentWeekEur, 19.96);
  assert.equal(friday.leftEur, 5);
  assert.ok((await reserve(5, day(4))).reservation);
  assert.equal((await reserve(0.05, day(5))).error, "budget_exceeded", "week is used up on Saturday");
  // Next Monday: a new week
  assert.ok((await reserve(5, day(7))).reservation);

  // A day's reservation that fails on the week gives the day back
  assert.equal((await budget.status(day(5))).spentTodayEur, 0);

  assert.equal((await budget.reserve({ provider: "openai", purpose: "x1", estimateEur: 1 })).error, "invalid_provider");
  assert.equal((await reserve(-1)).error, "invalid_amount");
});

test("budget over HTTP: agent reserves and settles; owners set the caps, others can only look", async () => {
  await request(ctx.app).post("/marketing/budget/reserve").send({ provider: "google", purpose: "video-clip", estimateEur: 1 }).expect(401);
  const r = await request(ctx.app).post("/marketing/budget/reserve").set(AGENT).send({ provider: "google", purpose: "video-clip", estimateEur: 1, campaign: "yap-0929-anna" }).expect(201);
  await request(ctx.app).post(`/marketing/budget/${r.body.id}/settle`).set(AGENT).send({ costEur: 0.96 }).expect(200);
  await request(ctx.app).post(`/marketing/budget/${r.body.id}/release`).set(AGENT).expect(409);
  const over = await request(ctx.app).post("/marketing/budget/reserve").set(AGENT).send({ provider: "anthropic", purpose: "plan", estimateEur: 4.5 }).expect(402);
  assert.equal(over.body.error, "budget_exceeded");

  const cookie = await ownerCookie();
  const seen = (await request(ctx.app).get("/admin/marketing/budget").set(admin(cookie)).expect(200)).body;
  assert.equal(seen.budget.spentTodayEur, 0.96);
  assert.equal(seen.weekByProvider.google, 0.96);
  assert.equal(seen.entries[0].campaign, "yap-0929-anna");

  await request(ctx.app).put("/admin/marketing/budget").set(admin(cookie)).send({ dailyEur: 30, weeklyEur: 25 }).expect(400);
  await request(ctx.app).put("/admin/marketing/budget").set(admin(cookie)).send({ dailyEur: "viel", weeklyEur: 25 }).expect(400);
  const set = await request(ctx.app).put("/admin/marketing/budget").set(admin(cookie)).send({ dailyEur: 8, weeklyEur: 30 }).expect(200);
  assert.equal(set.body.budget.dailyEur, 8);
  await request(ctx.app).post("/marketing/budget/reserve").set(AGENT).send({ provider: "anthropic", purpose: "plan", estimateEur: 4.5 }).expect(201);

  const Admin = require("../models/Admin");
  const { signSession, COOKIE } = require("../lib/adminAuth");
  const viewer = await Admin.create({ email: "look@example.com", role: "viewer", totpEnabled: true, passwordHash: "x", totpSecret: "x" });
  const viewerCookie = `${COOKIE}=${encodeURIComponent(signSession(viewer))}`;
  await request(ctx.app).get("/admin/marketing/budget").set(admin(viewerCookie)).expect(200);
  await request(ctx.app).put("/admin/marketing/budget").set(admin(viewerCookie)).send({ dailyEur: 100, weeklyEur: 100 }).expect(403);
});

test("characters: the agent proposes reference images, an owner chooses or asks for new ones", async () => {
  await request(ctx.app).put("/marketing/characters/Anna!").set(AGENT).send({ name: "Anna" }).expect(400);
  await request(ctx.app).put("/marketing/characters/anna").set(AGENT).send({ name: "Anna", summary: "18, Abi, reist, bald Medizin" }).expect(200);
  const upload = (buf, type = "image/png") => request(ctx.app).post("/marketing/characters/anna/candidates").set(AGENT).set("Content-Type", type).send(buf);
  await upload(Buffer.alloc(3000)).expect(400);
  await request(ctx.app).post("/marketing/characters/nobody/candidates").set(AGENT).set("Content-Type", "image/png").send(PNG).expect(404);
  await upload(PNG).expect(201);
  const two = (await upload(PNG).expect(201)).body.character;
  assert.equal(two.candidates.length, 2);
  assert.equal(two.chosen, null);

  const cookie = await ownerCookie();
  const choose = (url) => request(ctx.app).post("/admin/marketing/characters/anna/choose").set(admin(cookie)).send({ url });
  await choose("https://example.com/fremd.png").expect(400);
  assert.equal((await choose(two.candidates[1]).expect(200)).body.character.chosen, two.candidates[1]);

  await request(ctx.app).post("/admin/marketing/characters/anna/redo").set(admin(cookie)).send({ feedback: "Haare länger, weniger Make-up" }).expect(200);
  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  const anna = context.characters.find((c) => c.key === "anna");
  assert.equal(anna.wantsNew, true);
  assert.equal(anna.feedback, "Haare länger, weniger Make-up");
  assert.equal(anna.chosen, two.candidates[1], "the chosen one stays until a new one is picked");
  assert.equal(context.budget.dailyEur, 5);
  // The next proposal replaces the old candidates
  const fresh = (await upload(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3000)]), "image/jpeg").expect(201)).body.character;
  assert.equal(fresh.candidates.length, 1);
  assert.equal(fresh.wantsNew, false);
});

test("hero drafts are always marked as AI and carry their episode and cost", async () => {
  const created = await request(ctx.app)
    .post("/marketing/drafts")
    .set(AGENT)
    .send({
      campaign: "yap-0929-anna-lissabon",
      kind: "hero",
      ai: false,
      template: "hero",
      title: "Anna in Lissabon",
      content: { shots: [{ character: "anna", prompt: "…", caption: "Letzter Abend in Lissabon." }] },
      characters: ["anna", "NOT OK"],
      episode: "Anna verbringt ihren letzten Abend in Lissabon und denkt an ihre Freundinnen zu Hause.",
      costEur: 3.918,
      captions: { instagram: "…", tiktok: "…" },
    })
    .expect(201);
  const d = created.body.draft;
  assert.equal(d.kind, "hero");
  assert.equal(d.ai, true);
  assert.deepEqual(d.characters, ["anna"]);
  assert.equal(d.costEur, 3.92);
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4000)]);
  await request(ctx.app).put(`/marketing/drafts/${d.id}/video`).set(AGENT).set("Content-Type", "video/mp4").send(MP4).expect(200);
  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  assert.equal(context.drafts[0].episode, d.episode);
  assert.equal(context.drafts[0].kind, "hero");
});
