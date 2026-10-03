// Where people come from (plan 2.10, lib/acquisition.js): POST
// /me/acquisition (validation, code from the invite, the 24-hour window,
// 409 after), GET /me with acquisition and joinedViaInvite, the campaign
// from the waitlist entry and the seed campaign, the campaigns tab (owners
// create and edit, numbers per slug from LandingVisit, WaitlistEntry,
// User.acquisition and MarketingSpend, unregistered slugs, the QR code)
// and the numbers in MetricsDaily.growth and GET /admin/metrics/acquisition.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { Types } = require("mongoose");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const Campaign = require("../models/Campaign");
const LandingVisit = require("../models/LandingVisit");
const WaitlistEntry = require("../models/WaitlistEntry");
const MarketingSpend = require("../models/MarketingSpend");
const { totpAt, currentStep, signSession, hashPassword, newTotpSecret, COOKIE } = require("../lib/adminAuth");
const { saveConfig } = require("../lib/appConfig");
const { computeDay, todayKey, activationBySource, dayStart, METRICS_VERSION } = require("../lib/metrics");
const { weekKey, shiftDateKey } = require("../lib/localTime");
const { ANSWER_WINDOW_MS } = require("../lib/acquisition");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idAt = (date) => new Types.ObjectId(Math.floor(date.getTime() / 1000));

async function login(phone, extra = {}) {
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode, ...extra }).expect(200);
  return res.body.token;
}
const answer = (token, body) => request(ctx.app).post("/me/acquisition").set(auth(token)).send(body);

const EMAIL = "owner@example.com";
const PASSWORD = "a-long-admin-password";
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
async function ownerCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ email: EMAIL, password: PASSWORD, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}
async function roleCookie(role) {
  const admin = await Admin.create({ email: `${role}@example.com`, passwordHash: hashPassword(PASSWORD), totpSecret: newTotpSecret(), totpEnabled: true, role });
  return `${COOKIE}=${encodeURIComponent(signSession(admin))}`;
}
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

test("POST /me/acquisition: validates, stores the answer, token only", async () => {
  const token = await login(ANNA);
  for (const [body, error] of [
    [{}, "invalid_source"],
    [{ source: "facebook" }, "invalid_source"],
    [{ source: "tiktok", androidFriends: 6 }, "invalid_android_friends"],
    [{ source: "tiktok", androidFriends: -1 }, "invalid_android_friends"],
    [{ source: "tiktok", androidFriends: 2.5 }, "invalid_android_friends"],
    [{ source: "tiktok", androidFriends: "2" }, "invalid_android_friends"],
  ]) {
    const res = await answer(token, body).expect(400);
    assert.equal(res.body.error, error, JSON.stringify(body));
  }
  await request(ctx.app).post("/me/acquisition").send({ phone: ANNA, source: "tiktok" }).expect(401);

  // Before an answer: null in GET /me, not via an invite
  const before = (await request(ctx.app).get("/me").set(auth(token)).expect(200)).body.user;
  assert.equal(before.acquisition, null);
  assert.equal(before.joinedViaInvite, false);

  // campaign and code from the body are ignored: the server sets them
  const res = await answer(token, { source: "tiktok", androidFriends: 2, campaign: "fake", code: "FAKE1234" }).expect(200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.acquisition.source, "tiktok");
  assert.equal(res.body.acquisition.androidFriends, 2);
  assert.equal(res.body.acquisition.campaign, null);
  assert.equal(res.body.acquisition.code, null);
  assert.ok(res.body.acquisition.at);

  const stored = (await User.findOne({ phone: ANNA }).lean()).acquisition;
  assert.equal(stored.source, "tiktok");
  assert.equal(stored.androidFriends, 2);
  const me = (await request(ctx.app).get("/me").set(auth(token)).expect(200)).body.user;
  assert.deepEqual({ ...me.acquisition, at: undefined }, { source: "tiktok", androidFriends: 2, campaign: null, code: null, at: undefined });

  // Not part of someone else's profile
  const other = (await request(ctx.app).get(`/me?phone=${encodeURIComponent(ANNA)}`).set(auth(await login(BEN))).expect(200)).body.user;
  assert.equal("acquisition" in other, false);
  assert.equal("joinedViaInvite" in other, false);

  // In the data export
  const exported = (await request(ctx.app).get("/me/export").set(auth(token)).expect(200)).body.data;
  assert.equal(exported.acquisition.source, "tiktok");
});

