const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const DailyMoment = require("../models/DailyMoment");
const { localParts } = require("../lib/localTime");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const AUSTRIA = "+436641234567";
const TZ = "Europe/Berlin";
const DAY = 24 * 3600 * 1000;

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, timezone: TZ });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
let counter = 0;
const talk = (a, b, startedAt, minutes = 10) =>
  Talk.create({ callId: `b${++counter}`, participants: [a, b], startedAt, seconds: minutes * 60 });
const album = async (token) => (await request(ctx.app).get("/me/badges").set(auth(token)).expect(200)).body;
const badge = (body, id) => body.badges.find((b) => b.id === id);

test("album: categories, tiers, secrets stay secret until found", async () => {
  const anna = await login(ANNA, "Anna");
  // Yesterday around noon in Berlin: no night owl or early bird, whenever the test runs
  const noon = new Date(Date.now() - DAY);
  noon.setUTCHours(10, 0, 0, 0);
  for (let i = 0; i < 12; i++) await talk(ANNA, BEN, new Date(noon - i * 60 * 1000));
  const body = await album(anna);
  assert.deepEqual(body.categories.map((c) => c.title), ["Verbindung", "Tiefe", "Rituale", "Kreise", "Entdecken"]);

  const talks = badge(body, "talks");
  assert.equal(talks.tier, 1);
  assert.equal(talks.tierName, "Bronze");
  assert.equal(talks.next, 50);
  assert.equal(talks.description, "50 Gespräche geführt");

  const owl = badge(body, "night_owl");
  assert.equal(owl.title, "Geheim");
  assert.equal(owl.icon, "help");
  assert.equal(owl.earned, false);
});

test("album: new badges are announced once; the first visit sets the baseline", async () => {
  const anna = await login(ANNA, "Anna");
  await talk(ANNA, BEN, new Date());
  let body = await album(anna);
  assert.deepEqual(body.new, [], "already earned before the first visit: no flood");

  // A 35-minute talk: Tiefgang is new
  await talk(ANNA, BEN, new Date(), 35);
  body = await album(anna);
  assert.deepEqual(body.new.map((b) => b.id), ["deep_talk"]);
  await request(ctx.app).post("/me/badges/seen").set(auth(anna)).expect(200);
  assert.deepEqual((await album(anna)).new, []);
});

test("secret badges: night owl, long distance, reunion after 30 days, advent", async () => {
  const anna = await login(ANNA, "Anna");
  await talk(ANNA, BEN, new Date("2026-09-23T21:40:00Z")); // 23:40 in Berlin
  await talk(ANNA, AUSTRIA, new Date("2026-09-20T10:00:00Z"));
  await talk(ANNA, CARL, new Date("2026-06-01T10:00:00Z"));
  await talk(ANNA, CARL, new Date("2026-07-15T10:00:00Z")); // 44 days later
  await talk(ANNA, BEN, new Date("2025-12-10T17:00:00Z"));
  const body = await album(anna);
  for (const id of ["night_owl", "long_distance", "advent"]) {
    assert.equal(badge(body, id).earned, true, id);
  }
  assert.equal(badge(body, "night_owl").title, "Nachteule");
  assert.equal(badge(body, "reunion").tier, 1);
  assert.equal(badge(body, "early_bird").earned, false);
});

test("next up: the closest visible badge, as a hint", async () => {
  const anna = await login(ANNA, "Anna");
  for (let i = 0; i < 8; i++) await talk(ANNA, BEN, new Date(Date.now() - i * 60 * 1000), 2);
  const { nextUp } = await album(anna);
  assert.equal(nextUp.id, "talks");
  assert.equal(nextUp.hint, "Noch 2 Gespräche bis Gesprächig (Bronze)");
});

