// Outage banner from alerts (plan 2.15, lib/statusBanner.js): a userFacing
// rule switches AppConfig.banner on with its text and tells open apps over
// the socket, switches it off once it is quiet again, never touches a banner
// set by hand; the console takes an automatic banner over; a new support
// ticket during an outage gets the automatic answer; POST /rtcToken counts
// its tokens for the rule agora_tokens.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes } = require("./helpers");
const AppConfig = require("../models/AppConfig");
const AlertState = require("../models/AlertState");
const SupportTicket = require("../models/SupportTicket");
const Call = require("../models/Call");
const alerts = require("../lib/alerts");
const opsCounters = require("../lib/opsCounters");
const statusBanner = require("../lib/statusBanner");
const { saveConfig } = require("../lib/appConfig");
const { overdueTickets } = require("../lib/today");
const { todayKey } = require("../lib/metrics");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  await AlertState.syncIndexes();
});

const ANNA = "+4915111111111";
const EMAIL = "owner@example.com";
const SMS_TEXT = "Die Anmeldung per SMS ist gerade gestört. Wir arbeiten dran.";
const HOUR = 3600 * 1000;

async function login(phone) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  return (await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200)).body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function ownerCookie() {
  const who = { email: EMAIL, password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return { Cookie: done.headers["set-cookie"][0].split(";")[0], "X-Admin-Request": "1" };
}

/** A connected app socket that records every appConfig event. */
async function appSocket(token) {
  const socket = connect(ctx.url, { transports: ["websocket"], auth: { token } });
  socket.configs = [];
  socket.on("appConfig", (c) => socket.configs.push(c));
  await new Promise((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
  });
  return socket;
}
const settle = () => new Promise((r) => setTimeout(r, 100));
const banner = async () => (await AppConfig.findOne({ key: "app" }).lean())?.banner;
const publicBanner = async () => (await request(ctx.app).get("/app-config").expect(200)).body.banner;

/** Today's sign-up SMS: `failed` of `started` refused by Twilio. */
async function sms(started, failed, now = new Date()) {
  await opsCounters.count("smsStarted", now, started);
  if (failed) await opsCounters.count("smsFailed", now, failed);
}

test("banner: a userFacing rule switches it on with its text, tells open apps, and off again once the rule is quiet", async () => {
  const socket = await appSocket(await login(ANNA));
  try {
    const now = new Date();
    assert.equal(await publicBanner(), null);
    // 3 of 5 sign-up SMS failed: sms_failures fires
    await sms(5, 3, now);
    assert.deepEqual(await alerts.runRules(now), ["sms_failures"]);
    assert.deepEqual(await banner(), { enabled: true, text: SMS_TEXT, level: "warning", until: null, source: "alert:sms_failures", muted: [] });
    // The public config has the same shape as before, without the source;
    // the landing page fetches it from wannayap.app
    assert.deepEqual(await publicBanner(), { text: SMS_TEXT, level: "warning", until: null });
    const landing = await request(ctx.app).get("/app-config").set("Origin", "https://wannayap.app").expect(200);
    assert.equal(landing.headers["access-control-allow-origin"], "https://wannayap.app");
    await settle();
    assert.equal(socket.configs.length, 1);
    assert.deepEqual(socket.configs[0].banner, { text: SMS_TEXT, level: "warning", until: null });

    // Still firing (the alert itself is debounced now): nothing changes, no second event
    assert.deepEqual(await alerts.runRules(new Date(now.getTime() + 1000)), []);
    await settle();
    assert.equal(socket.configs.length, 1);
    assert.equal((await banner()).source, "alert:sms_failures");

    // Twenty more that went through: 3 of 25 is under 20 %, the banner goes away
    await sms(20, 0, now);
    await alerts.runRules(new Date(now.getTime() + 2000));
    assert.equal((await banner()).enabled, false);
    assert.equal((await banner()).source, null);
    assert.equal(await publicBanner(), null);
    await settle();
    assert.equal(socket.configs.length, 2);
    assert.equal(socket.configs[1].banner, null);
  } finally {
    socket.close();
  }
});

test("banner: a banner set by hand wins, it is neither overwritten nor switched off; an expired one is taken", async () => {
  const now = new Date();
  await saveConfig({ banner: { enabled: true, text: "Wartung heute Abend ab 22 Uhr.", level: "info" } }, EMAIL);
  await sms(5, 3, now);
  await alerts.runRules(now);
  assert.equal((await banner()).text, "Wartung heute Abend ab 22 Uhr.");
  assert.equal((await banner()).source, null);
  // The rule is quiet again: the hand banner stays
  assert.equal(await statusBanner.syncBanner("sms_failures", false, { now }), false);
  assert.equal((await banner()).enabled, true);

  // A hand banner that has expired doesn't block the automatic one
  await saveConfig({ banner: { enabled: true, text: "Wartung vorbei.", level: "info", until: new Date(now.getTime() - HOUR).toISOString() } }, EMAIL);
  assert.equal(await statusBanner.syncBanner("sms_failures", true, { text: SMS_TEXT, now }), true);
  assert.equal((await banner()).source, "alert:sms_failures");

  // Two alerts at once: the first keeps the banner, the other takes it once the first is over
  assert.equal(await statusBanner.syncBanner("agora_tokens", true, { text: "Anrufe sind gerade gestört. Wir arbeiten dran.", now }), false);
  assert.equal((await banner()).source, "alert:sms_failures");
  await statusBanner.syncBanner("sms_failures", false, { now });
  assert.equal(await statusBanner.syncBanner("agora_tokens", true, { text: "Anrufe sind gerade gestört. Wir arbeiten dran.", now }), true);
  assert.equal((await banner()).source, "alert:agora_tokens");
});

test("banner in the console: an unchanged save keeps it automatic; switching it off holds for the rest of the outage", async () => {
  const headers = await ownerCookie();
  const now = new Date();
  await sms(5, 3, now);
  await alerts.runRules(now);
  const config = (await request(ctx.app).get("/admin/config").set(headers).expect(200)).body.config;
  assert.equal(config.banner.source, "alert:sms_failures");

  // The console sends the banner with every save (here: a goal changed)
  const { enabled, text, level } = config.banner;
  await request(ctx.app).put("/admin/config").set(headers).send({ banner: { enabled, text, level, until: null }, goals: { densityPct: 45 } }).expect(200);
  assert.equal((await banner()).source, "alert:sms_failures");

  // "Banner jetzt abschalten": the owner's now, and muted while the alert lasts
  await request(ctx.app).put("/admin/config").set(headers).send({ banner: { enabled: false, text, level, until: null } }).expect(200);
  assert.deepEqual(await banner(), { enabled: false, text, level: "warning", until: null, source: null, muted: ["alert:sms_failures"] });
  await alerts.runRules(new Date(now.getTime() + 1000));
  assert.equal((await banner()).enabled, false);

  // The alert is over: the mute goes, the next outage brings the banner again
  await sms(20, 0, now);
  await alerts.runRules(new Date(now.getTime() + 2000));
  assert.deepEqual((await banner()).muted, []);
  await sms(0, 10, now);
  await alerts.runRules(new Date(now.getTime() + 3000));
  assert.equal((await banner()).source, "alert:sms_failures");
  assert.equal((await banner()).enabled, true);

  // Text changed by hand: the owner's banner, the alert no longer switches it off
  await request(ctx.app).put("/admin/config").set(headers).send({ banner: { enabled: true, text: "SMS hakt, Anmeldung bitte später.", level: "warning", until: null } }).expect(200);
  await sms(100, 0, now);
  await alerts.runRules(new Date(now.getTime() + 4000));
  assert.equal((await banner()).enabled, true);
  assert.equal((await banner()).text, "SMS hakt, Anmeldung bitte später.");
});

test("support: a ticket during an outage gets the automatic answer and still waits for a person", async () => {
  const token = await login(ANNA);
  // No outage: no answer
  const calm = await request(ctx.app).post("/support").set(auth(token)).send({ category: "bug", message: "Frage zur App" }).expect(200);
  assert.equal(calm.body.ticket.messages.length, 1);

  // A banner by hand is no known outage
  await saveConfig({ banner: { enabled: true, text: "Wartung heute Abend.", level: "info" } }, EMAIL);
  const hand = await request(ctx.app).post("/support").set(auth(token)).send({ category: "bug", message: "Geht was nicht?" }).expect(200);
  assert.equal(hand.body.ticket.messages.length, 1);
  await saveConfig({ banner: { enabled: false, text: "" } }, EMAIL);

  await statusBanner.syncBanner("sms_failures", true, { text: SMS_TEXT });
  const res = await request(ctx.app).post("/support").set(auth(token)).send({ category: "account", message: "Ich bekomme keine SMS" }).expect(200);
  const [first, answer] = res.body.ticket.messages;
  assert.equal(first.from, "user");
  assert.equal(answer.from, "support");
  assert.equal(answer.text, `Danke für deine Nachricht! Gerade gibt es eine bekannte Störung: ${SMS_TEXT} Wir melden uns, sobald sie behoben ist.`);
  assert.equal(res.body.ticket.status, "open");
  assert.equal(res.body.ticket.unread, true);
  const stored = await SupportTicket.findById(res.body.ticket.id).lean();
  assert.equal(stored.messages[1].by, "auto");

  // A day later without a person's answer it is overdue, the automatic answer doesn't count
  const later = new Date(Date.now() + 25 * HOUR);
  assert.ok((await overdueTickets(later)).some((t) => String(t._id) === res.body.ticket.id));
  // The console marks it
  const headers = await ownerCookie();
  const queue = await request(ctx.app).get("/admin/tickets").set(headers).expect(200);
  assert.equal(queue.body.tickets.find((t) => t.id === res.body.ticket.id).lastFrom, "auto");
  // support.csv: the automatic answer is no answer from support
  const csv = (await request(ctx.app).get("/admin/export/support.csv").set(headers).expect(200)).text;
  const row = csv.split("\n").find((line) => line.includes(res.body.ticket.id));
  assert.ok(row.includes('"2";"1";"0";"auto"'), row);
});

test("agora_tokens: /rtcToken counts tokens; more than five failures and over 20 % of the issued ones alert and set the banner", async () => {
  const token = await login(ANNA);
  await Call.create({ callId: "c1", channel: "call_one", caller: ANNA, callee: "+4915222222222" });
  const ask = (expect) => request(ctx.app).post("/rtcToken").set(auth(token)).send({ channelName: "call_one", uid: ANNA.slice(1) }).expect(expect);
  for (let i = 0; i < 20; i++) await ask(200);

  const certificate = process.env.AGORA_APP_CERTIFICATE;
  delete process.env.AGORA_APP_CERTIFICATE;
  try {
    for (let i = 0; i < 5; i++) await ask(500);
    await settle();
    const now = new Date();
    let c = await opsCounters.countsOf(todayKey(now));
    assert.equal(c.rtcTokenIssued, 20);
    assert.equal(c.rtcTokenFailed, 5);
    // Five failures: a hiccup, quiet
    assert.deepEqual(await alerts.runRules(now), []);
    await ask(500);
    await settle();
    // Six of 20 issued (30 %): fires
    assert.deepEqual(await alerts.runRules(now), ["agora_tokens"]);
    const state = await AlertState.findOne({ tag: "agora_tokens" }).lean();
    assert.equal(state.level, "error");
    assert.match(state.lastText, /Heute 6 Agora-Tokens fehlgeschlagen, 20 ausgestellt/);
    assert.deepEqual(await publicBanner(), { text: "Anrufe sind gerade gestört. Wir arbeiten dran.", level: "warning", until: null });
  } finally {
    process.env.AGORA_APP_CERTIFICATE = certificate;
  }

  // Many more good tokens: 6 of 40 is under 20 %, the banner goes
  for (let i = 0; i < 20; i++) await ask(200);
  await settle();
  assert.equal((await opsCounters.countsOf(todayKey(new Date()))).rtcTokenIssued, 40);
  await alerts.runRules(new Date());
  assert.equal(await publicBanner(), null);
});

test("banner in the console: a stale App tab neither keeps an ended outage nor switches off a new one", async () => {
  const headers = await ownerCookie();
  const now = new Date();
  const get = async () => (await request(ctx.app).get("/admin/config").set(headers).expect(200)).body.config;
  const seenOf = (b) => ({ enabled: b.enabled, text: b.text, level: b.level, until: b.until });

  // Case 1: the tab is loaded during the outage, the outage ends, then the
  // owner saves something else. The console sends no banner: it stays off
  await sms(5, 3, now);
  await alerts.runRules(now);
  const during = await get();
  assert.equal(during.banner.source, "alert:sms_failures");
  await sms(20, 0, now);
  await alerts.runRules(new Date(now.getTime() + 1000));
  assert.equal((await banner()).enabled, false);
  await request(ctx.app).put("/admin/config").set(headers).send({ minBuild: 12 }).expect(200);
  assert.equal((await banner()).enabled, false);
  assert.equal(await publicBanner(), null);
  // An older console that still sends the loaded banner with what it saw: refused, nothing written
  const stale = await request(ctx.app)
    .put("/admin/config")
    .set(headers)
    .send({ banner: { ...seenOf(during.banner), text: `${during.banner.text} Bald vorbei.` }, bannerSeen: seenOf(during.banner), minBuild: 13 })
    .expect(400);
  assert.equal(stale.body.error, "banner_changed");
  assert.equal((await banner()).enabled, false);
  assert.equal((await AppConfig.findOne({ key: "app" }).lean()).minBuild, 12);

  // Case 2: the tab is loaded without a banner, then an alert switches it on
  const quiet = await get();
  assert.equal(quiet.banner.enabled, false);
  await statusBanner.syncBanner("agora_tokens", true, { text: "Anrufe sind gerade gestört. Wir arbeiten dran.", now });
  // Saving something else leaves the automatic banner alone, not muted
  await request(ctx.app).put("/admin/config").set(headers).send({ minBuild: 14 }).expect(200);
  assert.equal((await banner()).source, "alert:agora_tokens");
  assert.deepEqual((await banner()).muted, []);
  // A banner edited in the stale tab is refused rather than switching it off
  const edited = await request(ctx.app)
    .put("/admin/config")
    .set(headers)
    .send({ banner: { enabled: false, text: "", level: "info", until: null }, bannerSeen: seenOf(quiet.banner) })
    .expect(400);
  assert.equal(edited.body.error, "banner_changed");
  assert.equal((await banner()).enabled, true);
  assert.deepEqual((await banner()).muted, []);
  // With the current state seen, switching off works and mutes
  const current = await get();
  await request(ctx.app).put("/admin/config").set(headers).send({ banner: { ...seenOf(current.banner), enabled: false }, bannerSeen: seenOf(current.banner) }).expect(200);
  assert.equal((await banner()).enabled, false);
  assert.deepEqual((await banner()).muted, ["alert:agora_tokens"]);
});

test("banner: day-counted rules hold it only while failures are recent; the 5-minute run switches it", async () => {
  // 17:30 in Berlin, so three hours earlier is still the same day
  const now = new Date("2026-10-03T15:30:00Z");
  const at = (min) => new Date(now.getTime() + min * 60 * 1000);
  const PUSH_TEXT = "Mitteilungen kommen gerade verzögert an. Wir arbeiten dran.";
  // One refused credential this afternoon at 14:30: the alert fires for the day, no banner
  await opsCounters.count("pushCredentialErrors", at(-180));
  assert.deepEqual(await alerts.runRules(now), ["push_credentials"]);
  assert.equal((await banner())?.enabled || false, false);
  assert.deepEqual(await opsCounters.countsOfRecent(now), {});

  // Another one ten minutes ago: the 5-minute run switches the banner on, without a second alert
  await opsCounters.count("pushCredentialErrors", at(-10));
  const before = (await AlertState.findOne({ tag: "push_credentials" }).lean()).count;
  const states = await alerts.runBannerRules(now);
  assert.equal(states.push_credentials, true);
  assert.equal(states.push_failures, false);
  assert.equal((await banner()).source, "alert:push_credentials");
  assert.equal((await banner()).text, PUSH_TEXT);
  assert.equal((await AlertState.findOne({ tag: "push_credentials" }).lean()).count, before);

  // Two hours later nothing new: the alert would still read the day, the banner goes
  await alerts.runBannerRules(at(120));
  assert.equal((await banner()).enabled, false);
  assert.equal((await banner()).source, null);

  // Agora: a burst of failures this morning, all fine since: no banner tonight
  const morning = new Date("2026-10-03T06:00:00Z");
  await opsCounters.count("rtcTokenIssued", morning, 10);
  await opsCounters.count("rtcTokenFailed", morning, 30);
  await opsCounters.count("rtcTokenIssued", at(115), 3);
  assert.ok((await alerts.runRules(at(120))).includes("agora_tokens"));
  assert.equal((await banner()).enabled, false);
  // The hour rows go by themselves (TTL) and leave the day row alone
  const rows = await mongooseRows();
  assert.ok(rows.some((r) => r._id.startsWith("opsh:") && r.expiresAt));
  assert.ok(rows.filter((r) => r._id.startsWith("ops:")).every((r) => !r.expiresAt));
});

test("banner: switching it off mutes every rule of the same text until all of them are quiet", async () => {
  const headers = await ownerCookie();
  const now = new Date("2026-10-03T15:30:00Z");
  const PUSH_TEXT = "Mitteilungen kommen gerade verzögert an. Wir arbeiten dran.";
  await opsCounters.count("pushCredentialErrors", new Date(now.getTime() - 60 * 1000));
  await alerts.runBannerRules(now);
  const config = (await request(ctx.app).get("/admin/config").set(headers).expect(200)).body.config;
  assert.equal(config.banner.source, "alert:push_credentials");
  const seen = { enabled: true, text: PUSH_TEXT, level: "warning", until: null };
  await request(ctx.app).put("/admin/config").set(headers).send({ banner: { ...seen, enabled: false }, bannerSeen: seen }).expect(200);
  assert.deepEqual([...(await banner()).muted].sort(), ["alert:push_credentials", "alert:push_failures"]);

  // push_failures with the same line can't bring it back
  assert.equal(await statusBanner.syncBanner("push_failures", true, { text: PUSH_TEXT, now }), false);
  // Another outage takes the banner, and keeps the mute when it ends
  assert.equal(await statusBanner.syncBanner("agora_tokens", true, { text: "Anrufe sind gerade gestört. Wir arbeiten dran.", now }), true);
  await alerts.runBannerRules(now);
  assert.equal((await banner()).enabled, false);
  assert.deepEqual([...(await banner()).muted].sort(), ["alert:push_credentials", "alert:push_failures"]);
  assert.equal(await statusBanner.syncBanner("push_credentials", true, { text: PUSH_TEXT, now }), false);

  // Two hours later no push rule fires: the mute goes
  await alerts.runBannerRules(new Date(now.getTime() + 2 * HOUR));
  assert.deepEqual((await banner()).muted, []);
});

async function mongooseRows() {
  return require("../models/OpsTally").find({}).lean();
}
