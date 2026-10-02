// The export family (routes/adminExport.js, plan 2.4): four CSVs for owners,
// audited, in the waitlist export's dialect, without phone numbers, app user
// ids or message texts; support and viewer get 403.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset } = require("./helpers");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const User = require("../models/User");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const SupportTicket = require("../models/SupportTicket");
const MarketingSpend = require("../models/MarketingSpend");
const MetricsDaily = require("../models/MetricsDaily");
const { totpAt, currentStep, signSession, hashPassword, newTotpSecret, COOKIE } = require("../lib/adminAuth");
const { EXPORTS } = require("../routes/adminExport");

let ctx;
before(async () => {
  ctx = await setup();
});
after(teardown);
beforeEach(reset);

const EMAIL = "owner@example.com";
const PASSWORD = "a-long-admin-password";
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];

/** Sets up the first admin (an owner); returns the session cookie. */
async function ownerCookie() {
  const started = await request(ctx.app).post("/admin/auth/setup").send({ email: EMAIL, password: PASSWORD, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app)
    .post("/admin/auth/setup/confirm")
    .send({ email: EMAIL, password: PASSWORD, code: totpAt(started.body.secret, currentStep()) })
    .expect(200);
  return cookieOf(done);
}

/** A signed-in admin of another role, without the invitation dance. */
async function roleCookie(role) {
  const admin = await Admin.create({ email: `${role}@example.com`, passwordHash: hashPassword(PASSWORD), totpSecret: newTotpSecret(), totpEnabled: true, role });
  return `${COOKIE}=${encodeURIComponent(signSession(admin))}`;
}

const lines = (res) => res.text.replace(/^﻿/, "").split("\n");

test("exports: owners get CSV with BOM, semicolons and a header; every download is audited", async () => {
  const cookie = await ownerCookie();
  assert.deepEqual(EXPORTS, ["metrics", "plus", "marketing-spend", "support"]);
  for (const name of EXPORTS) {
    const res = await request(ctx.app).get(`/admin/export/${name}.csv`).set("Cookie", cookie).expect(200);
    assert.match(res.headers["content-type"], /^text\/csv/);
    assert.match(res.headers["content-disposition"], new RegExp(`attachment; filename="${name}-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
    assert.ok(res.text.startsWith("﻿"), "BOM for Excel");
    const [header, ...rows] = lines(res);
    assert.ok(header.split(";").length >= 10, header);
    assert.ok(header.split(";").every((h) => /^"[a-z0-9_]+"$/.test(h)), header);
    assert.equal(rows.length, 0, "nothing stored yet");
  }
  const audited = await AdminAudit.find({ action: /^export_/ }).lean();
  assert.deepEqual(audited.map((a) => a.action).sort(), ["export_marketing-spend", "export_metrics", "export_plus", "export_support"]);
  assert.ok(audited.every((a) => a.admin === EMAIL && a.meta.count === 0));
  await request(ctx.app).get("/admin/export/users.csv").set("Cookie", cookie).expect(404);
});

test("exports: one row per record, the id instead of the phone number, no message texts or app user ids", async () => {
  const cookie = await ownerCookie();
  const user = await User.create({ phone: "+4915111111111", phoneHash: User.hashPhone("+4915111111111") });
  await SubscriptionEvent.create({
    rcEventId: "evt-1",
    userId: user._id,
    appUserId: String(user._id),
    type: "INITIAL_PURCHASE",
    productId: "wannayap_plus_monthly",
    environment: "PRODUCTION",
    periodType: "NORMAL",
    priceCents: 549,
    currency: "EUR",
    priceInPurchasedCurrencyCents: 499,
    takehomePercent: 0.85,
    eventAt: new Date("2026-09-29T12:00:00Z"),
    result: "ok",
  });
  await SupportTicket.create({
    phone: "+4915111111111",
    category: "bug",
    status: "answered",
    messages: [
      { from: "user", text: "Geheimer Text der Nutzerin", at: new Date("2026-09-29T12:00:00Z") },
      { from: "support", text: "Antwort", by: EMAIL, at: new Date("2026-09-29T13:00:00Z") },
    ],
    app: { version: "1.4.0", build: "42", platform: "ios", os: "18.1" },
  });
  await MarketingSpend.create({ day: "2026-09-29", week: "2026-09-28", provider: "anthropic", purpose: "plan", estimateEur: 0.5, costEur: 0.42, status: "settled" });
  await MetricsDaily.create({ day: "2026-09-29", partial: false, version: 2, users: { total: 3, new: 1 }, plus: { activeStore: 1, newPaid: 1, mrrCents: 499 }, ops: { smsStarted: 2 } });

  const plus = lines(await request(ctx.app).get("/admin/export/plus.csv").set("Cookie", cookie).expect(200));
  assert.equal(plus.length, 2);
  assert.equal(plus[0].split(";")[0], '"ereignis_id"');
  const cells = plus[1].split(";");
  assert.equal(cells[0], '"evt-1"');
  assert.equal(cells[3], `"${user._id}"`);
  assert.ok(!plus[0].includes("app_user"), "no app user id column");
  assert.ok(plus[1].includes('"499"') && plus[1].includes('"85"'));

  const support = lines(await request(ctx.app).get("/admin/export/support.csv").set("Cookie", cookie).expect(200));
  assert.equal(support.length, 2);
  assert.ok(!support[1].includes("+4915") && !support[1].includes("Geheimer"), support[1]);
  assert.ok(support[1].includes('"bug";"answered"') && support[1].includes('"2";"1";"1";"support"') && support[1].includes('"1.4.0"'), support[1]);

  const spend = lines(await request(ctx.app).get("/admin/export/marketing-spend.csv").set("Cookie", cookie).expect(200));
  assert.equal(spend.length, 2);
  assert.ok(spend[1].includes('"anthropic";"plan"') && spend[1].includes('"0.42"'));

  const metrics = lines(await request(ctx.app).get("/admin/export/metrics.csv").set("Cookie", cookie).expect(200));
  assert.equal(metrics.length, 2);
  const header = metrics[0].split(";").map((h) => h.replace(/"/g, ""));
  const row = metrics[1].split(";").map((h) => h.replace(/"/g, ""));
  const col = (name) => row[header.indexOf(name)];
  assert.equal(col("tag"), "2026-09-29");
  assert.equal(col("vorlaeufig"), "nein");
  assert.equal(col("nutzer_gesamt"), "3");
  assert.equal(col("plus_aktiv_store"), "1");
  assert.equal(col("mrr_cent"), "499");
  assert.equal(col("sms_gestartet"), "2");
  assert.equal(col("dau"), "", "a missing number is an empty cell, not 'undefined'");
});

test("exports: support and viewer are refused, nothing is audited for them", async () => {
  await ownerCookie();
  for (const role of ["support", "viewer"]) {
    const cookie = await roleCookie(role);
    for (const name of EXPORTS) {
      const res = await request(ctx.app).get(`/admin/export/${name}.csv`).set("Cookie", cookie).expect(403);
      assert.equal(res.body.error, "forbidden");
    }
  }
  await request(ctx.app).get("/admin/export/metrics.csv").expect(401);
  assert.equal(await AdminAudit.countDocuments({ action: /^export_/ }), 0);
});