test("POST /me/acquisition: a second answer within 24 hours replaces the first, after that 409", async () => {
  const token = await login(ANNA);
  const first = (await answer(token, { source: "flyer", androidFriends: 1 }).expect(200)).body.acquisition;
  const second = (await answer(token, { source: "instagram" }).expect(200)).body.acquisition;
  assert.equal(second.source, "instagram");
  assert.equal(second.androidFriends, null, "the whole answer is replaced");
  assert.equal(second.at, first.at, "at stays the first answer");

  // 23 hours later: still replaces
  await User.updateOne({ phone: ANNA }, { $set: { "acquisition.at": new Date(Date.now() - 23 * HOUR) } });
  assert.equal((await answer(token, { source: "press", androidFriends: 0 }).expect(200)).body.acquisition.source, "press");
  // The window is over
  await User.updateOne({ phone: ANNA }, { $set: { "acquisition.at": new Date(Date.now() - ANSWER_WINDOW_MS - 1000) } });
  const late = await answer(token, { source: "other" }).expect(409);
  assert.equal(late.body.error, "already_answered");
  const stored = (await User.findOne({ phone: ANNA }).lean()).acquisition;
  assert.equal(stored.source, "press");
  assert.equal(stored.androidFriends, 0);
});

test("POST /me/acquisition: code is the first inviter's invite code; GET /me says joinedViaInvite", async () => {
  await login(ANNA);
  const anna = await User.findOne({ phone: ANNA }).lean();
  const token = await login(BEN, { inviteCode: anna.inviteCode });
  const me = (await request(ctx.app).get("/me").set(auth(token)).expect(200)).body.user;
  assert.equal(me.joinedViaInvite, true);
  assert.equal(me.acquisition, null);
  const res = await answer(token, { source: "friend", androidFriends: 3 }).expect(200);
  assert.equal(res.body.acquisition.code, anna.inviteCode);
  assert.equal(res.body.acquisition.campaign, null);
});

test("campaign: from the redeemed waitlist entry (also after the answer), else the running seed campaign that fits the answer", async () => {
  // The waitlist entry's landing campaign wins
  await WaitlistEntry.create({ email: "a@example.com", code: "WAIT2345", token: "t".repeat(48), status: "confirmed", confirmedAt: new Date(), campaign: "Flyer-Mensa" });
  const anna = await login(ANNA);
  await User.updateOne({ phone: ANNA }, { $set: { waitlist: { code: "WAIT2345", at: new Date(), referrals: 0 } } });
  assert.equal((await answer(anna, { source: "flyer" }).expect(200)).body.acquisition.campaign, "flyer-mensa");

  // Redeemed after answering: the campaign is filled in then
  await WaitlistEntry.create({ email: "b@example.com", code: "WAIT6789", token: "u".repeat(48), status: "confirmed", confirmedAt: new Date(), campaign: "campus-leipzig" });
  const ben = await login(BEN);
  assert.equal((await answer(ben, { source: "flyer" }).expect(200)).body.acquisition.campaign, null);
  await request(ctx.app).post("/me/waitlist/redeem").set(auth(ben)).send({ code: "WAIT6789" }).expect(200);
  assert.equal((await User.findOne({ phone: BEN }).lean()).acquisition.campaign, "campus-leipzig");

  // Seed campaign: only a registered one can be set
  assert.equal((await saveConfig({ goals: { seedCampaign: "seed-leipzig" } }, "owner@test")).error, "invalid_goals");
  assert.equal((await saveConfig({ goals: { seedCampaign: "Seed Leipzig" } }, "owner@test")).error, "invalid_goals");
  await Campaign.create({ slug: "seed-leipzig", channel: "campus", status: "planned", createdBy: "owner@test" });
  assert.equal((await saveConfig({ goals: { seedCampaign: "seed-leipzig" } }, "owner@test")).error, undefined);
  const carl = await login(CARL);
  // Planned, not running yet: nothing
  assert.equal((await answer(carl, { source: "friend" }).expect(200)).body.acquisition.campaign, null);
  await Campaign.updateOne({ slug: "seed-leipzig" }, { $set: { status: "running", startedAt: new Date(Date.now() - DAY) } });
  // Running: a campus campaign counts friends and flyers, not TikTok
  assert.equal((await answer(carl, { source: "tiktok" }).expect(200)).body.acquisition.campaign, null);
  assert.equal((await answer(carl, { source: "friend" }).expect(200)).body.acquisition.campaign, "seed-leipzig");
  // Ended: nothing
  await Campaign.updateOne({ slug: "seed-leipzig" }, { $set: { endedAt: new Date(Date.now() - HOUR) } });
  assert.equal((await answer(carl, { source: "flyer" }).expect(200)).body.acquisition.campaign, null);
  assert.equal((await saveConfig({ goals: { seedCampaign: null } }, "owner@test")).error, undefined);
});

