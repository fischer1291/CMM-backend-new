// Backend error tracking (lib/sentry.js, plan 2.1): what may leave the server
// in a Sentry event (no numbers, no e-mail addresses, no bodies, cookies,
// query strings or personal headers), and that nothing runs without a DSN
// or under tests. Pure functions, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sentry = require("../lib/sentry");

test("scrubText: phone numbers (also spaced and URL-encoded), bare digit runs and e-mail addresses are replaced", () => {
  assert.equal(sentry.scrubText("Call from +4915111111111 failed"), "Call from [Nummer] failed");
  assert.equal(sentry.scrubText("to +49 151 1111 1111."), "to [Nummer].");
  assert.equal(sentry.scrubText("/verify/start?phone=%2B4915111111111"), "/verify/start?phone=[Nummer]");
  assert.equal(sentry.scrubText("avatar_4915111111111 uploaded"), "avatar_[Nummer] uploaded");
  assert.equal(sentry.scrubText("mail to anna.b+x@example.com bounced"), "mail to [E-Mail] bounced");
  assert.equal(sentry.scrubText("anna%40example.de"), "[E-Mail]");
  // Short numbers stay: ports, counts, status codes, years
  assert.equal(sentry.scrubText("HTTP 502 after 3000 ms on port 27017 in 2026"), "HTTP 502 after 3000 ms on port 27017 in 2026");
  assert.equal(sentry.scrubText(undefined), undefined);
});

test("stripQuery: path only", () => {
  assert.equal(sentry.stripQuery("https://api.wannayap.app/verify/start?phone=%2B49151&x=1"), "https://api.wannayap.app/verify/start");
  assert.equal(sentry.stripQuery("/calls#top"), "/calls");
  assert.equal(sentry.stripQuery("/healthz"), "/healthz");
});

test("scrub: request without body, cookies, query and personal headers; no user; strings everywhere scrubbed; ids intact", () => {
  const event = {
    event_id: "0123456789abcdef0123456789abcdef",
    release: "4c0ffee1234567890",
    timestamp: 1790000000.123,
    user: { id: "+4915111111111", ip_address: "203.0.113.7" },
    message: "verify/check failed for +4915111111111",
    exception: { values: [{ type: "Error", value: "E11000 duplicate key { phone: \"+4915222222222\" } anna@example.com", stacktrace: { frames: [{ filename: "/opt/render/project/src/routes/verify.js", lineno: 120 }] } }] },
    request: {
      method: "POST",
      url: "https://api.wannayap.app/verify/check?phone=%2B4915111111111",
      query_string: "phone=%2B4915111111111",
      data: { phone: "+4915111111111", code: "123456" },
      cookies: { wy_admin: "secret" },
      env: { REMOTE_ADDR: "203.0.113.7" },
      headers: {
        Authorization: "Bearer eyJ…",
        Cookie: "wy_admin=secret",
        "X-Forwarded-For": "203.0.113.7",
        "User-Agent": "WannaYap/1.4.0 CFNetwork",
        "x-app-version": "1.4.0",
        "x-app-build": "52",
        "x-app-update": "a1b2c3",
        "x-platform": "ios",
      },
    },
    breadcrumbs: [
      { category: "console", message: "❌ verify/start failed: +4915111111111", timestamp: 1790000000 },
      { category: "http", data: { url: "https://verify.twilio.com/v2/Services/VA1/Verifications?To=%2B4915111111111", method: "POST" } },
    ],
    extra: { note: "von bob@example.com" },
    contexts: { trace: { trace_id: "1234567890123456789012345678901a", span_id: "1234567890123456" } },
  };
  const out = sentry.scrub(event);

  assert.equal(out.user, undefined, "the backend never sends a user");
  assert.equal(out.event_id, event.event_id);
  assert.equal(out.release, event.release);
  assert.equal(out.timestamp, event.timestamp);
  assert.deepEqual(out.contexts.trace, event.contexts.trace, "trace ids are no phone numbers");
  assert.equal(out.message, "verify/check failed for [Nummer]");
  assert.equal(out.exception.values[0].value, 'E11000 duplicate key { phone: "[Nummer]" } [E-Mail]');
  assert.equal(out.exception.values[0].stacktrace.frames[0].lineno, 120);

  assert.equal(out.request.url, "https://api.wannayap.app/verify/check");
  for (const gone of ["data", "cookies", "query_string", "env"]) assert.equal(out.request[gone], undefined, gone);
  assert.deepEqual(Object.keys(out.request.headers).sort(), ["User-Agent", "x-app-build", "x-app-update", "x-app-version", "x-platform"]);
  assert.equal(out.request.method, "POST");

  assert.equal(out.breadcrumbs[0].message, "❌ verify/start failed: [Nummer]");
  assert.equal(out.breadcrumbs[1].data.url, "https://verify.twilio.com/v2/Services/VA1/Verifications");
  assert.equal(out.extra.note, "von [E-Mail]");

  // Nothing personal anywhere in the serialized event
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /4915111111111|4915222222222|example\.com|203\.0\.113\.7|secret|eyJ/);
  // The input is left alone
  assert.equal(event.request.data.phone, "+4915111111111");
});

test("init: off without SENTRY_DSN and under NODE_ENV=test; every export is then a no-op", async () => {
  assert.equal(sentry.init({ NODE_ENV: "production" }), false);
  assert.equal(sentry.init({ NODE_ENV: "test", SENTRY_DSN: "https://key@o1.ingest.de.sentry.io/1" }), false);
  assert.equal(sentry.active(), false);
  assert.doesNotThrow(() => sentry.captureException(new Error("boom"), { level: "fatal" }));
  assert.equal(await sentry.flush(10), true);
  const app = { use: () => assert.fail("no middleware without DSN") };
  sentry.setupExpressErrorHandler(app);
});
