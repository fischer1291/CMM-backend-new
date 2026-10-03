const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const AdDraft = require("../models/AdDraft");
const MarketingChannel = require("../models/MarketingChannel");
const marketing = require("../lib/marketing");
const posting = require("../lib/socialPosting");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
const realFetch = global.fetch;
let calls = [];
// Fake Instagram, TikTok and Cloudinary; each test sets what they answer
let fake = {};
function installFetch() {
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (!["graph.instagram.com", "open.tiktokapis.com", "res.cloudinary.com", "upload.tiktok.test"].includes(u.hostname)) return realFetch(url, opts);
    const body = opts.body ? (typeof opts.body === "string" ? opts.body : `<${opts.body.length} bytes>`) : null;
    calls.push({ method: opts.method || "GET", host: u.hostname, path: u.pathname, query: u.search, body, headers: opts.headers || {} });
    const answer = (fake[`${opts.method || "GET"} ${u.pathname}`] || fake[u.pathname] || (() => ({ status: 404, json: { error: { message: "not faked" } } })))(u, body);
    const { status = 200, json, bytes } = answer;
    return new Response(bytes || JSON.stringify(json), { status, headers: { "Content-Type": bytes ? "video/mp4" : "application/json" } });
  };
}

before(async () => {
  process.env.MARKETING_AGENT_KEY = "agent-key-for-tests-0123456789";
  process.env.TIKTOK_CLIENT_KEY = "tt-client";
  process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
  posting.timing.pollMs = 1;
  posting.timing.polls = 3;
  marketing.setUploader(async (buffer, publicId) => ({ url: `https://res.cloudinary.com/testcloud/video/upload/v1/marketing/${publicId}.mp4`, publicId, bytes: buffer.length }));
  installFetch();
  ctx = await setup();
});
after(async () => {
  global.fetch = realFetch;
  for (const k of ["MARKETING_AGENT_KEY", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) delete process.env[k];
  await teardown();
});
beforeEach(async () => {
  await reset();
  calls = [];
  fake = {
    "/testcloud/video/upload/v1/marketing/yap-0929-anna.mp4": () => ({ bytes: Buffer.alloc(5000, 1) }),
  };
});

const AGENT = { Authorization: "Bearer agent-key-for-tests-0123456789" };
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
async function ownerCookie() {
  const who = { email: "owner@example.com", password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4000)]);
async function heroDraft() {
  const created = await request(ctx.app)
    .post("/marketing/drafts")
    .set(AGENT)
    .send({ campaign: "yap-0929-anna", kind: "hero", template: "hero", title: "Anna", content: { shots: [] }, captions: { instagram: "Ruf an. Link in Bio.\n\nSzenen mit KI erstellt.", tiktok: "wer kennt's" }, hashtags: ["wannayap", "ersti"] })
    .expect(201);
  await request(ctx.app).put(`/marketing/drafts/${created.body.draft.id}/video`).set(AGENT).set("Content-Type", "video/mp4").send(MP4).expect(200);
  return created.body.draft.id;
}

function fakeInstagram({ processing = "FINISHED" } = {}) {
  fake["/me"] = (u) => (u.searchParams.get("access_token") === "IGTOKEN-long-lived-0123456789" ? { json: { user_id: "1789", username: "wannayap.app" } } : { status: 400, json: { error: { message: "Invalid OAuth access token" } } });
  fake["POST /1789/media"] = () => ({ json: { id: "container-1" } });
  fake["/container-1"] = () => ({ json: { status_code: processing, status: processing === "ERROR" ? "Video zu lang" : undefined } });
  fake["POST /1789/media_publish"] = () => ({ json: { id: "media-9" } });
  fake["/media-9"] = () => ({ json: { permalink: "https://www.instagram.com/reel/abc/" } });
  fake["/refresh_access_token"] = () => ({ json: { access_token: "IGTOKEN-refreshed-0123456789", expires_in: 5184000 } });
}

