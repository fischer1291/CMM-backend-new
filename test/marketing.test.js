const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const AdDraft = require("../models/AdDraft");
const marketing = require("../lib/marketing");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
const uploads = [];
before(async () => {
  process.env.MARKETING_AGENT_KEY = "agent-key-for-tests-0123456789";
  marketing.setUploader(async (buffer, publicId) => {
    uploads.push({ bytes: buffer.length, publicId });
    return { url: `https://res.cloudinary.com/testcloud/video/upload/v1/marketing/${publicId}.mp4`, publicId: `marketing/${publicId}`, bytes: buffer.length };
  });
  ctx = await setup();
});
after(async () => {
  delete process.env.MARKETING_AGENT_KEY;
  await teardown();
});
beforeEach(async () => {
  await reset();
  uploads.length = 0;
  fakes.mails.length = 0;
});

const AGENT = { Authorization: "Bearer agent-key-for-tests-0123456789" };
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });

async function ownerCookie() {
  const who = { email: "owner@example.com", password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ ...who, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}

const DRAFT = {
  campaign: "yap-0928-oma-sonntag",
  template: "chat",
  title: "Oma am Sonntag",
  idea: "Familien-Hook, weil empfehlung gut konvertiert",
  content: { hook: "Wann hast du Oma zuletzt angerufen?", bubbles: [{ from: "me", text: "Sonntag?" }] },
  seconds: 13,
  captions: { instagram: "Ruf an, wenn’s passt.", tiktok: "POV: Oma hat Zeit" },
  hashtags: ["#familie", "telefonieren", "not a tag!"],
  model: "claude-opus-5",
};
// Smallest thing that looks like an MP4: "ftyp" at offset 4
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4000)]);

async function draftWithVideo(overrides = {}) {
  const created = await request(ctx.app).post("/marketing/drafts").set(AGENT).send({ ...DRAFT, ...overrides }).expect(201);
  await request(ctx.app).put(`/marketing/drafts/${created.body.draft.id}/video`).set(AGENT).set("Content-Type", "video/mp4").send(MP4).expect(200);
  return created.body.draft;
}

test("agent: music style and TikTok sound tip are kept, shown and go back into its context", async () => {
  const draft = await draftWithVideo({
    music: { style: "house" },
    sound: { title: "  Espresso (sped up) ", artist: "Beispiel", commercial: true, why: "hell, Sommer", extra: "<b>x</b>" },
  });
  assert.deepEqual(draft.music, { style: "house" });
  assert.deepEqual(draft.sound, { title: "Espresso (sped up)", artist: "Beispiel", commercial: true, why: "hell, Sommer" });

  // Nothing odd gets in: unknown shapes are dropped, an empty title means no tip
  const plain = await draftWithVideo({ campaign: "yap-0928-ohne-sound", music: { style: "House Music!" }, sound: { title: " ", commercial: "yes" } });
  assert.equal(plain.music, null);
  assert.equal(plain.sound, null);
  const odd = await draftWithVideo({ campaign: "yap-0928-komisch", music: "trap", sound: "Espresso" });
  assert.equal(odd.music, null);
  assert.equal(odd.sound, null);

  const cookie = await ownerCookie();
  const listed = (await request(ctx.app).get("/admin/marketing/drafts").set(admin(cookie)).expect(200)).body.drafts;
  assert.equal(listed.find((d) => d.id === draft.id).sound.title, "Espresso (sped up)");

  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  const mine = context.drafts.find((d) => d.campaign === DRAFT.campaign);
  assert.deepEqual(mine.music, { style: "house" });
  assert.equal(mine.sound.commercial, true);
  assert.equal(context.drafts.find((d) => d.campaign === "yap-0928-ohne-sound").sound, null);
});

