// Plan 2.7: reports from people without an account (POST /reports/public,
// shown in the console's support tab) and the statement of reasons
// (lib/moderation.js) that a suspension or a hidden or deleted moment
// writes to the person affected.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setup, teardown, reset, fakes } = require("./helpers");
const User = require("../models/User");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");
const SupportTicket = require("../models/SupportTicket");
const CallMoment = require("../models/CallMoment");
const Report = require("../models/Report");
const adminPush = require("../lib/adminPush");
const { totpAt, currentStep } = require("../lib/adminAuth");
const { deleteAccount } = require("../lib/account");

let ctx;
let sent = [];
before(async () => {
  adminPush.setSender(async (sub, payload) => {
    sent.push(JSON.parse(payload));
  });
  ctx = await setup();
});
after(teardown);
beforeEach(async () => {
  await reset();
  sent = [];
});

const ANNA = "+4915111111111";
const BEN = "+4915222222222";
const TOKEN = (n) => `ExponentPushToken[test-${n}]`;
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
async function ownerCookie() {
  const who = { email: "owner@example.com", password: "a-long-admin-password" };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(started.body.secret, currentStep()) }).expect(200);
  return cookieOf(done);
}
async function appUser(phone, name) {
  await request(ctx.app).post("/verify/start").send({ phone }).expect(200);
  const res = await request(ctx.app).post("/verify/check").send({ phone, code: fakes.approvedCode }).expect(200);
  await User.updateOne({ phone }, { name, pushToken: TOKEN(phone.slice(-1)), timezone: "Europe/Berlin" });
  return { token: res.body.token, id: String((await User.findOne({ phone }))._id) };
}
// adminPush.tell() runs in the background
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
}
const report = (body) => request(ctx.app).post("/reports/public").send(body);

test("public report: ticket without account, push to support, reference; invalid input 400; honeypot", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: { endpoint: "https://web.push.apple.com/test", keys: { p256dh: "BPub", auth: "auth" } } }).expect(200);
  await appUser(ANNA, "Anna");

  const res = await report({ category: "harassment", text: "Ruft mich ständig nachts an, obwohl ich das nicht will.", reportedPhone: "0151 11111111", reporterEmail: " Meldende@Example.com ", momentHint: "Bild vom 1. Oktober" }).expect(200);
  assert.match(res.body.reference, /^[0-9A-F]{8}$/);
  const ticket = await SupportTicket.findOne({ category: "report" }).lean();
  assert.equal(ticket.phone, null);
  assert.equal(ticket.status, "open");
  assert.equal(ticket.email, "meldende@example.com");
  assert.deepEqual({ ...ticket.report }, { category: "harassment", reportedPhone: ANNA, momentHint: "Bild vom 1. Oktober" });
  assert.equal(String(ticket._id).slice(-8).toUpperCase(), res.body.reference);
  await settle();
  const push = sent.find((p) => p.url === `#support/${ticket._id}`);
  assert.ok(push, "support and owners hear about it (kind reports)");
  assert.match(push.title, /Meldung ohne Konto: Belästigung/);

  // Only the text and the category are needed
  await report({ category: "illegal", text: "Ein Moment zeigt eine Straftat." }).expect(200);

  for (const bad of [
    {},
    { category: "harassment", text: "zu kurz" },
    { category: "nope", text: "Das ist lang genug für eine Meldung." },
    { category: "spam", text: "x".repeat(2001) },
    { category: "spam", text: "Das ist lang genug für eine Meldung.", reportedPhone: "keine Nummer" },
    { category: "spam", text: "Das ist lang genug für eine Meldung.", reporterEmail: "kein-at" },
    { category: "spam", text: "Das ist lang genug für eine Meldung.", momentHint: "x".repeat(201) },
    { category: "spam", text: 42 },
  ]) {
    const r = await report(bad).expect(400);
    assert.equal(r.body.error, "invalid_report");
  }

  // Bots fill in the hidden field: they see success, nothing is stored
  const bot = await report({ category: "spam", text: "Buy cheap followers now!!!", website: "https://spam.example" }).expect(200);
  assert.match(bot.body.reference, /^[0-9A-F]{8}$/);
  assert.equal(await SupportTicket.countDocuments({ category: "report" }), 2);
});