test("campaigns: only owners create and edit, validated and audited; viewers read; QR as SVG", async () => {
  const owner = await ownerCookie();
  const viewer = await roleCookie("viewer");
  const support = await roleCookie("support");
  const body = { slug: "campus-leipzig", channel: "campus", title: "Uni Leipzig, Mensa", startedAt: "2026-10-05", budgetEurCents: 15000, partner: "Fachschaft", notes: "200 Flyer" };

  await request(ctx.app).post("/admin/campaigns").set(admin(viewer)).send(body).expect(403);
  await request(ctx.app).post("/admin/campaigns").set(admin(support)).send(body).expect(403);
  for (const [bad, error] of [
    [{ ...body, slug: "C" }, "invalid_slug"],
    [{ ...body, slug: "campus leipzig" }, "invalid_slug"],
    [{ ...body, slug: "x".repeat(41) }, "invalid_slug"],
    [{ ...body, channel: "radio" }, "invalid_channel"],
    [{ slug: "ohne-kanal" }, "invalid_channel"],
    [{ ...body, title: "t".repeat(81) }, "invalid_title"],
    [{ ...body, budgetEurCents: 12.5 }, "invalid_budget"],
    [{ ...body, budgetEurCents: -1 }, "invalid_budget"],
    [{ ...body, startedAt: "morgen" }, "invalid_dates"],
    [{ ...body, endedAt: "2026-10-01" }, "invalid_dates"],
    [{ ...body, status: "paused" }, "invalid_status"],
    [{ ...body, notes: "n".repeat(1001) }, "invalid_notes"],
  ]) {
    const res = await request(ctx.app).post("/admin/campaigns").set(admin(owner)).send(bad).expect(400);
    assert.equal(res.body.error, error, JSON.stringify(bad).slice(0, 80));
  }
  const created = (await request(ctx.app).post("/admin/campaigns").set(admin(owner)).send(body).expect(200)).body.campaign;
  assert.equal(created.slug, "campus-leipzig");
  assert.equal(created.status, "planned");
  assert.equal(created.createdBy, EMAIL);
  assert.equal(created.budgetEurCents, 15000);
  assert.equal((await request(ctx.app).post("/admin/campaigns").set(admin(owner)).send(body).expect(409)).body.error, "slug_taken");

  await request(ctx.app).put("/admin/campaigns/campus-leipzig").set(admin(viewer)).send({ status: "running" }).expect(403);
  await request(ctx.app).put("/admin/campaigns/gibt-es-nicht").set(admin(owner)).send({ status: "running" }).expect(404);
  assert.equal((await request(ctx.app).put("/admin/campaigns/campus-leipzig").set(admin(owner)).send({ slug: "neu" }).expect(400)).body.error, "slug_fixed");
  assert.equal((await request(ctx.app).put("/admin/campaigns/campus-leipzig").set(admin(owner)).send({ endedAt: "2026-10-01" }).expect(400)).body.error, "invalid_dates");
  const updated = (await request(ctx.app).put("/admin/campaigns/campus-leipzig").set(admin(owner)).send({ status: "running", endedAt: "2026-11-30", budgetEurCents: null }).expect(200)).body.campaign;
  assert.equal(updated.status, "running");
  assert.equal(updated.budgetEurCents, null);
  assert.equal(updated.title, "Uni Leipzig, Mensa", "untouched fields stay");

  const audited = await AdminAudit.find({ action: /^campaign_/ }).sort({ at: 1 }).lean();
  assert.deepEqual(audited.map((a) => [a.action, a.target]), [["campaign_created", "campus-leipzig"], ["campaign_updated", "campus-leipzig"]]);

  const list = (await request(ctx.app).get("/admin/campaigns").set(admin(viewer)).expect(200)).body;
  assert.equal(list.days, 90);
  assert.equal(list.campaigns.length, 1);
  assert.deepEqual(list.campaigns[0].links, {
    store: "https://wannayap.app/k/campus-leipzig",
    landing: "https://wannayap.app/?utm_source=campus&utm_campaign=campus-leipzig",
  });
  assert.deepEqual(list.campaigns[0].numbers, { visits: 0, storeClicks: 0, waitlist: 0, users: 0, activatedD7: 0, spendEurCents: 0 });
  assert.deepEqual(list.unregistered, []);

  const qr = await request(ctx.app).get("/admin/campaigns/campus-leipzig/qr.svg").set("Cookie", viewer).expect(200);
  assert.match(qr.headers["content-type"], /^image\/svg\+xml/);
  assert.match(qr.headers["content-disposition"], /filename="wannayap-campus-leipzig\.svg"/);
  assert.match(String(qr.body || qr.text), /<svg/);
  await request(ctx.app).get("/admin/campaigns/Campus%20Leipzig/qr.svg").set("Cookie", viewer).expect(400);
  await request(ctx.app).get("/admin/campaigns/campus-leipzig/qr.svg").expect(401);
});