test("agent: story drafts are accepted and hero episodes come back on their own", async () => {
  const story = await draftWithVideo({ campaign: "yap-0930-story", template: "story", content: { blocks: [{ type: "text", text: "Hook" }] }, seconds: 27.5 });
  assert.equal(story.template, "story");
  await draftWithVideo({ campaign: "yap-0930-anna-1", template: "hero", kind: "hero", episode: "Anna packt.", content: { series: "anna", shots: [] } });
  // More app videos than the recent list holds: the episode stays in `heroes`
  for (let i = 0; i < 41; i++) await draftWithVideo({ campaign: `yap-0930-app-${i}` });
  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  assert.equal(context.drafts.length, 40);
  assert.ok(!context.drafts.some((d) => d.kind === "hero"));
  assert.deepEqual(context.heroes.map((d) => d.campaign), ["yap-0930-anna-1"]);
  assert.equal(context.heroes[0].content.series, "anna");
  assert.equal(context.heroes[0].episode, "Anna packt.");
});

test("agent: needs its key, creates drafts, uploads the video once", async () => {
  await request(ctx.app).get("/marketing/context").expect(401);
  await request(ctx.app).get("/marketing/context").set({ Authorization: "Bearer wrong" }).expect(401);
  await request(ctx.app).post("/marketing/drafts").send(DRAFT).expect(401);

  await request(ctx.app).post("/marketing/drafts").set(AGENT).send({ ...DRAFT, campaign: "Nicht OK!" }).expect(400);
  await request(ctx.app).post("/marketing/drafts").set(AGENT).send({ ...DRAFT, template: "html" }).expect(400);
  const created = await request(ctx.app).post("/marketing/drafts").set(AGENT).send(DRAFT).expect(201);
  const { draft } = created.body;
  assert.equal(draft.status, "rendering");
  assert.deepEqual(draft.hashtags, ["familie", "telefonieren"]);
  assert.equal(draft.links.tiktok, "https://wannayap.app/?utm_source=tiktok&utm_campaign=yap-0928-oma-sonntag");
  await request(ctx.app).post("/marketing/drafts").set(AGENT).send(DRAFT).expect(409);

  const url = `/marketing/drafts/${draft.id}/video`;
  await request(ctx.app).put(url).set(AGENT).set("Content-Type", "video/mp4").send(Buffer.alloc(4000)).expect(400);
  const uploaded = await request(ctx.app).put(url).set(AGENT).set("Content-Type", "video/mp4").send(MP4).expect(200);
  assert.equal(uploaded.body.draft.status, "pending");
  assert.match(uploaded.body.draft.downloadUrl, /\/video\/upload\/fl_attachment:yap-0928-oma-sonntag\//);
  assert.deepEqual(uploads, [{ bytes: MP4.length, publicId: "yap-0928-oma-sonntag" }]);
  await request(ctx.app).put(url).set(AGENT).set("Content-Type", "video/mp4").send(MP4).expect(400);

  // Without a key on the server nobody gets in
  const key = process.env.MARKETING_AGENT_KEY;
  delete process.env.MARKETING_AGENT_KEY;
  await request(ctx.app).get("/marketing/context").set(AGENT).expect(401);
  process.env.MARKETING_AGENT_KEY = key;
});

test("console: owners approve or reject, the agent sees decisions and reasons, posted per platform", async () => {
  const cookie = await ownerCookie();
  const first = await draftWithVideo();
  const second = await draftWithVideo({ campaign: "yap-0928-kein-feed", template: "list" });
  // A draft still rendering is not shown yet
  await request(ctx.app).post("/marketing/drafts").set(AGENT).send({ ...DRAFT, campaign: "yap-0928-halb" }).expect(201);

  const notified = await request(ctx.app).post("/marketing/notify").set(AGENT).expect(200);
  assert.equal(notified.body.pending, 2);
  assert.equal(notified.body.mailed, 1);
  assert.match(fakes.mails.at(-1).subject, /2 Werbevideos warten/);

  await request(ctx.app).get("/admin/marketing/drafts").expect(401);
  const listed = (await request(ctx.app).get("/admin/marketing/drafts").set(admin(cookie)).expect(200)).body;
  assert.equal(listed.drafts.length, 2);
  assert.equal(listed.counts.pending, 2);

  const decide = (id, body) => request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send(body);
  await decide(first.id, { action: "publish" }).expect(400);
  await decide(first.id, { action: "approve" }).expect(200);
  await decide(first.id, { action: "reject" }).expect(409);
  await decide(second.id, { action: "reject", feedback: "Zu viel Text, keiner liest vier Zeilen" }).expect(200);

  const posted = (platform, posted = true) =>
    request(ctx.app).post(`/admin/marketing/drafts/${first.id}/posted`).set(admin(cookie)).send({ platform, posted });
  await request(ctx.app).post(`/admin/marketing/drafts/${second.id}/posted`).set(admin(cookie)).send({ platform: "tiktok" }).expect(409);
  await posted("youtube").expect(400);
  assert.equal((await posted("tiktok").expect(200)).body.draft.status, "posted");
  assert.equal((await posted("tiktok", false).expect(200)).body.draft.status, "approved");
  await posted("instagram").expect(200);

  // Out on Instagram and nothing left to do: it moves from Freigegeben to Gepostet
  const approved = (await request(ctx.app).get("/admin/marketing/drafts?status=approved").set(admin(cookie)).expect(200)).body;
  assert.deepEqual(approved.drafts, []);
  const done = (await request(ctx.app).get("/admin/marketing/drafts?status=posted").set(admin(cookie)).expect(200)).body;
  assert.deepEqual(done.drafts.map((d) => d.campaign), ["yap-0928-oma-sonntag"]);
  assert.equal(done.drafts[0].stage, "posted");
  assert.ok(done.drafts[0].postedAt);
  assert.deepEqual(done.drafts[0].visits, { visits: 0, submitted: 0 });
  assert.equal(done.counts.approved, 0);
  assert.equal(done.counts.posted, 1);
  assert.equal(done.counts.rejected, 1);

  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  assert.equal(context.visits.byDay.length, 30);
  const rejected = context.drafts.find((d) => d.campaign === "yap-0928-kein-feed");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.feedback, "Zu viel Text, keiner liest vier Zeilen");
  assert.ok(!context.drafts.some((d) => d.campaign === "yap-0928-halb"));
  assert.equal(await AdDraft.countDocuments({ status: "rendering" }), 1);
});