function fakeTiktok({ final = "SEND_TO_USER_INBOX", options = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] } = {}) {
  fake["POST /v2/oauth/token/"] = (u, body) => {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good-code") return { json: { error: "invalid_grant", error_description: "bad code" } };
    return { json: { access_token: `tt-access-${form.get("grant_type")}`, expires_in: 86400, refresh_token: "tt-refresh", refresh_expires_in: 31536000, open_id: "open-1", scope: "video.upload,video.publish" } };
  };
  fake["/v2/user/info/"] = () => ({ json: { data: { user: { display_name: "Wanna yap?" } }, error: { code: "ok" } } });
  fake["POST /v2/post/publish/creator_info/query/"] = () => ({ json: { data: { privacy_level_options: options }, error: { code: "ok" } } });
  const init = () => ({ json: { data: { publish_id: "p-1", upload_url: "https://upload.tiktok.test/up?x=1" }, error: { code: "ok" } } });
  fake["POST /v2/post/publish/inbox/video/init/"] = init;
  fake["POST /v2/post/publish/video/init/"] = init;
  fake["PUT /up"] = () => ({ json: {} });
  fake["POST /v2/post/publish/status/fetch/"] = () => ({ json: { data: { status: final, publicaly_available_post_id: final === "PUBLISH_COMPLETE" ? [7401] : [] }, error: { code: "ok" } } });
}

test("slots: next free 12:00 or 18:00 in Berlin, one video per slot, never closer than 10 minutes", async () => {
  // 09:00 Berlin (summer time) → 12:00 Berlin = 10:00 UTC
  const morning = new Date("2026-09-29T07:00:00Z");
  assert.equal((await posting.nextSlot(morning)).toISOString(), "2026-09-29T10:00:00.000Z");
  await AdDraft.create({ campaign: "x-1", title: "x", template: "chat", scheduledAt: new Date("2026-09-29T10:00:00Z") });
  assert.equal((await posting.nextSlot(morning)).toISOString(), "2026-09-29T16:00:00.000Z");
  // 17:55 Berlin: 18:00 is too close, tomorrow 12:00
  assert.equal((await posting.nextSlot(new Date("2026-09-29T15:55:00Z"))).toISOString(), "2026-09-30T10:00:00.000Z");
  // Winter time: 12:00 Berlin = 11:00 UTC
  assert.equal((await posting.nextSlot(new Date("2026-11-02T07:00:00Z"))).toISOString(), "2026-11-02T11:00:00.000Z");
});

test("instagram: token from the console, stored encrypted; approval schedules; the job posts a reel marked as AI", async () => {
  fakeInstagram();
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "wrong-token-0123456789abcdef" }).expect(400);
  const ok = await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  assert.equal(ok.body.channel.username, "wannayap.app");
  const stored = await MarketingChannel.findById("instagram").lean();
  assert.ok(!JSON.stringify(stored).includes("IGTOKEN"), "token is not stored in plain text");
  const status = (await request(ctx.app).get("/admin/marketing/channels").set(admin(cookie)).expect(200)).body;
  assert.equal(status.instagram.connected, true);
  assert.ok(!JSON.stringify(status).includes("IGTOKEN"), "the console never sees the token");

  const id = await heroDraft();
  const approved = (await request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200)).body.draft;
  assert.ok(approved.scheduledAt);
  assert.equal(approved.publish.instagram.status, "scheduled");
  assert.equal(approved.publish.tiktok, null, "TikTok is not connected");

  // Not due yet: nothing happens
  assert.deepEqual(await posting.runDue(new Date(Date.parse(approved.scheduledAt) - 60000)), []);
  const results = await posting.runDue(new Date(Date.parse(approved.scheduledAt) + 1000));
  assert.deepEqual(results.map((r) => [r.platform, r.status]), [["instagram", "posted"]]);
  const create = calls.find((c) => c.method === "POST" && c.path === "/1789/media");
  const form = new URLSearchParams(create.body);
  assert.equal(form.get("media_type"), "REELS");
  assert.equal(form.get("is_ai_generated"), "true");
  assert.match(form.get("caption"), /Szenen mit KI erstellt\.\n\n#wannayap #ersti$/);
  assert.equal(form.get("video_url"), "https://res.cloudinary.com/testcloud/video/upload/v1/marketing/yap-0929-anna.mp4");
  const draft = await AdDraft.findById(id).lean();
  assert.equal(draft.status, "posted");
  assert.ok(draft.posted.instagram);
  assert.equal(draft.publish.instagram.url, "https://www.instagram.com/reel/abc/");
  // Posted once: another run does nothing
  assert.deepEqual(await posting.runDue(new Date(Date.parse(approved.scheduledAt) + 3600000)), []);
});

