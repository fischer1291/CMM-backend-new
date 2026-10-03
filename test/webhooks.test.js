// POST /webhooks/sentry (routes/webhooks.js, plan 2.1): only signed calls
// count, a new fatal or error-level crash becomes the alert sentry_fatal
// (push, mail, SMS), anything else is acknowledged and ignored, and the
// alert never carries the error message or the event's user data.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const AlertState = require("../models/AlertState");
const adminPush = require("../lib/adminPush");
const opsCounters = require("../lib/opsCounters");
const { saveConfig } = require("../lib/appConfig");
const { todayKey } = require("../lib/metrics");
const { totpAt, currentStep } = require("../lib/adminAuth");
const { sentryAlertText, sentrySignatureValid } = require("../routes/webhooks");

const SECRET = "sentry-client-secret-for-tests-0123456789abcdef";
let ctx;
let sent = [];

before(async () => {
  process.env.SENTRY_WEBHOOK_SECRET = SECRET;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test";
  process.env.TWILIO_SMS_FROM = "+4915799999999";
  adminPush.setSender(async (sub, payload, options) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
  });
  ctx = await setup();
});
after(async () => {
  delete process.env.SENTRY_WEBHOOK_SECRET;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
  await teardown();
});
beforeEach(async () => {
  await reset();
  await AlertState.syncIndexes();
  sent = [];
});

