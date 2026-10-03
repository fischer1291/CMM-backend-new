// Consent and minimum age (plan 1.6): /verify/check stores what the app sent
// as User.consent, never refuses a sign-in without it, and /me and the export
// hand it back to the person only.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const CONSENT = { ageConfirmed: true, termsVersion: "2026-10-01", privacyVersion: "1. Oktober 2026" };

const check = (phone, extra = {}) => request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode, ...extra }).expect(200);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const consentOf = async (phone) => (await User.findOne({ phone }, { consent: 1 }).lean()).consent;

test("consent: ageConfirmed with the versions is stored once and returned to the person", async () => {
  const startedAt = Date.now();
  const { body } = await check(ANNA, CONSENT);
  const stored = await consentOf(ANNA);
  assert.ok(Date.parse(stored.ageConfirmedAt) >= startedAt - 1000);
  assert.equal(stored.termsVersion, "2026-10-01");
  assert.equal(stored.privacyVersion, "1. Oktober 2026");

  const me = await request(ctx.app).get("/me").set(auth(body.token)).expect(200);
  assert.deepEqual(me.body.user.consent, { ageConfirmedAt: stored.ageConfirmedAt.toISOString(), termsVersion: "2026-10-01", privacyVersion: "1. Oktober 2026" });
  const exported = await request(ctx.app).get("/me/export").set(auth(body.token)).expect(200);
  assert.equal(exported.body.data.consent.termsVersion, "2026-10-01");

  // Other people's profiles never carry it
  const ben = (await check(BEN, CONSENT)).body.token;
  const other = await request(ctx.app).get("/me").query({ phone: ANNA }).set(auth(ben)).expect(200);
  assert.equal(other.body.user.consent, undefined);
});

test("consent: without the fields nothing is stored and nothing is refused; an existing consent stays", async () => {
  const { body } = await check(ANNA);
  assert.ok(body.token);
  assert.deepEqual(await consentOf(ANNA), { ageConfirmedAt: null, termsVersion: null, privacyVersion: null });
  const me = await request(ctx.app).get("/me").set(auth(body.token)).expect(200);
  assert.deepEqual(me.body.user.consent, { ageConfirmedAt: null, termsVersion: null, privacyVersion: null });

  // Re-verifying an old login skips onboarding and sends nothing: keep it
  await check(ANNA, CONSENT);
  const first = await consentOf(ANNA);
  await check(ANNA);
  assert.deepEqual(await consentOf(ANNA), first);
});

test("consent: the same versions do not re-stamp it, a new version does", async () => {
  await check(ANNA, CONSENT);
  const first = await consentOf(ANNA);
  await new Promise((r) => setTimeout(r, 20));
  await check(ANNA, CONSENT);
  assert.deepEqual(await consentOf(ANNA), first);

  await check(ANNA, { ...CONSENT, privacyVersion: "1. November 2026" });
  const second = await consentOf(ANNA);
  assert.equal(second.privacyVersion, "1. November 2026");
  assert.equal(second.termsVersion, "2026-10-01");
  assert.ok(second.ageConfirmedAt > first.ageConfirmedAt, "re-confirmed under the new wording");
});

test("consent: only a real true counts; bad versions are stored as null, the sign-in still works", async () => {
  await check(ANNA, { ageConfirmed: "true", termsVersion: "2026-10-01" });
  assert.equal((await consentOf(ANNA)).ageConfirmedAt, null);
  await check(ANNA, { ageConfirmed: false, termsVersion: "2026-10-01" });
  assert.equal((await consentOf(ANNA)).ageConfirmedAt, null);

  await check(ANNA, { ageConfirmed: true, termsVersion: "x".repeat(41), privacyVersion: { not: "a string" } });
  const stored = await consentOf(ANNA);
  assert.ok(stored.ageConfirmedAt);
  assert.equal(stored.termsVersion, null);
  assert.equal(stored.privacyVersion, null);
});