test("campaigns: numbers per slug from visits, waitlist, answers and spend; unregistered slugs marked", async () => {
  const owner = await ownerCookie();
  await Campaign.create({ slug: "campus-leipzig", channel: "campus", status: "running", createdBy: EMAIL });
  await Campaign.create({ slug: "tiktok-herbst", channel: "tiktok", status: "planned", createdBy: EMAIL });
  const now = new Date();
  const today = todayKey(now);
  await LandingVisit.create([
    { day: today, source: "campus", campaign: "campus-leipzig", visits: 30, storeClicks: 12 },
    { day: shiftDateKey(today, -3), source: "instagram", campaign: "campus-leipzig", visits: 10, storeClicks: 3 },
    // Older than 90 days: not counted
    { day: shiftDateKey(today, -100), source: "campus", campaign: "campus-leipzig", visits: 500, storeClicks: 100 },
    // Nobody registered these
    { day: today, source: "instagram", campaign: "creator-lena", visits: 8 },
    { day: today, source: "einladung", campaign: "invite-abcd2345", visits: 4 },
  ]);
  await WaitlistEntry.create([
    { email: "a@example.com", code: "AAAA2345", token: "a".repeat(48), status: "confirmed", confirmedAt: now, campaign: "Campus-Leipzig" },
    { email: "b@example.com", code: "BBBB2345", token: "b".repeat(48), status: "pending", campaign: "campus-leipzig" },
    { email: "c@example.com", code: "CCCC2345", token: "c".repeat(48), status: "confirmed", confirmedAt: now, campaign: "invite-ABCD2345" },
  ]);
  await MarketingSpend.create([
    { day: today, week: today, provider: "anthropic", purpose: "plan", campaign: "campus-leipzig", estimateEur: 2, costEur: 1.5, status: "settled" },
    { day: today, week: today, provider: "google", purpose: "video-clip", campaign: "campus-leipzig", estimateEur: 0.5, status: "reserved" },
    { day: today, week: today, provider: "google", purpose: "video-clip", campaign: "campus-leipzig", estimateEur: 9, status: "released" },
  ]);
  const signup = new Date(now.getTime() - 20 * DAY);
  const person = (phone, acquisition, firstTalkAt = null) =>
    User.create({ _id: idAt(signup), phone, phoneHash: User.hashPhone(phone), acquisition: { at: signup, ...acquisition }, milestones: { firstTalkAt } });
  await person(ANNA, { source: "flyer", campaign: "campus-leipzig" }, new Date(signup.getTime() + 2 * DAY));
  await person(BEN, { source: "friend", campaign: "campus-leipzig" }, new Date(signup.getTime() + 9 * DAY));
  await person(CARL, { source: "flyer", campaign: "flyer-mensa" });

  const list = (await request(ctx.app).get("/admin/campaigns").set(admin(owner)).expect(200)).body;
  assert.deepEqual(list.campaigns.map((c) => c.slug), ["campus-leipzig", "tiktok-herbst"], "running first");
  assert.deepEqual(list.campaigns[0].numbers, { visits: 40, storeClicks: 15, waitlist: 1, users: 2, activatedD7: 1, spendEurCents: 200 });
  assert.deepEqual(list.campaigns[1].numbers, { visits: 0, storeClicks: 0, waitlist: 0, users: 0, activatedD7: 0, spendEurCents: 0 });
  assert.deepEqual(list.unregistered, [
    { slug: "creator-lena", visits: 8, waitlist: 0, users: 0 },
    { slug: "flyer-mensa", visits: 0, waitlist: 0, users: 1 },
  ]);
  assert.equal(list.seedCampaign, null);
});

