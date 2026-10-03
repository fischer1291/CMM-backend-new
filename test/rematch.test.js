// Re-match (plan 2.13, lib/rematch.js): with the opt-in, a contact sync keeps
// the hashes that matched nobody, peppered; a sign-up with a name tells
// those owners once (contact_joined), never the blocked, never an inviter a
// second time; opt-out, deletion and the TTL make the list go.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Block = require("../models/Block");
const AddressBookHash = require("../models/AddressBookHash");
const rematch = require("../lib/rematch");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const DANA = "+4915444444444";
const EVA = "+4915555555555";
const DAY = 24 * 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  const set = { "notificationPrefs.quietHours.enabled": false };
  if (name) Object.assign(set, { name, pushToken: `ExponentPushToken[${name}]` });
  await User.updateOne({ phone }, set);
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const sha = (phone) => User.hashPhone(phone);
const match = (token, hashes) => request(ctx.app).post("/contacts/match").set(auth(token)).send({ hashes }).expect(200);
const optIn = (token, value) => request(ctx.app).put("/me/rematch").set(auth(token)).send({ optIn: value });
const joinedPushes = () => fakes.expoPushes.filter((p) => p.data?.type === "contact_joined");

test("rematch: off by default, nothing kept; the switch validates and needs a token", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  assert.equal((await request(ctx.app).get("/me").set(auth(anna)).expect(200)).body.user.rematchOptIn, false);

  await match(anna, [sha(BEN), sha(CARL), sha(DANA)]);
  assert.equal(await AddressBookHash.countDocuments(), 0);

  await request(ctx.app).put("/me/rematch").send({ optIn: true }).expect(401);
  assert.equal((await optIn(anna, "yes").expect(400)).body.error, "invalid_optIn");
  assert.equal((await optIn(anna, undefined).expect(400)).body.error, "invalid_optIn");

  const on = await optIn(anna, true).expect(200);
  assert.deepEqual(on.body, { success: true, optIn: true });
  assert.equal((await request(ctx.app).get("/me").set(auth(anna)).expect(200)).body.user.rematchOptIn, true);
  const stored = await User.findOne({ phone: ANNA }, { rematch: 1 }).lean();
  assert.equal(stored.rematch.optIn, true);
  assert.ok(stored.rematch.at);
  // Switching it on stores nothing by itself: the app syncs right after
  assert.equal(await AddressBookHash.countDocuments(), 0);
});

test("rematch: with the opt-in only the unmatched hashes are kept, peppered, and replaced by the next sync", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await optIn(anna, true).expect(200);

  const res = await match(anna, [sha(BEN), sha(CARL), sha(DANA), sha(DANA), sha(ANNA), "nope"]);
  assert.deepEqual(res.body.matched.map((m) => m.phone), [BEN]);

  const doc = await AddressBookHash.findOne({ owner: ANNA }).lean();
  assert.deepEqual([...doc.hashes].sort(), [rematch.pepperHash(sha(CARL)), rematch.pepperHash(sha(DANA))].sort());
  // Never the SHA-256 the app sent, never a user's hash
  for (const plain of [sha(CARL), sha(DANA), sha(BEN), sha(ANNA)]) assert.ok(!doc.hashes.includes(plain));
  assert.ok(!doc.hashes.includes(rematch.pepperHash(sha(BEN))));
  assert.notEqual(rematch.pepperHash(sha(CARL)), sha(CARL));
  // The server pepper of User.hmacPhone, over the hash the app sent
  assert.equal(rematch.pepperHash(sha(CARL)), User.hmacPhone(sha(CARL)));
  const keep = doc.expiresAt - doc.updatedAt;
  assert.ok(Math.abs(keep - 90 * DAY) < 1000, `kept ${keep} ms`);

  // The next sync replaces the list
  await match(anna, [sha(EVA)]);
  assert.deepEqual((await AddressBookHash.findOne({ owner: ANNA }).lean()).hashes, [rematch.pepperHash(sha(EVA))]);
  // A sync where everybody is a user leaves no list
  await match(anna, [sha(BEN)]);
  assert.equal(await AddressBookHash.countDocuments({ owner: ANNA }), 0);

  // A request that looks like a scan (over 2,000 hashes, no match) is never kept
  const scan = Array.from({ length: 2100 }, () => crypto.randomBytes(32).toString("hex"));
  await match(anna, scan);
  assert.equal(await AddressBookHash.countDocuments({ owner: ANNA }), 0);
});

