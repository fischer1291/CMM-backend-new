// The personal invite link (plan 1.11): every account gets a stable
// inviteCode, /einladung counts its visits per day, code and platform, a
// sign-up that carries the code connects both people, Android visitors join
// the waitlist with their platform, and the day's snapshot carries the sums.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const InviteVisit = require("../models/InviteVisit");
const WaitlistEntry = require("../models/WaitlistEntry");
const { computeDay, todayKey } = require("../lib/metrics");
const { localeOf } = require("../lib/appConfig");
const { isConnected } = require("../lib/relations");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";

const check = (phone, extra = {}, headers = {}) =>
  request(ctx.app).post("/verify/check").set(headers).send({ phone, code: fakes.approvedCode, ...extra }).expect(200);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const me = (token) => request(ctx.app).get("/me").set(auth(token)).expect(200);
const userOf = (phone) => User.findOne({ phone }).lean();
const visit = (body, headers = {}) => request(ctx.app).post("/invites/visit").set(headers).send(body);

test("invite code: given on sign-up, stable across /me, an older account gets one on its first GET /me", async () => {
  const { body } = await check(ANNA);
  const anna = await userOf(ANNA);
  assert.match(anna.inviteCode, CODE);
  const first = await me(body.token);
  assert.equal(first.body.user.inviteCode, anna.inviteCode);
  const second = await me(body.token);
  assert.equal(second.body.user.inviteCode, anna.inviteCode);
  // Signing in again keeps it
  await check(ANNA);
  assert.equal((await userOf(ANNA)).inviteCode, anna.inviteCode);

  // Accounts from before plan 1.11 have no code until they load their profile
  await User.updateOne({ phone: ANNA }, { $unset: { inviteCode: 1 } });
  const ben = (await check(BEN)).body.token;
  await User.updateOne({ phone: BEN }, { $unset: { inviteCode: 1 } });
  assert.equal((await userOf(BEN)).inviteCode, undefined);
  const loaded = await me(ben);
  assert.match(loaded.body.user.inviteCode, CODE);
  assert.equal((await userOf(BEN)).inviteCode, loaded.body.user.inviteCode);
  // Codes are unique; two accounts without one don't collide on the sparse index
  assert.ok((await User.collection.indexes()).some((i) => i.key.inviteCode === 1 && i.unique && i.sparse));

  // Other people's profiles never show it
  const other = await request(ctx.app).get("/me").query({ phone: ANNA }).set(auth(ben)).expect(200);
  assert.equal(other.body.user.inviteCode, undefined);
});

test("/invites/visit counts per day, code and platform and says whether the code exists", async () => {
  await check(ANNA);
  const code = (await userOf(ANNA)).inviteCode;
  assert.deepEqual((await visit({ code, platform: "ios" }).expect(200)).body, { success: true, valid: true });
  assert.deepEqual((await visit({ code: code.toLowerCase(), platform: "ios" }).expect(200)).body, { success: true, valid: true });
  assert.deepEqual((await visit({ code, platform: "android" }).expect(200)).body, { success: true, valid: true });
  // Anything that isn't ios or android lands in "other"
  assert.deepEqual((await visit({ code, platform: "windows" }).expect(200)).body, { success: true, valid: true });
  // Unknown codes count too, without a 404
  assert.deepEqual((await visit({ code: "ZZZZ9999", platform: "ios" }).expect(200)).body, { success: true, valid: false });
  // Something that can't be a code is refused and not stored
  await visit({ code: "nope", platform: "ios" }).expect(400);
  await visit({}).expect(400);

  const day = todayKey();
  const rows = await InviteVisit.find({ day }).sort({ code: 1, platform: 1 }).lean();
  assert.deepEqual(
    rows.map((r) => [r.code, r.platform, r.visits]),
    [
      [code, "android", 1],
      [code, "ios", 2],
      [code, "other", 1],
      ["ZZZZ9999", "ios", 1],
    ].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  );
  // Nothing about the visitor, and the rows expire after 400 days
  assert.deepEqual(Object.keys(rows[0]).sort(), ["__v", "_id", "at", "code", "day", "platform", "visits"]);
  const ttl = (await InviteVisit.collection.indexes()).find((i) => i.expireAfterSeconds);
  assert.equal(ttl.expireAfterSeconds, 400 * 24 * 3600);
  // The counter is public: no token needed (it ran without one above), the token check comes later
  await request(ctx.app).get("/me").expect(400);
});