const EMAIL = "owner@example.com";
const SUB = { endpoint: "https://web.push.apple.com/QGx-sentry-device", keys: { p256dh: "BPubKeyTest", auth: "authTest" } };
/** An owner with a subscribed phone and the alert SMS number. */
async function owner() {
  const who = { email: EMAIL, password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  const cookie = (done.headers["set-cookie"] || [])[0]?.split(";")[0];
  await request(ctx.app).post("/admin/push/subscribe").set({ Cookie: cookie, "X-Admin-Request": "1" }).send({ subscription: SUB }).expect(200);
  await saveConfig({ ops: { alertPhone: "+49 171 1234567" } }, EMAIL);
}

const sign = (body, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");
/** POST the payload as Sentry does: raw JSON, signed, with the resource header. */
function hook(resource, payload, { signature } = {}) {
  const body = JSON.stringify(payload);
  return request(ctx.app)
    .post("/webhooks/sentry")
    .set("Content-Type", "application/json")
    .set("Sentry-Hook-Resource", resource)
    .set("Sentry-Hook-Timestamp", String(Math.floor(Date.now() / 1000)))
    .set("Sentry-Hook-Signature", signature ?? sign(body))
    .send(body);
}
/** The alert goes out after the answer: wait until it has (or give up). */
async function settle(until = () => sent.length > 0, ms = 2000) {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  // a little longer, so a second (wrong) alert would show up too
  await new Promise((r) => setTimeout(r, 50));
}

const SECRET_MESSAGE = "TypeError: cannot read 'name' of undefined for +4915111111111 (anna@example.com)";
const ISSUE = {
  action: "created",
  installation: { uuid: "7a485448-a9e2-4c85-8a3c-4f44175783c9" },
  data: {
    issue: {
      id: "1170820242",
      shortId: "WANNAYAP-IOS-3F",
      title: SECRET_MESSAGE,
      culprit: "CallScreen in +4915111111111",
      level: "fatal",
      project: { id: "1", name: "wannayap-ios", slug: "wannayap-ios", platform: "react-native" },
      web_url: "https://wannayap.sentry.io/issues/1170820242/",
      metadata: { value: SECRET_MESSAGE },
    },
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
};
const EVENT_ALERT = {
  action: "triggered",
  data: {
    event: {
      event_id: "e4874d664c3540c1a32eab185f12c5ab",
      level: "error",
      project: 1,
      release: "4c0ffee1234567890abcdef",
      issue_id: "1170820243",
      title: SECRET_MESSAGE,
      message: SECRET_MESSAGE,
      user: { id: "+4915111111111", email: "anna@example.com" },
      web_url: "https://sentry.io/organizations/wannayap/issues/1170820243/events/e4874d664c3540c1a32eab185f12c5ab/",
      issue_url: "https://sentry.io/api/0/issues/1170820243/",
      url: "https://sentry.io/api/0/projects/wannayap/wannayap-backend/events/e4874d664c3540c1a32eab185f12c5ab/",
    },
    triggered_rule: "Neuer Absturz",
  },
};

test("sentry webhook: a signed new fatal issue alerts the owner by push, mail and SMS, without the message", async () => {
  await owner();
  const res = await hook("issue", ISSUE).expect(200);
  assert.deepEqual(res.body, { success: true });
  await settle(() => sent.length > 0 && fakes.alertSms.length > 0);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Neuer Absturz (Sentry)");
  assert.equal(sent[0].options.topic, "alert-sentry_fatal");
  assert.equal(sent[0].options.urgency, "high");
  assert.equal(sent[0].payload.body, "Neuer fataler Absturz in Projekt wannayap-ios, Issue WANNAYAP-IOS-3F. https://wannayap.sentry.io/issues/1170820242/");
  assert.equal(fakes.mails.length, 1);
  assert.equal(fakes.mails[0].subject, "[Wanna yap?] Neuer Absturz (Sentry)");
  assert.equal(fakes.alertSms.length, 1, "level error: SMS to the alert number");
  const state = await AlertState.findOne({ tag: "sentry_fatal" }).lean();
  assert.equal(state.level, "error");

  // Nothing of the message or the user's data reaches push, mail or SMS
  const everything = JSON.stringify([sent, fakes.mails, fakes.alertSms, state]);
  assert.doesNotMatch(everything, /TypeError|cannot read|4915111111111|anna@example\.com|CallScreen/);
});

test("sentry webhook: an alert rule event (event_alert, level error) alerts with project, release and link", async () => {
  await owner();
  await hook("event_alert", EVENT_ALERT).expect(200);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.body, "Neuer Fehler in Projekt wannayap-backend, Release 4c0ffee12345, Issue 1170820243. https://sentry.io/organizations/wannayap/issues/1170820243/events/e4874d664c3540c1a32eab185f12c5ab/");
  assert.doesNotMatch(JSON.stringify([sent, fakes.mails, fakes.alertSms]), /TypeError|4915111111111|anna@example\.com/);
});

test("sentry webhook: a wrong or missing signature is refused with 401, counted, and alerts nobody", async () => {
  await owner();
  await hook("issue", ISSUE, { signature: sign(JSON.stringify(ISSUE), "another-secret") }).expect(401);
  await hook("issue", ISSUE, { signature: "not-hex" }).expect(401);
  // Signed body, but a changed payload
  const body = JSON.stringify(ISSUE);
  await request(ctx.app).post("/webhooks/sentry").set("Content-Type", "application/json").set("Sentry-Hook-Resource", "issue").set("Sentry-Hook-Signature", sign(body)).send(body.replace("fatal", "error")).expect(401);
  await request(ctx.app).post("/webhooks/sentry").set("Content-Type", "application/json").set("Sentry-Hook-Resource", "issue").send(body).expect(401);
  // Without a configured secret nothing is accepted, not even a correct-looking call
  delete process.env.SENTRY_WEBHOOK_SECRET;
  try {
    await hook("issue", ISSUE).expect(401);
  } finally {
    process.env.SENTRY_WEBHOOK_SECRET = SECRET;
  }
  await settle(() => false, 200);
  assert.equal(sent.length, 0);
  assert.equal(fakes.mails.length, 0);
  assert.equal(await AlertState.countDocuments({ tag: "sentry_fatal" }), 0);
  assert.equal((await opsCounters.countsOf(todayKey())).sentryUnauthorized, 5);
});

test("sentry webhook: other resources, other actions and lower levels are acknowledged and ignored", async () => {
  await owner();
  await hook("installation", { action: "created", data: { installation: { uuid: "x" } } }).expect(200);
  await hook("issue", { ...ISSUE, action: "resolved" }).expect(200);
  await hook("issue", { ...ISSUE, data: { issue: { ...ISSUE.data.issue, level: "warning" } } }).expect(200);
  // issue webhooks reach us for every project and level, past the alert
  // rules' filters: a new error-level issue (a handled app error) is no alarm
  await hook("issue", { ...ISSUE, data: { issue: { ...ISSUE.data.issue, level: "error" } } }).expect(200);
  await hook("event_alert", { ...EVENT_ALERT, data: { event: { ...EVENT_ALERT.data.event, level: "info" } } }).expect(200);
  await hook("error", { action: "created", data: { error: { level: "fatal" } } }).expect(200);
  await settle(() => false, 200);
  assert.equal(sent.length, 0);
  assert.equal(await AlertState.countDocuments({ tag: "sentry_fatal" }), 0);
  // A signed body that is no JSON
  const junk = "not json";
  await request(ctx.app).post("/webhooks/sentry").set("Content-Type", "application/json").set("Sentry-Hook-Resource", "issue").set("Sentry-Hook-Signature", sign(junk)).send(junk).expect(400);
});

test("sentry webhook: a body over 256 kB is refused before anything else", async () => {
  const big = JSON.stringify({ action: "created", data: { pad: "x".repeat(300 * 1024) } });
  const res = await hook("issue", JSON.parse(big)).expect(413);
  assert.equal(res.body.error, "too_large");
});

test("sentryAlertText: only Sentry links, only plain identifiers, release cut to 12 characters", () => {
  const issue = (over) => ({ action: "created", data: { issue: { level: "fatal", ...over } } });
  assert.equal(sentryAlertText("issue", issue({})), "Neuer fataler Absturz in Sentry. Details in Sentry.");
  // issue/created alerts at fatal only, event_alert (filtered by the rule) at fatal and error
  assert.equal(sentryAlertText("issue", issue({ level: "error" })), null);
  const event = (over) => ({ data: { event: { level: "error", ...over } } });
  assert.equal(sentryAlertText("event_alert", event({})), "Neuer Fehler in Sentry. Details in Sentry.");
  // A numeric project id is left out, unless the event's API url names the slug
  assert.equal(sentryAlertText("event_alert", event({ project: 4505123456 })), "Neuer Fehler in Sentry. Details in Sentry.");
  assert.equal(sentryAlertText("event_alert", event({ project: 4505123456, url: "https://wannayap.sentry.io/api/0/projects/wannayap/wannayap-ios/events/abc/" })), "Neuer Fehler in Projekt wannayap-ios. Details in Sentry.");
  assert.equal(sentryAlertText("event_alert", event({ project: 1, url: "https://evil.example/api/0/projects/o/x/events/abc/" })), "Neuer Fehler in Sentry. Details in Sentry.");
  // Links outside sentry.io are dropped
  assert.equal(sentryAlertText("issue", issue({ web_url: "https://sentry.io.evil.example/issues/1/" })), "Neuer fataler Absturz in Sentry. Details in Sentry.");
  assert.equal(sentryAlertText("issue", issue({ web_url: "http://sentry.io/issues/1/" })), "Neuer fataler Absturz in Sentry. Details in Sentry.");
  assert.match(sentryAlertText("issue", issue({ web_url: "https://de.sentry.io/organizations/w/issues/1/" })), /https:\/\/de\.sentry\.io\//);
  // A project name with text in it is no identifier
  assert.equal(sentryAlertText("issue", issue({ project: { slug: "Ruf +49151 an" }, shortId: "A B" })), "Neuer fataler Absturz in Sentry. Details in Sentry.");
  // The app's release "<bundleId>@<version>+<build>" keeps the version
  assert.equal(sentryAlertText("event_alert", { data: { event: { level: "fatal", release: "com.schly21.kontaktlisteapp@1.4.0+52" } } }), "Neuer fataler Absturz in Sentry, Release 1.4.0+52. Details in Sentry.");
  assert.equal(sentryAlertText("event_alert", { data: {} }), null);
  assert.equal(sentryAlertText("issue", null), null);
  assert.equal(sentrySignatureValid(Buffer.from("{}"), sign("{}"), SECRET), true);
  assert.equal(sentrySignatureValid(Buffer.from("{}"), sign("{}"), ""), false);
});
