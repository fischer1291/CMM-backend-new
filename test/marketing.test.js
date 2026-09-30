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