test("failures are retried up to three times, 15 minutes apart; 'Jetzt posten' starts over", async () => {
  fakeInstagram({ processing: "ERROR" });
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  const id = await heroDraft();
  const { scheduledAt } = (await request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200)).body.draft;
  let t = Date.parse(scheduledAt);
  const first = await posting.runDue(new Date(t));
  assert.equal(first[0].status, "failed");
  assert.match(first[0].error, /Video zu lang/);
  assert.deepEqual(await posting.runDue(new Date(t + 5 * 60000)), [], "waits 15 minutes");
  for (let i = 0; i < 2; i++) {
    t += 16 * 60000;
    assert.equal((await posting.runDue(new Date(t)))[0].status, "failed");
  }
  assert.deepEqual(await posting.runDue(new Date(t + 60 * 60000)), [], "gives up after three attempts");
  assert.equal((await AdDraft.findById(id).lean()).publish.instagram.attempts, 3);

  fakeInstagram();
  await request(ctx.app).post(`/admin/marketing/drafts/${id}/publish-now`).set(admin(cookie)).expect(202);
  await posting.runDue();
  assert.equal((await AdDraft.findById(id).lean()).publish.instagram.status, "posted");
  await request(ctx.app).post(`/admin/marketing/drafts/${id}/publish-now`).set(admin(cookie)).expect(409);
});

test("publish now: a video approved before any channel was connected (no posting status) goes out on the channel connected later", async () => {
  const cookie = await ownerCookie();
  const id = await heroDraft();
  await request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200);
  const before = (await request(ctx.app).get("/admin/marketing/drafts?status=approved").set(admin(cookie)).expect(200)).body.drafts[0];
  assert.equal(before.publish.instagram, null, "nothing scheduled without a channel");
  const none = await request(ctx.app).post(`/admin/marketing/drafts/${id}/publish-now`).set(admin(cookie)).expect(409);
  assert.equal(none.body.error, "nothing_to_post");

  fakeInstagram();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  await request(ctx.app).post(`/admin/marketing/drafts/${id}/publish-now`).set(admin(cookie)).expect(202);
  await posting.runDue();
  const done = (await AdDraft.findById(id).lean()).publish;
  assert.equal(done.instagram.status, "posted");
  assert.equal(done.tiktok.status, null, "TikTok is not connected");
});