test("console tabs: a video stays under Freigegeben until every platform is out, left out or never meant", () => {
  const d = (publish, posted = {}) => ({ status: "approved", publish, posted });
  const at = new Date();
  // Waiting for its slot, nothing out yet
  assert.equal(marketing.stage(d({ instagram: { status: "scheduled" }, tiktok: { status: "scheduled" } })), "approved");
  // Out on Instagram, the TikTok draft still waits in the app
  assert.equal(marketing.stage({ ...d({ instagram: { status: "posted" }, tiktok: { status: "inbox" } }, { instagram: at }), status: "posted" }), "approved");
  // ... and published there by hand: done
  assert.equal(marketing.stage({ ...d({ instagram: { status: "posted" }, tiktok: { status: "inbox" } }, { instagram: at, tiktok: at }), status: "posted" }), "posted");
  // Out on Instagram, TikTok failed: still to look at; left out: done
  assert.equal(marketing.stage({ ...d({ instagram: { status: "posted" }, tiktok: { status: "failed" } }, { instagram: at }), status: "posted" }), "approved");
  assert.equal(marketing.stage({ ...d({ instagram: { status: "posted" }, tiktok: { status: "skipped" } }, { instagram: at }), status: "posted" }), "posted");
  // Approved without channels and not posted by hand yet: still to do
  assert.equal(marketing.stage(d({ instagram: {}, tiktok: {} })), "approved");
  // Out on Instagram before TikTok was connected: done, not brought back
  assert.equal(marketing.stage({ ...d({ instagram: { status: "posted" }, tiktok: { status: null } }, { instagram: at }), status: "posted" }), "posted");
  assert.equal(marketing.stage({ status: "pending" }), "pending");
  assert.equal(marketing.stage({ status: "rejected" }), "rejected");
});