test("rematch: a sign-up with a name tells the owners once, not the blocked, not an inviter twice; the entry leaves every list", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const dana = await login(DANA, "Dana");
  const eva = await login(EVA, "Eva");
  for (const token of [anna, ben, dana, eva]) await optIn(token, true).expect(200);
  for (const token of [anna, ben, dana, eva]) await match(token, [sha(CARL)]);
  assert.equal(await AddressBookHash.countDocuments({ hashes: rematch.pepperHash(sha(CARL)) }), 4);
  // Ben blocked the number; Dana invited Carl; Eva switched off since (her
  // list stays here only to show the owner check)
  await Block.create({ blocker: BEN, blocked: CARL });
  await request(ctx.app).post("/invites").set(auth(dana)).send({ hashes: [sha(CARL)] }).expect(200);
  await User.updateOne({ phone: EVA }, { "rematch.optIn": false });

  const carl = await login(CARL); // no name yet: nobody hears anything
  await settle();
  assert.equal(joinedPushes().length, 0);
  assert.equal(await AddressBookHash.countDocuments({ hashes: rematch.pepperHash(sha(CARL)) }), 4);

  await request(ctx.app).post("/me/update").set(auth(carl)).send({ name: "Carl Weber" }).expect(200);
  await settle();
  const pushes = joinedPushes();
  assert.deepEqual(pushes.map((p) => p.to).sort(), ["ExponentPushToken[Anna]", "ExponentPushToken[Dana]"]);
  const toAnna = pushes.find((p) => p.to === "ExponentPushToken[Anna]");
  assert.equal(toAnna.title, "Carl ist jetzt dabei 🎉");
  assert.match(toAnna.body, /Adressbuch/);
  assert.equal(toAnna.data.phone, CARL);
  // Dana hears it from her invite, with the invite text
  assert.match(pushes.find((p) => p.to === "ExponentPushToken[Dana]").body, /Einladung/);
  // The entry is gone from every list
  assert.equal(await AddressBookHash.countDocuments({ hashes: rematch.pepperHash(sha(CARL)) }), 0);

  // A second name change tells nobody again
  await request(ctx.app).post("/me/update").set(auth(carl)).send({ name: "Carl" }).expect(200);
  await settle();
  assert.equal(joinedPushes().length, 2);
});

test("rematch: opt-out and account deletion remove the list; the export counts, never lists, the entries", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await optIn(anna, true).expect(200);
  await optIn(ben, true).expect(200);
  await match(anna, [sha(CARL), sha(DANA)]);
  await match(ben, [sha(CARL)]);

  const exported = (await request(ctx.app).get("/me/export").set(auth(anna)).expect(200)).body.data.rematch;
  assert.equal(exported.optIn, true);
  assert.equal(exported.storedHashes, 2);
  assert.ok(exported.expiresAt);
  assert.ok(!JSON.stringify(exported).includes(rematch.pepperHash(sha(CARL))));

  // Opt-out: gone at once
  assert.deepEqual((await optIn(ben, false).expect(200)).body, { success: true, optIn: false });
  assert.equal(await AddressBookHash.countDocuments({ owner: BEN }), 0);
  await match(ben, [sha(CARL)]);
  assert.equal(await AddressBookHash.countDocuments({ owner: BEN }), 0, "nothing kept without the opt-in");

  // Deletion: the own list, and the own entry in other lists (Dana never set a name)
  await optIn(ben, true).expect(200);
  await match(ben, [sha(DANA)]);
  const dana = await login(DANA);
  await optIn(dana, true).expect(200);
  await match(dana, [sha(EVA)]);
  await request(ctx.app).delete("/me").set(auth(dana)).expect(200);
  assert.equal(await AddressBookHash.countDocuments({ owner: DANA }), 0);
  assert.equal(await AddressBookHash.countDocuments({ hashes: rematch.pepperHash(sha(DANA)) }), 0);
  assert.deepEqual((await AddressBookHash.findOne({ owner: ANNA }).lean()).hashes, [rematch.pepperHash(sha(CARL))]);

  await request(ctx.app).delete("/me").set(auth(anna)).expect(200);
  assert.equal(await AddressBookHash.countDocuments({ owner: ANNA }), 0);
});

test("rematch: TTL and multikey index, at most 5,000 entries", async () => {
  await AddressBookHash.syncIndexes();
  const indexes = await AddressBookHash.collection.indexes();
  const ttl = indexes.find((i) => i.key.expiresAt === 1);
  assert.ok(ttl, "TTL index on expiresAt");
  assert.equal(ttl.expireAfterSeconds, 0);
  assert.ok(indexes.some((i) => i.key.hashes === 1), "index on hashes");
  assert.ok(indexes.some((i) => i.key.owner === 1 && i.unique), "one list per owner");

  const many = Array.from({ length: 6000 }, () => crypto.randomBytes(32).toString("hex"));
  assert.equal(await rematch.storeHashes(ANNA, many), rematch.MAX_HASHES);
  const doc = await AddressBookHash.findOne({ owner: ANNA }).lean();
  assert.equal(doc.hashes.length, 5000);
  assert.equal(rematch.MAX_HASHES, 5000);
});