test("tiktok: login with signed state, draft into the TikTok app, direct post with AI label, token refresh", async () => {
  fakeTiktok();
  const cookie = await ownerCookie();
  const { url } = (await request(ctx.app).get("/admin/marketing/channels/tiktok/connect").set(admin(cookie)).expect(200)).body;
  const auth = new URL(url);
  assert.equal(auth.searchParams.get("client_key"), "tt-client");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://api.wannayap.app/marketing/tiktok/callback");
  const state = auth.searchParams.get("state");

  const bad = await request(ctx.app).get(`/marketing/tiktok/callback?code=good-code&state=${state.slice(0, -2)}xx`).expect(302);
  assert.match(bad.headers.location, /tiktok=invalid_state/);
  const fail = await request(ctx.app).get(`/marketing/tiktok/callback?code=bad-code&state=${state}`).expect(302);
  assert.match(fail.headers.location, /tiktok=tiktok_failed/);
  const good = await request(ctx.app).get(`/marketing/tiktok/callback?code=good-code&state=${encodeURIComponent(state)}`).expect(302);
  assert.equal(good.headers.location, "/console/?tiktok=ok#approvals");
  const channels = (await request(ctx.app).get("/admin/marketing/channels").set(admin(cookie)).expect(200)).body;
  assert.equal(channels.tiktok.connected, true);
  assert.equal(channels.tiktok.mode, "inbox");
  assert.equal(channels.tiktok.username, "Wanna yap?");

  // Inbox: the video waits as a draft in the TikTok app
  const id = await heroDraft();
  const { scheduledAt } = (await request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200)).body.draft;
  const inbox = await posting.runDue(new Date(Date.parse(scheduledAt) + 1000));
  assert.deepEqual(inbox.map((r) => [r.platform, r.status]), [["tiktok", "inbox"]]);
  const upload = calls.find((c) => c.method === "PUT");
  assert.equal(upload.headers["Content-Range"], "bytes 0-4999/5000");
  let draft = await AdDraft.findById(id).lean();
  assert.equal(draft.posted.tiktok, null, "a draft in the app is not posted yet");
  assert.equal(draft.status, "approved");

  // Direct (after TikTok's audit): posted with the AI label
  await request(ctx.app).put("/admin/marketing/channels/tiktok").set(admin(cookie)).send({ mode: "sideways" }).expect(400);
  await request(ctx.app).put("/admin/marketing/channels/tiktok").set(admin(cookie)).send({ mode: "direct", privacyLevel: "PUBLIC_TO_EVERYONE" }).expect(200);
  fakeTiktok({ final: "PUBLISH_COMPLETE" });
  await AdDraft.updateOne({ _id: id }, { "publish.tiktok.status": "scheduled", "publish.tiktok.attempts": 0 });
  calls = [];
  // The access token has run out: refreshed first
  await MarketingChannel.updateOne({ _id: "tiktok" }, { expiresAt: new Date(Date.now() - 1000) });
  const direct = await posting.runDue(new Date(Date.parse(scheduledAt) + 60000));
  assert.deepEqual(direct.map((r) => [r.platform, r.status]), [["tiktok", "posted"]]);
  const refresh = calls.find((c) => c.path === "/v2/oauth/token/");
  assert.equal(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
  const init = JSON.parse(calls.find((c) => c.path === "/v2/post/publish/video/init/").body);
  assert.equal(init.post_info.is_aigc, true);
  assert.equal(init.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(init.post_info.brand_organic_toggle, true);
  assert.equal(init.source_info.video_size, 5000);
  draft = await AdDraft.findById(id).lean();
  assert.equal(draft.status, "posted");
  assert.equal(draft.publish.tiktok.id, "7401");

  // Before the audit TikTok only offers SELF_ONLY: that is what gets used
  fakeTiktok({ final: "PUBLISH_COMPLETE", options: ["SELF_ONLY"] });
  await AdDraft.updateOne({ _id: id }, { "publish.tiktok.status": "scheduled", "posted.tiktok": null });
  calls = [];
  await posting.runDue(new Date(Date.parse(scheduledAt) + 120000));
  assert.equal(JSON.parse(calls.find((c) => c.path === "/v2/post/publish/video/init/").body).post_info.privacy_level, "SELF_ONLY");

  await request(ctx.app).delete("/admin/marketing/channels/tiktok").set(admin(cookie)).expect(200);
  assert.equal((await request(ctx.app).get("/admin/marketing/channels").set(admin(cookie)).expect(200)).body.tiktok.connected, false);
});

test("tokens are refreshed before they run out; a post that died midway is not repeated", async () => {
  fakeInstagram();
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  assert.deepEqual(await posting.refreshTokens(), [], "fresh token: nothing to do");
  await MarketingChannel.updateOne({ _id: "instagram" }, { expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000) });
  assert.deepEqual(await posting.refreshTokens(), ["instagram"]);
  assert.ok((await MarketingChannel.findById("instagram").lean()).expiresAt > new Date(Date.now() + 50 * 24 * 3600 * 1000));

  const id = await heroDraft();
  await request(ctx.app).post(`/admin/marketing/drafts/${id}/decision`).set(admin(cookie)).send({ action: "approve" }).expect(200);
  await AdDraft.updateOne({ _id: id }, { "publish.instagram.status": "posting", "publish.instagram.lastTryAt": new Date(Date.now() - 30 * 60000), scheduledAt: new Date(Date.now() - 30 * 60000) });
  assert.deepEqual(await posting.runDue(), []);
  const draft = await AdDraft.findById(id).lean();
  assert.equal(draft.publish.instagram.status, "failed");
  assert.match(draft.publish.instagram.error, /prüfen/);
});