test("joining through a code connects both people and credits the inviter; the own and unknown codes do nothing", async () => {
  const anna = (await check(ANNA)).body.token;
  const code = (await userOf(ANNA)).inviteCode;

  const { body } = await check(BEN, { inviteCode: code.toLowerCase() });
  assert.ok(body.success && body.token);
  const ben = await userOf(BEN);
  assert.deepEqual(ben.contacts, [ANNA]);
  assert.deepEqual(ben.connections, [ANNA]);
  assert.deepEqual(ben.invitedBy, [ANNA]);
  assert.equal(ben.joinedViaInvite, true);
  assert.deepEqual(ben.pendingJoinAnnouncement, [ANNA]);
  const annaDoc = await userOf(ANNA);
  assert.deepEqual(annaDoc.contacts, [BEN]);
  assert.deepEqual(annaDoc.connections, [BEN]);
  assert.equal(annaDoc.invitesJoined, 1);
  // Neither has the other's number, still they may call each other
  assert.equal(await isConnected(BEN, ANNA), true);

  // Ben already has an inviter: a second code changes nothing
  await check(CARL);
  const carlCode = (await userOf(CARL)).inviteCode;
  await check(BEN, { inviteCode: carlCode });
  assert.deepEqual((await userOf(BEN)).invitedBy, [ANNA]);
  assert.equal((await userOf(CARL)).invitesJoined, 0);

  // The own code and an unknown one are ignored in silence
  await check(CARL, { inviteCode: carlCode });
  const carl = await userOf(CARL);
  assert.deepEqual(carl.invitedBy, []);
  assert.deepEqual(carl.contacts, []);
  assert.equal(carl.invitesJoined, 0);
  await check(CARL, { inviteCode: "ZZZZ9999" });
  await check(CARL, { inviteCode: "x".repeat(40) });
  assert.deepEqual((await userOf(CARL)).invitedBy, []);
  assert.equal((await userOf(ANNA)).invitesJoined, 1);

  // Ben sets his name: Anna hears that he joined
  await request(ctx.app).post("/me/update").set(auth(body.token)).send({ name: "Ben" }).expect(200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await userOf(BEN)).pendingJoinAnnouncement, []);
  // Anna's own profile still carries her code, unchanged by the join
  assert.equal((await me(anna)).body.user.inviteCode, code);
});

test("locale: the device language from Accept-Language is stored on /verify/check and /me/update, measured only", async () => {
  assert.equal(localeOf({ "accept-language": "de-DE,de;q=0.9,en;q=0.8" }), "de-DE");
  assert.equal(localeOf({ "accept-language": "en" }), "en");
  assert.equal(localeOf({ "accept-language": "*" }), null);
  assert.equal(localeOf({ "accept-language": "not a locale!" }), null);
  assert.equal(localeOf({}), null);

  const { body } = await check(ANNA, {}, { "Accept-Language": "de-DE,de;q=0.9" });
  assert.equal((await userOf(ANNA)).locale, "de-DE");
  // Without the header the stored value stays
  await check(ANNA);
  assert.equal((await userOf(ANNA)).locale, "de-DE");
  await request(ctx.app).post("/me/update").set(auth(body.token)).set("Accept-Language", "tr-TR").send({ name: "Anna" }).expect(200);
  assert.equal((await userOf(ANNA)).locale, "tr-TR");
  const exported = await request(ctx.app).get("/me/export").set(auth(body.token)).expect(200);
  assert.equal(exported.body.data.profile.locale, "tr-TR");
  assert.match(exported.body.data.profile.inviteCode, CODE);
});