test("console: leave a platform out; posted videos list their visits", async () => {
  const cookie = await ownerCookie();
  const draft = await draftWithVideo();
  await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/skip`).set(admin(cookie)).send({ platform: "tiktok" }).expect(409);
  await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200);
  await AdDraft.updateOne({ _id: draft.id }, { "publish.instagram.status": "posted", "posted.instagram": new Date(), "publish.tiktok.status": "failed", "publish.tiktok.error": "spam_risk", status: "posted" });
  const tabs = async (tab) => (await request(ctx.app).get(`/admin/marketing/drafts?status=${tab}`).set(admin(cookie)).expect(200)).body;
  assert.deepEqual((await tabs("approved")).drafts.map((d) => d.id), [draft.id]);

  await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/skip`).set(admin(cookie)).send({ platform: "youtube" }).expect(400);
  await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/skip`).set(admin(cookie)).send({ platform: "instagram" }).expect(409);
  const skipped = (await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/skip`).set(admin(cookie)).send({ platform: "tiktok" }).expect(200)).body.draft;
  assert.equal(skipped.publish.tiktok.status, "skipped");
  assert.equal(skipped.stage, "posted");

  const LandingVisit = require("../models/LandingVisit");
  await LandingVisit.create({ day: "2026-09-29", source: "instagram", campaign: DRAFT.campaign, visits: 7, submitted: 1 });
  await LandingVisit.create({ day: "2026-09-30", source: "tiktok", campaign: DRAFT.campaign, visits: 3 });
  const posted = await tabs("posted");
  assert.deepEqual(posted.drafts.map((d) => d.id), [draft.id]);
  assert.deepEqual(posted.drafts[0].visits, { visits: 10, submitted: 1 });
  assert.equal(posted.counts.approved, 0);
  assert.equal(posted.counts.posted, 1);
  assert.deepEqual((await tabs("approved")).drafts, []);
});

test("console: viewers may look but not decide", async () => {
  await ownerCookie();
  const draft = await draftWithVideo();
  const Admin = require("../models/Admin");
  const { signSession, COOKIE } = require("../lib/adminAuth");
  const viewer = await Admin.create({ email: "look@example.com", role: "viewer", totpEnabled: true, passwordHash: "x", totpSecret: "x" });
  const viewerCookie = `${COOKIE}=${encodeURIComponent(signSession(viewer))}`;
  await request(ctx.app).get("/admin/marketing/drafts").set(admin(viewerCookie)).expect(200);
  await request(ctx.app).post(`/admin/marketing/drafts/${draft.id}/decision`).set(admin(viewerCookie)).send({ action: "approve" }).expect(403);
});

test("console: owners rewrite captions and hashtags before posting; the agent sees theirs and its own", async () => {
  const cookie = await ownerCookie();
  const { id } = await draftWithVideo();
  const url = `/admin/marketing/drafts/${id}/texts`;
  await request(ctx.app).put(url).set(admin(cookie)).send({ hashtags: "#wannayap #zu viele #a #b #c #d" }).expect(400);
  await request(ctx.app).put(url).set(admin(cookie)).send({ hashtags: ["ok", "nicht ok!"] }).expect(400);
  await request(ctx.app).put(url).set(admin(cookie)).send({ captions: { instagram: "" } }).expect(400);
  const before = await AdDraft.findById(id).lean();

  const edited = (await request(ctx.app)
    .put(url)
    .set(admin(cookie))
    .send({ captions: { instagram: "Neu: ruf einfach an. Link in Bio." }, hashtags: "#WannaYap, #ersti  semesterstart" })
    .expect(200)).body.draft;
  assert.equal(edited.captions.instagram, "Neu: ruf einfach an. Link in Bio.");
  assert.equal(edited.captions.tiktok, before.captions.tiktok, "untouched text stays");
  assert.deepEqual(edited.hashtags, ["wannayap", "ersti", "semesterstart"]);
  assert.equal(edited.edited.by, "owner@example.com");

  // A second edit keeps the agent's original
  await request(ctx.app).put(url).set(admin(cookie)).send({ captions: { tiktok: "kurz und neu" } }).expect(200);
  const ctxRes = await request(ctx.app).get("/marketing/context").set(AGENT).expect(200);
  const seen = ctxRes.body.drafts.find((d) => d.title === DRAFT.title).edited;
  assert.equal(seen.before.captions.instagram, before.captions.instagram);
  assert.deepEqual(seen.before.hashtags, before.hashtags);
  assert.equal(seen.captions.tiktok, "kurz und neu");

  // Once it is out, the texts stay
  await AdDraft.updateOne({ _id: id }, { status: "approved", "publish.instagram.status": "posted" });
  await request(ctx.app).put(url).set(admin(cookie)).send({ captions: { tiktok: "zu spät" } }).expect(409);
});

