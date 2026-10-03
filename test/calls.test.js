// Who may call whom (lib/relations.js isConnected, lib/calls.js startCall),
// what /contacts/match gives away, and the sweep that ends rings a deploy
// left behind (sweepStaleCalls). The call flow itself (decline, miss, accept,
// history) is tested in test/api.test.js.
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

test("milestones: verified, contacts synced, first registered contact, push granted, first call; each set once", async () => {
  const anna = await login(ANNA, "Anna");
  const milestones = async (phone) => (await User.findOne({ phone }).lean()).milestones;
  let m = await milestones(ANNA);
  assert.ok(m.verifiedAt instanceof Date);
  for (const key of ["contactsSyncedAt", "firstRegisteredContactAt", "pushGrantedAt", "firstCallAt", "firstTalkAt"]) assert.equal(m[key], null, key);
  const { verifiedAt } = m;
  // Signing in again keeps the first time
  await login(ANNA);
  assert.equal(+(await milestones(ANNA)).verifiedAt, +verifiedAt);

  // A sync that finds nobody: synced, but no registered contact yet
  await match(anna, [CARL]);
  m = await milestones(ANNA);
  assert.ok(m.contactsSyncedAt instanceof Date);
  assert.equal(m.firstRegisteredContactAt, null);
  const { contactsSyncedAt } = m;
  const ben = await login(BEN, "Ben");
  await match(anna, [BEN]);
  m = await milestones(ANNA);
  assert.equal(+m.contactsSyncedAt, +contactsSyncedAt);
  assert.ok(m.firstRegisteredContactAt instanceof Date);

  await request(ctx.app).post("/user/push-token").set(auth(anna)).send({ token: "ExponentPushToken[anna]" }).expect(200);
  const { pushGrantedAt } = await milestones(ANNA);
  assert.ok(pushGrantedAt instanceof Date);
  await request(ctx.app).post("/user/push-token").set(auth(anna)).send({ token: "ExponentPushToken[anna2]" }).expect(200);
  assert.equal(+(await milestones(ANNA)).pushGrantedAt, +pushGrantedAt);

  // The first call that rang somebody counts for the caller only
  await match(ben, [ANNA]);
  assert.equal((await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_first" })).ok, true);
  const { firstCallAt } = await milestones(ANNA);
  assert.ok(firstCallAt instanceof Date);
  assert.equal((await milestones(BEN)).firstCallAt, null);
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_first" });
  assert.equal((await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_second" })).ok, true);
  assert.equal(+(await milestones(ANNA)).firstCallAt, +firstCallAt);
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_second" });

  // A call that reaches nobody (offline, no push token) is no first call
  const carl = await login(CARL, "Carl");
  await match(carl, [ANNA]);
  await match(anna, [CARL]);
  await User.updateOne({ phone: ANNA }, { $unset: { pushToken: 1, voipToken: 1 } });
  assert.equal((await ctx.calls.startCall({ from: CARL, to: ANNA, channel: "call_void" })).reason, "unreachable");
  assert.equal((await milestones(CARL)).firstCallAt, null);
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

// Plan 2.2: the sweep under the ring timers (lib/calls.js sweepStaleCalls)
const stale = (callId, fields) => Call.create({ callId, channel: callId, caller: ANNA, callee: BEN, status: "ringing", ...fields });

test("sweep: a call ringing past ringUntil is missed like the timer does it; both hear it, the callee is pushed", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  const caller = await socketFor(anna);
  const callee = await socketFor(ben);
  try {
    const now = new Date();
    await stale("call_overdue", { createdAt: new Date(now - 50_000), ringUntil: new Date(now - 5_000) });
    const callerEnded = once(caller, "callEnded");
    const calleeEnded = once(callee, "callEnded");
    assert.equal(await ctx.calls.sweepStaleCalls(now), 1);
    assert.deepEqual(await callerEnded, { from: BEN, channel: "call_overdue", reason: "missed" });
    assert.deepEqual(await calleeEnded, { from: ANNA, channel: "call_overdue", reason: "missed" });
    const call = await Call.findOne({ callId: "call_overdue" });
    assert.equal(call.status, "missed");
    assert.equal(+call.endedAt, +call.ringUntil, "ended as of the deadline, not the sweep");
    await settle();
    assert.ok(fakes.expoPushes.some((p) => p.to === "ExponentPushToken[Ben]" && p.title === "Verpasster Anruf" && p.body.startsWith("Anna")));
    assert.equal(fakes.expoPushes.filter((p) => p.title === "Verpasster Anruf").length, 1);
    // Idempotent: a second sweep finds nothing, nobody hears anything twice
    assert.equal(await ctx.calls.sweepStaleCalls(new Date()), 0);
    assert.equal(await Call.countDocuments({ status: "missed" }), 1);
  } finally {
    caller.close();
    callee.close();
  }
});

test("sweep: a ring within its deadline stays; a legacy document without ringUntil goes by its age", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  const now = new Date();
  await stale("call_fresh", { createdAt: now, ringUntil: new Date(now.getTime() + 40_000) });
  await stale("call_legacy_young", { createdAt: new Date(now - 30_000) });
  await stale("call_legacy_old", { createdAt: new Date(now - 100_000) });
  assert.equal((await Call.findOne({ callId: "call_legacy_old" })).ringUntil, null);

  assert.equal(await ctx.calls.sweepStaleCalls(now), 1);
  const status = async (callId) => (await Call.findOne({ callId })).status;
  assert.equal(await status("call_fresh"), "ringing");
  assert.equal(await status("call_legacy_young"), "ringing");
  assert.equal(await status("call_legacy_old"), "missed");
  assert.equal(+(await Call.findOne({ callId: "call_legacy_old" })).endedAt, +now, "no deadline on record: ended as of the sweep");
  await settle();
  assert.equal(fakes.expoPushes.filter((p) => p.title === "Verpasster Anruf").length, 1);

  // Once the deadline passed, the fresh one goes too
  assert.equal(await ctx.calls.sweepStaleCalls(new Date(now.getTime() + 41_000)), 1);
  assert.equal(await status("call_fresh"), "missed");
  assert.equal(await ctx.calls.sweepStaleCalls(new Date(now.getTime() + 41_000)), 0);
});

test("sweep: startCall writes the deadline; an accepted call nobody hung up ends after two hours as a capped talk", async () => {
  await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await befriend(ANNA, BEN);
  const before = Date.now();
  const { ok, call } = await ctx.calls.startCall({ from: ANNA, to: BEN, channel: "call_deadline" });
  assert.equal(ok, true);
  // test/helpers.js starts the app with a 1.5 s ring timeout
  assert.ok(call.ringUntil - call.createdAt >= 1400 && call.ringUntil - call.createdAt <= 1600, `ringUntil = createdAt + ring timeout, got ${call.ringUntil - call.createdAt}`);
  assert.ok(+call.ringUntil >= before + 1400);
  // Not yet due: the sweep leaves it to the timer
  assert.equal(await ctx.calls.sweepStaleCalls(new Date()), 0);
  await ctx.calls.endCall({ me: ANNA, other: BEN, channel: "call_deadline" });

  const Talk = require("../models/Talk");
  const now = new Date();
  const acceptedAt = new Date(now - 3 * 3600 * 1000);
  await Call.create({ callId: "call_hung", channel: "call_hung", caller: ANNA, callee: BEN, status: "accepted", createdAt: acceptedAt, acceptedAt });
  await Call.create({ callId: "call_live", channel: "call_live", caller: ANNA, callee: BEN, status: "accepted", createdAt: now, acceptedAt: now });
  assert.equal(await ctx.calls.sweepStaleCalls(now), 1);
  const hung = await Call.findOne({ callId: "call_hung" });
  assert.equal(hung.status, "ended");
  assert.equal(+hung.endedAt, +acceptedAt + 2 * 3600 * 1000, "ended as of the stale limit");
  assert.equal((await Call.findOne({ callId: "call_live" })).status, "accepted");
  const talk = await Talk.findOne({ callId: "call_hung" });
  assert.equal(talk.seconds, 2 * 3600);
  assert.deepEqual(talk.participants.sort(), [ANNA, BEN].sort());
  assert.equal(await ctx.calls.sweepStaleCalls(now), 0);
});