test("public report in the console: marked, reported person linked, answer by mail, export without contact data", async () => {
  const cookie = await ownerCookie();
  const anna = await appUser(ANNA, "Anna");
  const res = await report({ category: "spam", text: "Schickt Werbung in jedem Anruf.", reportedPhone: ANNA, reporterEmail: "melder@example.com" }).expect(200);

  const list = (await request(ctx.app).get("/admin/tickets").set(admin(cookie)).expect(200)).body;
  const row = list.tickets.find((t) => t.category === "report");
  assert.equal(row.user.name, "Meldung ohne Konto");
  assert.equal(row.reference, res.body.reference);
  assert.equal(row.report.reported.id, anna.id);
  assert.equal(row.report.reported.phone, "+49 ••• 111");
  assert.equal(row.report.hasEmail, true);
  assert.equal(row.report.email, undefined, "the address only in the opened ticket");

  const detail = (await request(ctx.app).get(`/admin/tickets/${row.id}`).set(admin(cookie)).expect(200)).body.ticket;
  assert.equal(detail.report.email, "melder@example.com");
  assert.equal(detail.messages[0].text, "Schickt Werbung in jedem Anruf.");

  const replied = await request(ctx.app).post(`/admin/tickets/${row.id}/reply`).set(admin(cookie)).send({ text: "Danke, wir haben uns das angesehen." }).expect(200);
  assert.equal(replied.body.mailed, true);
  const mail = fakes.mails.at(-1);
  assert.equal(mail.to, "melder@example.com");
  assert.match(mail.subject, new RegExp(res.body.reference));
  assert.match(mail.text, /Danke, wir haben uns das angesehen/);
  assert.equal((await AdminAudit.findOne({ action: "ticket_reply" }).lean()).meta.mailed, true);

  // Without an address the answer is a note only
  await report({ category: "other", text: "Ohne Kontaktadresse gemeldet." }).expect(200);
  const quiet = await SupportTicket.findOne({ category: "report", email: null });
  const note = await request(ctx.app).post(`/admin/tickets/${quiet._id}/reply`).set(admin(cookie)).send({ text: "Intern: erledigt", close: true }).expect(200);
  assert.equal(note.body.mailed, false);

  const csv = (await request(ctx.app).get("/admin/export/support.csv").set(admin(cookie)).expect(200)).text;
  assert.doesNotMatch(csv, /melder@example\.com/);
  assert.doesNotMatch(csv, /4915111111111/);

  // Deleting the reported account takes the reports about it along, like in-app reports
  await deleteAccount(ANNA);
  assert.equal(await SupportTicket.countDocuments({ "report.reportedPhone": ANNA }), 0);
  assert.equal(await SupportTicket.countDocuments({ category: "report" }), 1);
});

test("statement of reasons: suspension writes a ticket and a push; reason required; sign-in names it", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/push/subscribe").set(admin(cookie)).send({ subscription: { endpoint: "https://web.push.apple.com/test", keys: { p256dh: "BPub", auth: "auth" } } }).expect(200);
  const anna = await appUser(ANNA, "Anna");
  await request(ctx.app).post(`/admin/users/${anna.id}/suspend`).set(admin(cookie)).send({ days: 7 }).expect(400);
  const r = await request(ctx.app).post(`/admin/users/${anna.id}/suspend`).set(admin(cookie)).send({ days: 7, reason: "Beleidigungen im Anruf" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const ticket = await SupportTicket.findOne({ phone: ANNA, category: "moderation" }).lean();
  assert.ok(ticket);
  assert.equal(ticket.status, "answered");
  assert.equal(ticket.unreadByUser, true);
  assert.equal(ticket.moderation.action, "suspend");
  assert.ok(ticket.moderation.until > new Date(Date.now() + 6 * 24 * 3600 * 1000));
  const text = ticket.messages[0].text;
  assert.equal(ticket.messages[0].from, "support");
  assert.match(text, /vorübergehend gesperrt/);
  assert.match(text, /Grund: Beleidigungen im Anruf/);
  assert.match(text, /endet am .*2026|endet am .*20\d\d/);
  assert.match(text, /Du kannst widersprechen: Antworte einfach hier\./);
  const push = fakes.expoPushes.at(-1);
  assert.equal(push.to, TOKEN("1"));
  assert.equal(push.data.type, "support_reply");
  assert.equal(push.title, "Nachricht vom Support");

  // Signed out and unable to sign in, but not unable to learn why: /start
  // sends the SMS to a suspended number (the real path, not a code that
  // works without one), and only the code reveals the reason
  fakes.sms.length = 0;
  const start = await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(200);
  assert.doesNotMatch(JSON.stringify(start.body), /Grund|Beleidigungen/);
  assert.deepEqual(fakes.sms, [ANNA], "the code goes out under the usual brakes");
  const wrong = await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: "000000" });
  assert.equal(wrong.body.token, undefined);
  assert.doesNotMatch(JSON.stringify(wrong.body), /Grund|Beleidigungen/);
  const checked = await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(403);
  assert.match(checked.body.error, /gesperrt \(Grund: Beleidigungen im Anruf\)\. Du kannst widersprechen: Schreib uns an hallo@wannayap\.app\./);
  assert.equal(checked.body.token, undefined);
  const answer = await request(ctx.app).post("/verify/account-check").send({ phone: ANNA, answer: "mine", checkToken: "x" }).expect(403);
  assert.doesNotMatch(answer.body.error, /Grund|Beleidigungen/);
  // The SMS cost brakes still apply to a suspended number
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ ops: { smsPaused: true } }).expect(200);
  await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(503);
  await request(ctx.app).put("/admin/config").set(admin(cookie)).send({ ops: { smsPaused: false } }).expect(200);

  // A suspension from before plan 2.7 (no statement): suspendReason was an
  // internal note then, so the person never reads it
  await User.create({ phone: BEN, phoneHash: User.hashPhone(BEN), suspendedUntil: new Date(Date.now() + 5 * 24 * 3600 * 1000), suspendReason: "Meldung: harassment (von Carla)" });
  await request(ctx.app).post("/verify/start").send({ phone: BEN }).expect(200);
  const legacy = await request(ctx.app).post("/verify/check").send({ phone: BEN, code: fakes.approvedCode }).expect(403);
  assert.match(legacy.body.error, /^Dein Konto ist bis zum .+ gesperrt\. Du kannst widersprechen: Schreib uns an hallo@wannayap\.app\.$/);
  assert.doesNotMatch(legacy.body.error, /Grund|Carla|harassment/);
  assert.equal(legacy.body.token, undefined);

  // After the suspension the objection is a reply in that ticket
  await request(ctx.app).post(`/admin/users/${anna.id}/unsuspend`).set(admin(cookie)).expect(200);
  await new Promise((r) => setTimeout(r, 1100));
  await request(ctx.app).post("/verify/start").send({ phone: ANNA }).expect(200);
  const token = (await request(ctx.app).post("/verify/check").send({ phone: ANNA, code: fakes.approvedCode }).expect(200)).body.token;
  const mine = (await request(ctx.app).get("/support").set("Authorization", `Bearer ${token}`).expect(200)).body.tickets;
  assert.equal(mine[0].category, "moderation");
  assert.equal(mine[0].moderation.action, "suspend");
  assert.equal(mine[0].unread, true);
  sent = [];
  const objected = await request(ctx.app).post(`/support/${mine[0].id}/reply`).set("Authorization", `Bearer ${token}`).send({ message: "Das war ein Missverständnis." }).expect(200);
  assert.equal(objected.body.ticket.status, "open");
  await settle();
  assert.equal(sent.find((p) => p.url === `#support/${mine[0].id}`)?.title, "Widerspruch gegen eine Entscheidung");
  // A statement does not count against the five open tickets
  for (let i = 0; i < 5; i++) {
    await request(ctx.app).post("/support").set("Authorization", `Bearer ${token}`).send({ category: "idea", message: `Idee ${i}` }).expect(200);
  }
});