test("waitlist: platform from the body or the user agent, the invite page's source and campaign are kept", async () => {
  await check(ANNA);
  const code = (await userOf(ANNA)).inviteCode;
  await request(ctx.app)
    .post("/waitlist")
    .set("User-Agent", IPHONE)
    .send({ email: "lea@example.com", platform: "android", source: "einladung", campaign: `invite-${code}` })
    .expect(200);
  const lea = await WaitlistEntry.findOne({ email: "lea@example.com" }).lean();
  assert.equal(lea.platform, "android");
  assert.equal(lea.source, "einladung");
  assert.equal(lea.campaign, `invite-${code}`);

  await request(ctx.app).post("/waitlist").set("User-Agent", IPHONE).send({ email: "tim@example.com" }).expect(200);
  assert.equal((await WaitlistEntry.findOne({ email: "tim@example.com" })).platform, "ios");
  await request(ctx.app).post("/waitlist").set("User-Agent", ANDROID).send({ email: "mia@example.com" }).expect(200);
  assert.equal((await WaitlistEntry.findOne({ email: "mia@example.com" })).platform, "android");
  await request(ctx.app).post("/waitlist").set("User-Agent", "curl/8.0").send({ email: "jan@example.com", platform: "windows" }).expect(200);
  assert.equal((await WaitlistEntry.findOne({ email: "jan@example.com" })).platform, null);
});

test("computeDay: inviteVisits by platform, waitlist confirmations by platform, top locales of the new users", async () => {
  await check(ANNA, {}, { "Accept-Language": "de-DE" });
  await check(BEN, {}, { "Accept-Language": "de-DE" });
  await check(CARL, {}, { "Accept-Language": "en-US" });
  const code = (await userOf(ANNA)).inviteCode;
  await visit({ code, platform: "ios" }).expect(200);
  await visit({ code, platform: "ios" }).expect(200);
  await visit({ code, platform: "android" }).expect(200);
  await visit({ code: "ZZZZ9999", platform: "other" }).expect(200);

  const confirm = async (email, ua) => {
    await request(ctx.app).post("/waitlist").set("User-Agent", ua).send({ email }).expect(200);
    const token = fakes.mails.findLast((m) => m.to === email).text.match(/bestaetigen=([a-f0-9]{48})/)[1];
    await request(ctx.app).post("/waitlist/confirm").send({ token }).expect(200);
  };
  await confirm("a@example.com", ANDROID);
  await confirm("b@example.com", ANDROID);
  await confirm("c@example.com", IPHONE);
  await confirm("d@example.com", "curl/8.0");
  // Signed up but not confirmed: not counted
  await request(ctx.app).post("/waitlist").set("User-Agent", ANDROID).send({ email: "e@example.com" }).expect(200);

  const now = new Date();
  const day = await computeDay(todayKey(now), now);
  assert.deepEqual(day.growth.inviteVisits, { total: 4, ios: 2, android: 1, other: 1 });
  assert.deepEqual(day.waitlist.byPlatform, { ios: 1, android: 2, unknown: 1 });
  assert.deepEqual(day.users.byLocale, [
    { locale: "de-DE", users: 2 },
    { locale: "en-US", users: 1 },
  ]);
  // Another day has none of it
  const empty = await computeDay("2020-01-01", now);
  assert.deepEqual(empty.growth.inviteVisits, { total: 0, ios: 0, android: 0, other: 0 });
  assert.deepEqual(empty.waitlist.byPlatform, { ios: 0, android: 0, unknown: 0 });
  assert.deepEqual(empty.users.byLocale, []);
});

test("a hash invite and the code from the same person count one join, whichever path connects first", async () => {
  const anna = (await check(ANNA)).body.token;
  const code = (await userOf(ANNA)).inviteCode;
  // Anna picked Ben from her address book (Invite by hash) and also sent him her link
  await request(ctx.app).post("/invites").set(auth(anna)).send({ hashes: [User.hashPhone(BEN)] }).expect(200);
  await check(BEN, { inviteCode: code });
  // connectInviters runs in the background of /verify/check
  await new Promise((r) => setTimeout(r, 300));
  const annaDoc = await userOf(ANNA);
  assert.equal(annaDoc.invitesJoined, 1);
  assert.deepEqual(annaDoc.connections, [BEN]);
  const ben = await userOf(BEN);
  assert.deepEqual(ben.invitedBy, [ANNA]);
  assert.deepEqual(ben.connections, [ANNA]);
  // Signing in again with the code changes nothing
  await check(BEN, { inviteCode: code });
  assert.equal((await userOf(ANNA)).invitesJoined, 1);
});