test("metrics: computeDay counts the day's sign-ups by source and campaign, with the mean androidFriends", async () => {
  const now = new Date();
  const at = new Date(now.getTime() - 60 * 1000);
  const make = (phone, acquisition) => User.create({ _id: idAt(at), phone, phoneHash: User.hashPhone(phone), ...(acquisition ? { acquisition: { at, ...acquisition } } : {}) });
  await make(ANNA, { source: "friend", androidFriends: 1, code: "ABCD2345" });
  await make(BEN, { source: "tiktok", androidFriends: 4, campaign: "tiktok-herbst" });
  await make(CARL, { source: "tiktok", campaign: "tiktok-herbst" });
  await make("+4915444444444", null);
  const day = await computeDay(todayKey(now), now);
  assert.equal(day.version, METRICS_VERSION);
  assert.deepEqual(day.growth.bySource, { friend: 1, tiktok: 2, instagram: 0, flyer: 0, press: 0, other: 0, none: 1 });
  assert.deepEqual(day.growth.byCampaign, { "tiktok-herbst": { new: 2 } });
  assert.equal(day.growth.androidFriendsAvg, 2.5);

  await User.deleteMany({});
  const empty = await computeDay(todayKey(now), now);
  assert.deepEqual(empty.growth.bySource, { friend: 0, tiktok: 0, instagram: 0, flyer: 0, press: 0, other: 0, none: 0 });
  assert.deepEqual(empty.growth.byCampaign, {});
  assert.equal(empty.growth.androidFriendsAvg, null);
});

test("metrics: activation per source counts only closed windows, with the sample; GET /admin/metrics/acquisition", async () => {
  const now = new Date();
  const signup = new Date(dayStart(shiftDateKey(weekKey(now, "Europe/Berlin"), -14)).getTime() + HOUR);
  const make = (phone, source, talkAfterDays, extra = {}) =>
    User.create({
      _id: idAt(signup),
      phone,
      phoneHash: User.hashPhone(phone),
      ...(source ? { acquisition: { at: signup, source, androidFriends: extra.androidFriends ?? null } } : {}),
      milestones: { firstTalkAt: talkAfterDays == null ? null : new Date(signup.getTime() + talkAfterDays * DAY) },
    });
  await make(ANNA, "friend", 1, { androidFriends: 2 });
  await make(BEN, "friend", 8);
  await make(CARL, "tiktok", null, { androidFriends: 0 });
  await make("+4915444444444", null, 3);

  const result = await activationBySource(4, now);
  assert.equal(result.minSample, 50);
  assert.deepEqual(result.bySource.friend, { size: 2, measured: 2, activated: 1, pct: 50 });
  assert.deepEqual(result.bySource.tiktok, { size: 1, measured: 1, activated: 0, pct: 0 });
  assert.deepEqual(result.bySource.none, { size: 1, measured: 1, activated: 1, pct: 100 });
  assert.deepEqual(result.bySource.press, { size: 0, measured: 0, activated: 0, pct: null });

  const viewer = await roleCookie("viewer");
  const res = (await request(ctx.app).get("/admin/metrics/acquisition").set("Cookie", viewer).expect(200)).body;
  assert.equal(res.weeks, 4);
  assert.deepEqual(res.bySource.friend, result.bySource.friend);
  assert.equal(res.last30.total, 4);
  assert.equal(res.last30.answered, 3);
  assert.equal(res.last30.bySource.friend, 2);
  assert.equal(res.last30.androidFriendsAvg, 1);
  assert.equal(res.last30.androidFriendsAnswers, 2);
  await request(ctx.app).get("/admin/metrics/acquisition").expect(401);
});