test("agent: the owner's notes from the Monday review reach its context (plan 2.11)", async () => {
  const cookie = await ownerCookie();
  const { saveConfig, MAX_MARKETING_NOTES } = require("../lib/appConfig");
  assert.equal((await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.notes, null);

  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ marketingNotes: "  Hook-Thema: Erstis, die sich nicht trauen anzurufen  " }).expect(200);
  assert.equal((await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.notes, "Hook-Thema: Erstis, die sich nicht trauen anzurufen");
  // The console sees them, the app never
  assert.equal((await request(ctx.app).get("/admin/config").set(admin(cookie)).expect(200)).body.config.marketingNotes, "Hook-Thema: Erstis, die sich nicht trauen anzurufen");
  assert.equal((await request(ctx.app).get("/app-config").expect(200)).body.marketingNotes, undefined);

  assert.equal((await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ marketingNotes: "x".repeat(MAX_MARKETING_NOTES + 1) }).expect(400)).body.error, "invalid_marketing_notes");
  assert.equal((await saveConfig({ marketingNotes: 42 }, "owner@example.com")).error, "invalid_marketing_notes");
  assert.equal((await saveConfig({ marketingNotes: "x".repeat(MAX_MARKETING_NOTES) }, "owner@example.com")).error, undefined);
  // null or an empty text clears them
  assert.equal((await saveConfig({ marketingNotes: "   " }, "owner@example.com")).error, undefined);
  assert.equal((await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.notes, null);
  await saveConfig({ marketingNotes: "Budget halten" }, "owner@example.com");
  await saveConfig({ marketingNotes: null }, "owner@example.com");
  assert.equal((await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.notes, null);
});

// --- Plan 2.14: performance back into the agent, bio link, failure report ------------

test("agent: hook variants are checked, trimmed, kept and shown in the console and its context", async () => {
  const cookie = await ownerCookie();
  const bad = async (hookVariants) =>
    assert.equal((await request(ctx.app).post("/marketing/drafts").set(AGENT).send({ ...DRAFT, campaign: "yap-1001-falsch", hookVariants }).expect(400)).body.error, "invalid_hook_variants");
  await bad("Wann hast du Oma angerufen?");
  await bad([42]);
  await bad(["gut", null]);
  await bad({ 0: "eins" });
  assert.equal(await AdDraft.countDocuments({ campaign: "yap-1001-falsch" }), 0);
  // Lenient on length and count: the video is already rendered (and paid for) when it arrives
  assert.deepEqual((await draftWithVideo({ campaign: "yap-1001-lang", hookVariants: ["", "  ", "x".repeat(130), "zwei", "drei"] })).hookVariants, ["x".repeat(120), "zwei"]);
  await AdDraft.deleteMany({ campaign: "yap-1001-lang" });

  const draft = await draftWithVideo({ hookVariants: ["  Oma wartet nicht ewig.  ", "x".repeat(120)] });
  assert.deepEqual(draft.hookVariants, ["Oma wartet nicht ewig.", "x".repeat(120)]);
  const listed = (await request(ctx.app).get("/admin/marketing/drafts").set(admin(cookie)).expect(200)).body.drafts[0];
  assert.deepEqual(listed.hookVariants, ["Oma wartet nicht ewig.", "x".repeat(120)]);
  assert.equal(listed.stats, null, "nothing measured yet");
  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  assert.deepEqual(context.drafts[0].hookVariants, ["Oma wartet nicht ewig.", "x".repeat(120)]);
  // Without variants: an empty list
  assert.deepEqual((await draftWithVideo({ campaign: "yap-1001-ohne" })).hookVariants, []);
});

