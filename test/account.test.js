const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Talk = require("../models/Talk");
const Nudge = require("../models/Nudge");
const CallMoment = require("../models/CallMoment");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CARL = "+4915333333333";
const IMAGE = "data:image/jpeg;base64,AAAA";

async function login(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name });
  return res.body.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const postMoment = (token, targetPhone, screenshot = IMAGE) =>
  request(ctx.app).post("/moment/callmoment").set(auth(token)).send({ targetPhone, screenshot, mood: "😊", callDuration: "05:00" });

test("delete account: removes the user, their moments, talks, nudges and every trace in others' data", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  await login(CARL, "Carl");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN] });
  await User.updateOne({ phone: BEN }, { contacts: [ANNA, CARL], statsSharing: { visibility: "selected", sharedWith: [ANNA] } });
  await User.updateOne({ phone: CARL }, { contacts: [BEN] });

  await postMoment(anna, BEN).expect(200);
  await postMoment(ben, ANNA).expect(200); // Ben's moment, but it shows Anna
  const bensOther = (await postMoment(ben, CARL).expect(200)).body.callMoment._id;
  await request(ctx.app).post("/moment/react").set(auth(anna)).send({ momentId: bensOther, emoji: "❤️" });
  await Talk.create({ callId: "t1", participants: [ANNA, BEN], startedAt: new Date(), seconds: 600 });
  await Talk.create({ callId: "t2", participants: [BEN, CARL], startedAt: new Date(), seconds: 300 });
  await Nudge.create({ from: ANNA, to: BEN });

  await request(ctx.app).delete("/me").expect(401);
  await request(ctx.app).delete("/me").set(auth(anna)).expect(200);

  assert.equal(await User.countDocuments({ phone: ANNA }), 0);
  const moments = await CallMoment.find();
  assert.deepEqual(moments.map((m) => m.targetPhone), [CARL]);
  assert.equal(moments[0].totalReactions, 0);
  assert.deepEqual((await Talk.find()).map((t) => t.callId), ["t2"]);
  assert.equal(await Nudge.countDocuments(), 0);
  const benAfter = await User.findOne({ phone: BEN });
  assert.deepEqual(benAfter.contacts, [CARL]);
  assert.deepEqual(benAfter.statsSharing.sharedWith, []);

  // The old token no longer finds an account; signing up again starts fresh
  await request(ctx.app).get("/me").set(auth(anna)).expect(404);
  await request(ctx.app).delete("/me").set(auth(anna)).expect(404);
  await login(ANNA, "Anna neu");
  assert.equal((await User.findOne({ phone: ANNA })).contacts.length, 0);
});

test("export: everything stored about the user, as JSON", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await User.updateOne({ phone: ANNA }, { contacts: [BEN], pushToken: "ExponentPushToken[a]" });
  await postMoment(anna, BEN).expect(200);
  await Talk.create({ callId: "t1", participants: [ANNA, BEN], startedAt: new Date(), seconds: 600 });

  await request(ctx.app).get("/me/export").expect(401);
  const { body } = await request(ctx.app).get("/me/export").set(auth(anna)).expect(200);
  const data = body.data;
  assert.equal(data.profile.phone, ANNA);
  assert.equal(data.profile.name, "Anna");
  assert.deepEqual(data.contacts, [BEN]);
  assert.equal(data.devices.pushNotifications, true);
  assert.equal(data.moments.length, 1);
  assert.equal(data.moments[0].image, "(Bild in der Datenbank)");
  assert.deepEqual(data.conversations.map((c) => [c.with, c.seconds]), [[BEN, 600]]);
  assert.ok(!JSON.stringify(data).includes("ExponentPushToken"), "no push tokens in the export");
});

test("moments: pictures only as our Cloudinary uploads or inline images, no foreign URLs", async () => {
  const anna = await login(ANNA, "Anna");
  await login(BEN, "Ben");
  await postMoment(anna, BEN, "https://tracker.example.com/pixel.jpg").expect(400);
  await postMoment(anna, BEN, "https://res.cloudinary.com/othercloud/image/upload/x.jpg").expect(400);
  await postMoment(anna, BEN, "https://res.cloudinary.com/testcloud/image/upload/v1/moments/moment_1.jpg").expect(200);
  await postMoment(anna, BEN, IMAGE).expect(200);
  await request(ctx.app).post("/upload/moment").expect(401);
});

test("reactions: only on moments the user may see", async () => {
  const anna = await login(ANNA, "Anna");
  const ben = await login(BEN, "Ben");
  const carl = await login(CARL, "Carl");
  await User.updateOne({ phone: BEN }, { contacts: [ANNA] });
  const momentId = (await postMoment(anna, BEN).expect(200)).body.callMoment._id;

  // Carl knows neither of them
  await request(ctx.app).post("/moment/react").set(auth(carl)).send({ momentId, emoji: "❤️" }).expect(404);
  // Ben is in the moment and knows Anna
  await request(ctx.app).post("/moment/react").set(auth(ben)).send({ momentId, emoji: "❤️" }).expect(200);
  assert.equal((await CallMoment.findById(momentId)).totalReactions, 1);
});