test("post stats (plan 2.14): Instagram insights and TikTok's video query land in AdDraft.stats; one failure doesn't stop the rest", async () => {
  fakeInstagram();
  fakeTiktok();
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  const { url } = (await request(ctx.app).get("/admin/marketing/channels/tiktok/connect").set(admin(cookie)).expect(200)).body;
  assert.deepEqual(new URL(url).searchParams.get("scope").split(","), ["user.info.basic", "video.upload", "video.publish", "video.list"]);
  await request(ctx.app).get(`/marketing/tiktok/callback?code=good-code&state=${encodeURIComponent(new URL(url).searchParams.get("state"))}`).expect(302);

  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * 24 * 3600 * 1000);
  const draft = (campaign, publish, posted) => AdDraft.create({ campaign, title: campaign, template: "chat", status: "posted", publish, posted });
  const both = await draft("yap-beide", { instagram: { status: "posted", id: "media-9" }, tiktok: { status: "posted", id: "7401" } }, { instagram: ago(2), tiktok: ago(2) });
  // Older API: "views" refused, the same metrics with "plays"
  const older = await draft("yap-plays", { instagram: { status: "posted", id: "media-7" } }, { instagram: ago(5) });
  const broken = await draft("yap-kaputt", { instagram: { status: "posted", id: "media-err" } }, { instagram: ago(1) });
  // Not measured: posted by hand (no id), too old, TikTok still in the inbox (publish id)
  const byHand = await draft("yap-hand", {}, { instagram: ago(1) });
  const old = await draft("yap-alt", { instagram: { status: "posted", id: "media-old" } }, { instagram: ago(31) });
  const inbox = await AdDraft.create({ campaign: "yap-inbox", title: "x", template: "chat", status: "approved", publish: { tiktok: { status: "inbox", id: "v_pub_file~v2-1.123" } } });

  fake["/media-9/insights"] = (u) => ({
    json: {
      data: [
        { name: "views", period: "lifetime", values: [{ value: 1200 }] },
        { name: "reach", total_value: { value: 900 } },
        { name: "likes", values: [{ value: 80 }] },
        { name: "shares", values: [{ value: 12 }] },
        { name: "saved", values: [{ value: 5 }] },
        { name: "comments", values: [{ value: 3 }] },
      ],
      metricAsked: u.searchParams.get("metric"),
    },
  });
  fake["/media-7/insights"] = (u) =>
    u.searchParams.get("metric").split(",").includes("views")
      ? { status: 400, json: { error: { message: "(#100) metric[0] must be one of the following values: plays, reach, likes, shares, saved, comments" } } }
      : { json: { data: [{ name: "plays", values: [{ value: 444 }] }, { name: "likes", values: [{ value: 4 }] }] } };
  fake["/media-err/insights"] = () => ({ status: 400, json: { error: { message: "Unsupported get request" } } });
  fake["POST /v2/video/query/"] = (u, body) => ({
    json: {
      data: { videos: JSON.parse(body).filters.video_ids.includes("7401") ? [{ id: "7401", view_count: 5000, like_count: 300, comment_count: 20, share_count: 40 }] : [] },
      error: { code: "ok" },
    },
  });

  calls = [];
  assert.deepEqual(await posting.fetchStats(now), { instagram: 2, tiktok: 1, failed: 1 });
  const insights = calls.filter((c) => c.path.endsWith("/insights"));
  assert.deepEqual([...new Set(insights.map((c) => c.path))].sort(), ["/media-7/insights", "/media-9/insights", "/media-err/insights"]);
  assert.equal(new URL(`https://x${calls.find((c) => c.path === "/media-9/insights").query}`).searchParams.get("metric"), "views,reach,likes,shares,saved,comments");
  const query = calls.find((c) => c.path === "/v2/video/query/");
  assert.equal(new URLSearchParams(query.query).get("fields"), "id,view_count,like_count,comment_count,share_count");
  assert.deepEqual(JSON.parse(query.body).filters.video_ids, ["7401"]);
  assert.equal(query.headers.Authorization, "Bearer tt-access-authorization_code");

  const stats = (await AdDraft.findById(both._id).lean()).stats;
  assert.deepEqual({ ...stats.instagram, at: undefined }, { plays: 1200, reach: 900, likes: 80, shares: 12, saved: 5, comments: 3, at: undefined });
  assert.equal(stats.instagram.at.getTime(), now.getTime());
  assert.deepEqual({ ...stats.tiktok, at: undefined }, { views: 5000, likes: 300, comments: 20, shares: 40, at: undefined });
  const fromPlays = (await AdDraft.findById(older._id).lean()).stats.instagram;
  assert.equal(fromPlays.plays, 444);
  assert.equal(fromPlays.reach, null);
  for (const d of [broken, byHand, old, inbox]) assert.equal((await AdDraft.findById(d._id).lean()).stats?.instagram ?? null, null, d.campaign);
  assert.equal((await AdDraft.findById(inbox._id).lean()).stats?.tiktok ?? null, null);

  // The console shows them on the posted video
  const listed = (await request(ctx.app).get("/admin/marketing/drafts?status=posted").set(admin(cookie)).expect(200)).body.drafts;
  const shown = listed.find((d) => d.campaign === "yap-beide").stats;
  assert.equal(shown.instagram.plays, 1200);
  assert.equal(shown.tiktok.views, 5000);

  // TikTok refuses (a connection from before video.list): logged, Instagram still measured
  const ttQuery = fake["POST /v2/video/query/"];
  fake["POST /v2/video/query/"] = () => ({ status: 401, json: { data: {}, error: { code: "scope_not_authorized", message: "The user did not authorize the scope required for completing this request." } } });
  assert.deepEqual(await posting.fetchStats(new Date(now.getTime() + 6 * 3600 * 1000)), { instagram: 2, tiktok: 0, failed: 2 });
  assert.equal((await AdDraft.findById(both._id).lean()).stats.tiktok.views, 5000, "the last numbers stay");
  // ... and the console says why at the channel; one unreadable reel is no news
  let channels = (await request(ctx.app).get("/admin/marketing/channels").set(admin(cookie)).expect(200)).body;
  assert.match(channels.tiktok.lastError, /^Zahlen: .*video\.list/);
  assert.equal(channels.instagram.lastError, null);

  // Instagram token without instagram_business_manage_insights: every reel refused
  const igFakes = { ...fake };
  for (const m of ["/media-9/insights", "/media-7/insights"]) fake[m] = () => ({ status: 400, json: { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException" } } });
  assert.deepEqual(await posting.fetchStats(new Date(now.getTime() + 12 * 3600 * 1000)), { instagram: 0, tiktok: 0, failed: 4 });
  channels = (await request(ctx.app).get("/admin/marketing/channels").set(admin(cookie)).expect(200)).body;
  assert.match(channels.instagram.lastError, /instagram_business_manage_insights/);
  // A token error is more important: the numbers never write over it
  await MarketingChannel.updateOne({ _id: "tiktok" }, { lastError: "Token-Erneuerung: abgelaufen" });
  await posting.fetchStats(new Date(now.getTime() + 18 * 3600 * 1000));
  assert.equal((await MarketingChannel.findById("tiktok").lean()).lastError, "Token-Erneuerung: abgelaufen");
  // Readable again: the stats line goes, the token error stays
  Object.assign(fake, igFakes);
  assert.equal((await posting.fetchStats(new Date(now.getTime() + 20 * 3600 * 1000))).instagram, 2);
  assert.equal((await MarketingChannel.findById("instagram").lean()).lastError, null);
  assert.equal((await MarketingChannel.findById("tiktok").lean()).lastError, "Token-Erneuerung: abgelaufen");
  await MarketingChannel.updateOne({ _id: "tiktok" }, { lastError: "Zahlen: alt" });
  fake["POST /v2/video/query/"] = ttQuery;
  assert.equal((await posting.fetchStats(new Date(now.getTime() + 30 * 3600 * 1000))).tiktok, 1);
  assert.equal((await MarketingChannel.findById("tiktok").lean()).lastError, null);
  // Nothing connected: nothing to do
  await request(ctx.app).delete("/admin/marketing/channels/instagram").set(admin(cookie)).expect(200);
  await request(ctx.app).delete("/admin/marketing/channels/tiktok").set(admin(cookie)).expect(200);
  calls = [];
  assert.deepEqual(await posting.fetchStats(now), { instagram: 0, tiktok: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

test("post stats (plan 2.14): read at most every 6 hours, however often the job (or a restart) asks", async () => {
  fakeInstagram();
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/marketing/channels/instagram").set(admin(cookie)).send({ token: "IGTOKEN-long-lived-0123456789" }).expect(200);
  const now = new Date();
  await AdDraft.create({ campaign: "yap-takt", title: "x", template: "chat", status: "posted", publish: { instagram: { status: "posted", id: "media-5" } }, posted: { instagram: now } });
  fake["/media-5/insights"] = () => ({ json: { data: [{ name: "views", values: [{ value: 10 }] }] } });
  const reads = () => calls.filter((c) => c.path === "/media-5/insights").length;

  calls = [];
  // Two instances (Render overlaps them on a deploy) ask at once: one reads
  const [a, b] = await Promise.all([posting.statsDue(now), posting.statsDue(now)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(reads(), 1);
  // The next checks (every 30 minutes, or right after a restart): nothing
  assert.equal(await posting.statsDue(new Date(now.getTime() + 30 * 60000)), null);
  assert.equal(await posting.statsDue(new Date(now.getTime() + posting.STATS_EVERY_MS - 60000)), null);
  assert.equal(reads(), 1);
  // 6 hours later: again
  assert.deepEqual(await posting.statsDue(new Date(now.getTime() + posting.STATS_EVERY_MS)), { instagram: 1, tiktok: 0, failed: 0 });
  assert.equal(reads(), 2);
  assert.ok((await request(ctx.app).get("/admin/marketing/agent").set(admin(cookie)).expect(200)).body.lastStatsAt);
});

test("TikTok token: the token job and the stats reading share one refresh, never two with the same refresh token", async () => {
  fakeTiktok();
  const cookie = await ownerCookie();
  const { url } = (await request(ctx.app).get("/admin/marketing/channels/tiktok/connect").set(admin(cookie)).expect(200)).body;
  await request(ctx.app).get(`/marketing/tiktok/callback?code=good-code&state=${encodeURIComponent(new URL(url).searchParams.get("state"))}`).expect(302);
  const now = new Date();
  await AdDraft.create({ campaign: "yap-refresh", title: "x", template: "chat", status: "posted", publish: { tiktok: { status: "posted", id: "7402" } }, posted: { tiktok: now } });
  fake["POST /v2/video/query/"] = () => ({ json: { data: { videos: [{ id: "7402", view_count: 7 }] }, error: { code: "ok" } } });
  await MarketingChannel.updateOne({ _id: "tiktok" }, { expiresAt: new Date(now.getTime() + 60000) });

  calls = [];
  const [stats, refreshed] = await Promise.all([posting.fetchStats(now), posting.refreshTokens(now)]);
  assert.equal(stats.tiktok, 1);
  assert.deepEqual(refreshed, ["tiktok"]);
  const refreshes = calls.filter((c) => c.path === "/v2/oauth/token/" && new URLSearchParams(c.body).get("grant_type") === "refresh_token");
  assert.equal(refreshes.length, 1);
  assert.equal(calls.find((c) => c.path === "/v2/video/query/").headers.Authorization, "Bearer tt-access-refresh_token");
});