test("agent context: top and flop by views per euro with new users per slug, AI euros per posted video, bio link, runs", async () => {
  const User = require("../models/User");
  const MarketingSpend = require("../models/MarketingSpend");
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 3600 * 1000);
  const ig = (plays, at = daysAgo(0)) => ({ plays, reach: plays, likes: Math.round(plays / 10), shares: 2, saved: 1, comments: 1, at });
  const posted = (campaign, { stats, costEur = null, ago = 3, platform = "instagram" } = {}) =>
    AdDraft.create({ campaign, title: campaign, template: "chat", status: "posted", costEur, stats, posted: { [platform]: daysAgo(ago) } });
  // Views per euro: a 1000/2 = 500, b (3000 + TikTok 1000)/4 = 1000, c 100/1 = 100, d 600/3 = 200, e 50/5 = 10
  await posted("yap-a", { stats: { instagram: ig(1000) }, costEur: 2 });
  await posted("yap-b", { stats: { instagram: ig(3000), tiktok: { views: 1000, likes: 50, comments: 2, shares: 9, at: daysAgo(0) } }, costEur: 9 });
  await posted("yap-c", { stats: { instagram: ig(100) }, costEur: 1 });
  await posted("yap-d", { stats: { instagram: ig(600) }, costEur: 3 });
  await posted("yap-e", { stats: { tiktok: { views: 50, likes: 1, comments: 0, shares: 0, at: daysAgo(0) } }, costEur: 5, platform: "tiktok" });
  // Not ranked: no numbers yet, no cost, posted too long ago
  await posted("yap-ohne-zahlen", { costEur: 2 });
  await posted("yap-ohne-kosten", { stats: { instagram: ig(5000) } });
  await posted("yap-alt", { stats: { instagram: ig(90000) }, costEur: 1, ago: 40 });
  // b's AI spend under its campaign wins over the draft's own costEur (9): 3 settled + 1 reserved
  await MarketingSpend.create([
    { day: "2026-10-01", week: "2026-09-28", provider: "anthropic", purpose: "plan", campaign: "yap-b", estimateEur: 2.5, costEur: 3, status: "settled" },
    { day: "2026-10-01", week: "2026-09-28", provider: "google", purpose: "video-clip", campaign: "yap-b", estimateEur: 1, status: "reserved" },
    { day: "2026-10-01", week: "2026-09-28", provider: "google", purpose: "video-clip", campaign: "yap-b", estimateEur: 7, status: "released" },
    { day: "2026-10-01", week: "2026-09-28", provider: "anthropic", purpose: "plan", estimateEur: 2, costEur: 2, status: "settled" },
    // Paid reach (plan 2.7) is not an AI cost of the videos, neither overall nor under a campaign
    { day: "2026-10-01", week: "2026-09-28", provider: "media", purpose: "boost", estimateEur: 50, costEur: 50, status: "settled" },
    { day: "2026-10-01", week: "2026-09-28", provider: "media", purpose: "boost", campaign: "yap-b", estimateEur: 20, costEur: 20, status: "settled" },
  ]);
  // Two sign-ups from a's link, one of them talked within 7 days
  await User.create({ phone: "+491701000001", phoneHash: User.hashPhone("+491701000001"), acquisition: { at: daysAgo(2), campaign: "yap-a" }, milestones: { firstTalkAt: daysAgo(1) } });
  await User.create({ phone: "+491701000002", phoneHash: User.hashPhone("+491701000002"), acquisition: { at: daysAgo(2), campaign: "yap-a" } });

  const context = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body;
  const { top, flop } = context.performance;
  assert.deepEqual(top.map((r) => r.campaign), ["yap-b", "yap-a", "yap-d"]);
  assert.deepEqual(flop.map((r) => r.campaign), ["yap-e", "yap-c"], "worst first, none in both");
  const b = top[0];
  assert.equal(b.views, 4000);
  assert.equal(b.costEur, 4);
  assert.equal(b.viewsPerEur, 1000);
  assert.equal(b.likes, 350);
  assert.equal(b.kind, "app");
  assert.equal(b.template, "chat");
  assert.deepEqual([top[1].newUsers, top[1].activatedD7], [2, 1]);
  assert.deepEqual([b.newUsers, b.activatedD7], [0, 0]);
  // 30 days of AI spend: 3 + 1 + 2 = 6 € over 7 videos posted in that time (media left out)
  assert.equal(context.aiCostPerPostedVideoEur, 0.86);
  assert.match(context.bioLink, /^https:\/\/wannayap\.app\/k\/bio-\d{4}-w\d{2}$/);
  assert.equal(context.bioLink, marketing.bioLink());
  assert.deepEqual(context.runs, { lastRunAt: null, lastOkAt: null, lastFailedAt: null, lastStep: null, lastDurationSec: null });

  // More than 20 measured: ten each (these make 10 to 200 views per euro)
  for (let i = 0; i < 20; i++) await posted(`yap-viele-${String(i).padStart(2, "0")}`, { stats: { instagram: ig(100 * (i + 1)) }, costEur: 10 });
  const many = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.performance;
  assert.equal(many.top.length, 10);
  assert.equal(many.flop.length, 10);
  assert.equal(many.top[0].campaign, "yap-b");
  assert.equal(many.flop[0].campaign, "yap-e");
});