test("statement of reasons: hiding and deleting a moment tell its author; report decisions need a reason, the reporter's note stays internal; a ban writes none", async () => {
  const cookie = await ownerCookie();
  await appUser(ANNA, "Anna");
  await appUser(BEN, "Ben");
  const base = { userPhone: ANNA, userName: "Anna", targetPhone: BEN, targetName: "Ben", screenshot: "https://example.com/m.jpg", mood: "😊", callDuration: "03:00" };
  const m1 = await CallMoment.create(base);
  const m2 = await CallMoment.create(base);
  const m3 = await CallMoment.create(base);

  await request(ctx.app).post(`/admin/moments/${m1._id}/hide`).set(admin(cookie)).send({}).expect(400);
  await request(ctx.app).post(`/admin/moments/${m1._id}/hide`).set(admin(cookie)).send({ reason: "Zeigt eine dritte Person ohne Zustimmung" }).expect(200);
  let statements = await SupportTicket.find({ phone: ANNA, category: "moderation" }).sort({ createdAt: 1 }).lean();
  assert.equal(statements.length, 1);
  assert.equal(statements[0].moderation.action, "hide_moment");
  assert.match(statements[0].messages[0].text, /ausgeblendet[\s\S]*Grund: Zeigt eine dritte Person ohne Zustimmung[\s\S]*Antworte einfach hier/);
  assert.equal(fakes.expoPushes.at(-1).data.type, "support_reply");
  assert.equal(await SupportTicket.countDocuments({ phone: BEN }), 0, "only the author gets it");

  await request(ctx.app).post(`/admin/moments/${m2._id}/delete`).set(admin(cookie)).send({ reason: "Nacktheit" }).expect(200);
  statements = await SupportTicket.find({ phone: ANNA, category: "moderation" }).sort({ createdAt: 1 }).lean();
  assert.equal(statements.at(-1).moderation.action, "delete_moment");
  assert.match(statements.at(-1).messages[0].text, /gelöscht[\s\S]*Grund: Nacktheit[\s\S]*dauerhaft/);

  // Two moderators deleting the same moment at once: one statement, one push
  const m5 = await CallMoment.create(base);
  const before5 = await SupportTicket.countDocuments({ phone: ANNA, category: "moderation" });
  const pushes5 = fakes.expoPushes.length;
  const moderation = require("../lib/moderation");
  const results = await Promise.all([
    moderation.removeMoment(m5, { reason: "Doppelt", by: "a@example.com" }),
    moderation.removeMoment(m5, { reason: "Doppelt", by: "b@example.com" }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await SupportTicket.countDocuments({ phone: ANNA, category: "moderation" }), before5 + 1);
  assert.equal(fakes.expoPushes.length, pushes5 + 1);
  // A moment without an author number writes nothing (and never matches a user without phone)
  assert.equal(await moderation.statementOfReasons(null, { action: "delete_moment", reason: "x" }), null);
  // The export names the measure of a statement
  const exported = await require("../lib/account").exportAccount(ANNA);
  const stated = exported.support.filter((t) => t.category === "moderation");
  assert.equal(stated.length, before5 + 1);
  assert.deepEqual(stated.map((t) => t.moderation.action).sort(), ["delete_moment", "delete_moment", "hide_moment"]);
  assert.equal(exported.support.find((t) => t.category !== "moderation")?.moderation, undefined);

  // Through the report queue: the reason is required there too
  const r = await Report.create({ reporter: BEN, reported: ANNA, momentId: m3._id, reason: "inappropriate", note: "Das bin ich, Ben, auf dem Bild" });
  for (const action of ["hide_moment", "delete_moment", "suspend"]) {
    const refused = await request(ctx.app).post(`/admin/reports/${r._id}/resolve`).set(admin(cookie)).send({ action, days: 3, note: "  " }).expect(400);
    assert.equal(refused.body.error, "reason_required");
  }
  assert.equal((await Report.findById(r._id)).status, "open");
  await request(ctx.app).post(`/admin/reports/${r._id}/resolve`).set(admin(cookie)).send({ action: "hide_moment", note: "Meldung wegen unangemessener Inhalte" }).expect(200);
  assert.equal((await CallMoment.findById(m3._id)).hidden, true);
  statements = await SupportTicket.find({ phone: ANNA, category: "moderation" }).sort({ createdAt: 1 }).lean();
  assert.equal(statements.length, 4);
  assert.match(statements.at(-1).messages[0].text, /Grund: Meldung wegen unangemessener Inhalte/);
  assert.doesNotMatch(statements.at(-1).messages[0].text, /Ben/, "the reporter's note stays internal");
  assert.match(statements.at(-1).messages[0].text, /außergerichtliche Streitbeilegungsstelle/);

  // One statement per hiding: again writes nothing, after unhide a new one
  const pushes = fakes.expoPushes.length;
  const again = await request(ctx.app).post(`/admin/moments/${m1._id}/hide`).set(admin(cookie)).send({ reason: "Nochmal" }).expect(200);
  assert.equal(again.body.told, false);
  assert.equal(await SupportTicket.countDocuments({ phone: ANNA, category: "moderation" }), 4);
  assert.equal(fakes.expoPushes.length, pushes);
  await request(ctx.app).post(`/admin/moments/${m1._id}/unhide`).set(admin(cookie)).expect(200);
  assert.equal((await CallMoment.findById(m1._id)).hiddenNoticeAt, null);
  assert.equal((await request(ctx.app).post(`/admin/moments/${m1._id}/hide`).set(admin(cookie)).send({ reason: "Doch ausblenden" }).expect(200)).body.told, true);
  assert.equal(await SupportTicket.countDocuments({ phone: ANNA, category: "moderation" }), 5);
  // Hidden automatically after reports (routes/social.js): support's decision tells the author
  const m4 = await CallMoment.create({ ...base, hidden: true });
  assert.equal((await request(ctx.app).post(`/admin/moments/${m4._id}/hide`).set(admin(cookie)).send({ reason: "Belästigung" }).expect(200)).body.told, true);
  assert.equal(await SupportTicket.countDocuments({ phone: ANNA, category: "moderation" }), 6);
  // Normal tickets carry neither block
  await SupportTicket.create({ phone: ANNA, category: "bug", messages: [{ from: "user", text: "Bug" }] });
  const plain = await SupportTicket.findOne({ category: "bug" }).lean();
  assert.equal(plain.report, undefined);
  assert.equal(plain.moderation, undefined);

  // A ban deletes the account: nothing to write to, BannedNumber keeps the reason
  await request(ctx.app).post(`/admin/users/${(await User.findOne({ phone: BEN }))._id}/ban`).set(admin(cookie)).send({ reason: "Drohungen", confirm: "SPERREN" }).expect(200);
  assert.equal(await SupportTicket.countDocuments({ phone: BEN }), 0);
  assert.equal((await require("../models/BannedNumber").findOne().lean()).reason, "Drohungen");
  assert.ok(await Admin.exists({}));
});
