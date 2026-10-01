// Who may call whom (lib/relations.js isConnected, lib/calls.js startCall)
// and what /contacts/match gives away. The call flow itself (decline, miss,
// accept, history) is tested in test/api.test.js.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { io: connect } = require("socket.io-client");
const { setup, teardown, reset, fakes, befriend } = require("./helpers");
const User = require("../models/User");
const Call = require("../models/Call");
const Circle = require("../models/Circle");
const Invite = require("../models/Invite");
const { saveConfig } = require("../lib/appConfig");
const { computeDay, todayKey } = require("../lib/metrics");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  if (name) await User.updateOne({ phone }, { name, pushToken: `ExponentPushToken[${name}]` });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const socketFor = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(ctx.url, { transports: ["websocket"], auth: { token }, forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
const once = (socket, event, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
const match = (token, phones) =>
  request(ctx.app).post("/contacts/match").set(auth(token)).send({ hashes: phones.map(User.hashPhone) }).expect(200);
const contactsOf = async (phone) => (await User.findOne({ phone })).contacts.sort();

test("calls: strangers can't ring anyone; the caller hears not_connected and the day counts it", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  const caller = await socketFor(anna);
  try {
    const failed = once(caller, "callFailed");
    caller.emit("callRequest", { to: BEN, channel: "call_stranger" });
    const event = await failed;
    assert.equal(event.reason, "not_connected");
    assert.equal(event.target, BEN);
    assert.equal(event.channel, "call_stranger");
    assert.equal(await Call.countDocuments(), 0, "nothing rang, nothing is on record");
    assert.equal(fakes.expoPushes.length, 0);
  } finally {
    caller.close();
  }
  // One side knowing the other isn't enough
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  assert.deepEqual(await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_one_sided" }), { ok: false, reason: "not_connected" });
  await settle();
  assert.equal((await computeDay(todayKey())).ops.callsRejectedNotConnected, 2);
});

test("calls: mutual contacts ring each other", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  const caller = await socketFor(anna);
  const callee = await socketFor(ben);
  try {
    const incoming = once(callee, "incomingCall");
    caller.emit("callRequest", { to: BEN, channel: "call_friends" });
    assert.equal((await incoming).from, ANNA);
    assert.equal((await Call.findOne({ channel: "call_friends" })).status, "ringing");
  } finally {
    caller.close();
    callee.close();
  }
});

test("calls: members of the same circle ring each other without having the number", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  await Circle.create({ name: "Crew", createdBy: ANNA, members: [{ phone: ANNA }, { phone: BEN }], code: "CREW2345" });
  const result = await ctx.calls.startCall({ from: BEN, to: ANNA, channel: "call_circle" });
  assert.equal(result.ok, true);
  assert.equal((await Call.findOne({ channel: "call_circle" })).status, "ringing");
  // Carl is in no circle with Anna
  assert.deepEqual(await ctx.calls.startCall({ from: CARL, to: ANNA, channel: "call_outsider" }), { ok: false, reason: "not_connected" });
});

test("calls: an invited pair stays connected through address book syncs without the number", async () => {
  const ben = await login(BEN, "Ben");
  await Invite.create({ from: BEN, toHash: User.hashPhone(ANNA) });
  const anna = await login(ANNA, "Anna");
  await settle(); // connectInviters runs after the sign-up answer
  assert.deepEqual((await User.findOne({ phone: ANNA })).connections, [BEN]);
  assert.deepEqual((await User.findOne({ phone: BEN })).connections, [ANNA]);

  // Neither has the other's number: Ben's book only knows Carl, Anna's is empty
  await login(CARL, "Carl");
  const seen = await match(ben, [CARL]);
  assert.deepEqual(seen.body.matched.map((m) => m.phone), [CARL]);
  await match(anna, []);
  assert.deepEqual(await contactsOf(BEN), [ANNA, CARL]);
  assert.deepEqual(await contactsOf(ANNA), [BEN]);

  assert.equal((await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_invited" })).ok, true);

  // A block ends the connection for good
  await request(ctx.app).post("/blocks").set(auth(anna)).send({ phone: BEN }).expect(200);
  assert.deepEqual((await User.findOne({ phone: BEN })).connections, []);
  await match(anna, []);
  assert.deepEqual(await contactsOf(ANNA), []);
});

test("contacts/match: connections are merged into contacts from the document itself, whatever the timing", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await login(CARL, "Carl");
  // As if connectInviters had landed after the match had read the user
  await User.updateOne({ phone: ANNA }, { contacts: [], connections: [BEN] });
  await match(anna, []);
  assert.deepEqual(await contactsOf(ANNA), [BEN]);
  await match(anna, [CARL]);
  assert.deepEqual(await contactsOf(ANNA), [BEN, CARL]);
  // The legacy phones variant without a match is counted as suspicious too
  const probe = Array.from({ length: 2001 }, (_, i) => `+4917${String(i).padStart(8, "0")}`);
  await request(ctx.app).post("/contacts/match").set(auth(anna)).send({ phones: probe }).expect(200);
  await settle();
  assert.equal((await computeDay(todayKey())).ops.matchSuspicious, 1);
});

test("calls: the flag calls_strict_contacts=false lets strangers call during a rollout", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  assert.equal((await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_strict" })).reason, "not_connected");

  await saveConfig({ flags: { calls_strict_contacts: false } }, "owner@test");
  assert.equal((await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_lenient" })).ok, true);

  // Back to strict right away (no 30 s cache delay after a console change)
  await saveConfig({ flags: { calls_strict_contacts: true } }, "owner@test");
  assert.equal((await ctx.calls.startCall({ from: ANNA, to: CARL, channel: "call_strict_again" })).reason, "not_connected");
});

test("contacts/match: lastOnline only for people who know you too; a mass probe without hits is counted", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const when = new Date("2026-09-30T10:00:00Z");
  await User.updateMany({}, { lastOnline: when });

  // Anna has Ben's number, Ben doesn't have hers
  let res = await match(anna, [BEN]);
  assert.equal(res.body.matched[0].phone, BEN);
  assert.equal(res.body.matched[0].lastOnline, null);

  res = await match(ben, [ANNA]);
  assert.equal(new Date(res.body.matched[0].lastOnline).getTime(), when.getTime(), "Anna has Ben as a contact");
  res = await match(anna, [BEN]);
  assert.equal(new Date(res.body.matched[0].lastOnline).getTime(), when.getTime(), "now mutual");

  const probe = Array.from({ length: 2001 }, (_, i) => User.hashPhone(`+4917${String(i).padStart(8, "0")}`));
  await request(ctx.app).post("/contacts/match").set(auth(anna)).send({ hashes: probe }).expect(200);
  await settle();
  assert.equal((await computeDay(todayKey())).ops.matchSuspicious, 1);
  assert.deepEqual(await contactsOf(ANNA), [], "the probe replaced the address book matches, as any sync does");
});