test("notify: a run that went through sets lastOkAt; a failed one raises agent_failed with step and link, never an error text", async () => {
  const AlertState = require("../models/AlertState");
  const opsCounters = require("../lib/opsCounters");
  const { localParts } = require("../lib/localTime");
  const cookie = await ownerCookie();
  await request(ctx.app).post("/marketing/notify").send({ failed: true }).expect(401);

  const ok = await request(ctx.app).post("/marketing/notify").set(AGENT).send({ durationSec: 312.4 }).expect(200);
  assert.deepEqual(ok.body, { success: true, pending: 0, mailed: 0 });
  let runs = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.runs;
  assert.ok(runs.lastOkAt);
  assert.equal(runs.lastRunAt, runs.lastOkAt);
  assert.equal(runs.lastFailedAt, null);
  assert.equal(runs.lastDurationSec, 312);
  assert.equal(await AlertState.countDocuments({ tag: "agent_failed" }), 0);

  fakes.mails.length = 0;
  const runUrl = "https://github.com/fischer1291/CMM/actions/runs/123456";
  const failed = await request(ctx.app)
    .post("/marketing/notify")
    .set(AGENT)
    .send({ failed: true, step: "hero", runUrl, error: "Anthropic 529: geheimer Stacktrace", message: "geheimer Stacktrace" })
    .expect(200);
  assert.deepEqual(failed.body, { success: true, alerted: true });
  const state = await AlertState.findOne({ tag: "agent_failed" }).lean();
  assert.equal(state.level, "warn");
  assert.match(state.lastText, /Schritt „hero“/);
  assert.ok(state.lastText.includes(runUrl));
  assert.doesNotMatch(state.lastText, /geheim|529/);
  assert.equal(fakes.mails.length, 1);
  assert.equal(fakes.mails[0].subject, "[Wanna yap?] Marketing-Agent fehlgeschlagen");
  assert.doesNotMatch(fakes.mails[0].text, /geheim/);
  runs = (await request(ctx.app).get("/marketing/context").set(AGENT).expect(200)).body.runs;
  assert.ok(runs.lastFailedAt);
  assert.equal(runs.lastStep, "hero");
  assert.ok(new Date(runs.lastOkAt) < new Date(runs.lastFailedAt), "the last good run stays");
  assert.equal(runs.lastDurationSec, 312, "a failure without duration keeps the last one");

  // A link outside github.com and odd characters in the step are left out (two hours later: past the debounce)
  const later = new Date(Date.now() + 2 * 3600 * 1000);
  assert.deepEqual(await marketing.reportRun({ failed: true, step: "<daily>\n", runUrl: "https://evil.example/runs/1" }, later), { alerted: true });
  const second = await AlertState.findOne({ tag: "agent_failed" }).lean();
  assert.match(second.lastText, /Schritt „daily“/);
  assert.doesNotMatch(second.lastText, /evil/);
  assert.match(second.lastText, /GitHub → Actions → marketing-agent/);
  // failed must be true itself: "true" as text is a run that went through
  assert.equal((await marketing.reportRun({ failed: "true" }, later)).pending, 0);

  // Day counters: two runs through (one counted at `later`), two failed
  const days = [...new Set([new Date(), later].map((d) => localParts(d, "Europe/Berlin").dateKey))];
  const counts = await Promise.all(days.map((d) => opsCounters.countsOf(d)));
  const total = (name) => counts.reduce((sum, c) => sum + (c[name] || 0), 0);
  assert.equal(total("agentRunsOk"), 2);
  assert.equal(total("agentRunsFailed"), 2);

  const overview = (await request(ctx.app).get("/admin/marketing/agent").set(admin(cookie)).expect(200)).body;
  assert.equal(overview.runs.lastStep, "daily");
  assert.equal(overview.runs.lastRunUrl, runUrl, "only a valid link replaces the last one");
  assert.equal(overview.bioLink, marketing.bioLink());
  assert.match(overview.bioSlug, /^bio-\d{4}-w\d{2}$/);
  assert.equal(overview.aiCostPerPostedVideoEur, null, "nothing posted");
  await request(ctx.app).get("/admin/marketing/agent").expect(401);
});