test("showcase: up to three earned badges, visible where stats are shared", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN], statsSharing: { visibility: "contacts", sharedWith: [] } });
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });
  await talk(ANNA, BEN, new Date(), 35);

  await request(ctx.app).put("/me/showcase").set(auth(anna)).send({ ids: ["marathon"] }).expect(400);
  await request(ctx.app).put("/me/showcase").set(auth(anna)).send({ ids: ["a", "b", "c", "d"] }).expect(400);
  await request(ctx.app).put("/me/showcase").set(auth(anna)).send({ ids: ["deep_talk", "first_talk"] }).expect(200);

  const shared = await request(ctx.app).get(`/stats/${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200);
  assert.deepEqual(shared.body.stats.showcase.map((b) => b.id), ["deep_talk", "first_talk"]);
  const friend = await request(ctx.app).get(`/friends/${encodeURIComponent(ANNA)}`).set(auth(ben)).expect(200);
  assert.deepEqual(friend.body.showcase.map((b) => b.title), ["Tiefgang", "Erstes Gespräch"]);
});

test("friendship badges: only for the two, from what they did together", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  for (let i = 0; i < 5; i++) await talk(ANNA, BEN, new Date(Date.now() - i * 7 * DAY), 15);
  await talk(ANNA, BEN, new Date(Date.now() - 400 * DAY + DAY), 5); // almost 400 days ago
  await talk(ANNA, CARL, new Date(), 60); // not theirs

  const body = (await request(ctx.app).get(`/friends/${encodeURIComponent(BEN)}`).set(auth(anna)).expect(200)).body;
  assert.equal(body.together.talks, 6);
  assert.equal(body.together.seconds, 80 * 60);
  const byId = Object.fromEntries(body.badges.map((b) => [b.id, b]));
  assert.equal(byId.f_talks.tier, 1);
  assert.equal(byId.f_time.tier, 1);
  assert.equal(byId.f_streak.tier, 1, "5 weeks in a row");
  assert.equal(byId.f_year.earned, true);

  // Carl doesn't know Ben
  await request(ctx.app).get(`/friends/${encodeURIComponent(BEN)}`).set(auth(carl)).expect(404);
});

test("circle badges: rooms, rituals, everyone in; personal: founder, host, blitz, bridge", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  const circle = await Circle.create({
    name: "Familie",
    emoji: "🏡",
    createdBy: ANNA,
    members: [{ phone: ANNA }, { phone: BEN }],
    code: "ABCDEFGH",
    goalWeeks: ["2026-09-14", "2026-09-21"],
  });
  const now = new Date();
  await Room.create({ circleId: circle._id, channel: "room_a", startedBy: ANNA, participants: [{ phone: ANNA, joinedAt: now }, { phone: BEN, joinedAt: now }], active: false });
  await Room.create({ circleId: circle._id, channel: "room_b", startedBy: "ritual", participants: [{ phone: ANNA, joinedAt: now }, { phone: BEN, joinedAt: now }], active: false });

  const detail = (await request(ctx.app).get(`/circles/${circle._id}`).set(auth(anna)).expect(200)).body.circle;
  const byId = Object.fromEntries(detail.badges.map((b) => [b.id, b]));
  assert.equal(byId.c_goal.tier, 1);
  assert.equal(byId.c_goal.current, 2);
  assert.equal(byId.c_rooms.current, 2);
  assert.equal(byId.c_ritual.earned, true);
  assert.equal(byId.c_all.earned, true);

  // Anna's own: founded, hosted, joined the daily moment in its first minute, brought someone in
  const { dateKey } = localParts(now, TZ);
  await DailyMoment.create({ day: dateKey, zone: TZ, at: new Date(now - 30 * 1000), endsAt: new Date(now.getTime() + 9 * 60 * 1000), sentAt: now });
  await request(ctx.app).post("/daily/join").set(auth(anna)).expect(200);
  await User.updateOne({ phone: ANNA }, { invitesJoined: 1 });
  const body = await album(anna);
  for (const id of ["founder", "host", "blitz", "daily", "bridge", "together"]) {
    assert.equal(badge(body, id).earned, true, id);
  }
});