test("bio link: this week's campaign is created once per week, last week's ends", async () => {
  const Campaign = require("../models/Campaign");
  // Monday 5 October 2026, 10:00 Berlin: ISO week 41
  const monday = new Date("2026-10-05T08:00:00Z");
  assert.equal(marketing.bioLink(monday), "https://wannayap.app/k/bio-2026-w41");
  assert.deepEqual(await marketing.ensureBioCampaign(monday), { slug: "bio-2026-w41", created: true, ended: 0 });
  assert.deepEqual(await marketing.ensureBioCampaign(new Date("2026-10-08T12:00:00Z")), { slug: "bio-2026-w41", created: false, ended: 0 });
  const c = await Campaign.findOne({ slug: "bio-2026-w41" }).lean();
  assert.equal(c.channel, "other");
  assert.equal(c.title, "Bio-Link KW 41");
  assert.equal(c.status, "running");
  assert.equal(c.startedAt.toISOString(), "2026-10-04T22:00:00.000Z", "Monday 00:00 Berlin");
  assert.equal(c.endedAt.toISOString(), "2026-10-11T22:00:00.000Z");
  // Sunday night Berlin still belongs to week 41
  assert.equal((await marketing.ensureBioCampaign(new Date("2026-10-11T21:30:00Z"))).created, false);

  assert.deepEqual(await marketing.ensureBioCampaign(new Date("2026-10-12T00:30:00Z")), { slug: "bio-2026-w42", created: true, ended: 1 });
  assert.equal((await Campaign.findOne({ slug: "bio-2026-w41" }).lean()).status, "ended");
  assert.equal(await Campaign.countDocuments({ slug: /^bio-/ }), 2);
  // A single-digit week keeps two digits; New Year's Day 2027 is in 2026's week 53
  assert.equal(marketing.bioLink(new Date("2027-01-01T12:00:00Z")), "https://wannayap.app/k/bio-2026-w53");
  assert.equal(marketing.bioLink(new Date("2027-02-03T12:00:00Z")), "https://wannayap.app/k/bio-2027-w05");
});
