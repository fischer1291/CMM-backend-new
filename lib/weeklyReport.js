/**
 * The weekly report (plan 2.11): every Monday from 08:00 Europe/Berlin the
 * last full week (Monday to Sunday) condensed from the MetricsDaily
 * snapshots and the functions of lib/metrics.js, no second data source, as
 * a mail to every owner and a console push (kind "weekly", #weekly). One
 * report, then a 30-minute review in the console: hours spent on operations
 * (alerts, support, approvals) are required, up to three decisions are
 * optional (models/WeeklyReview.js, routes/adminWeekly.js); the decisions go
 * into CMM/docs/DECISIONS.md by hand as well. No owner acknowledging for 14
 * days wakes the dead-man rule weekly_silent (lib/adminPush.js).
 *
 * Weeks are ISO weeks ("2026-W40", lib/localTime.js isoWeek). Sent once per
 * week: AppConfig.ops.weeklyReportFor is claimed with a conditional update
 * before anything goes out, so two leaders never both send.
 */
const Admin = require("../models/Admin");
const AppConfig = require("../models/AppConfig");
const AlertState = require("../models/AlertState");
const AdDraft = require("../models/AdDraft");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const MetricsDaily = require("../models/MetricsDaily");
const User = require("../models/User");
const WeeklyReview = require("../models/WeeklyReview");
const metrics = require("./metrics");
const { overdueTickets, northStar } = require("./today");
const { getConfig } = require("./appConfig");
const { localParts, weekKey, shiftDateKey, isoWeek, mondayOfIsoWeek } = require("./localTime");

const ZONE = "Europe/Berlin";
// Monday, from this local hour on
const SEND_HOUR = 8;
// Finished days without a snapshot are counted now, as far back as the
// snapshot job backfills (lib/metrics.js BACKFILL_DAYS); older ones stay out
const FILL_DAYS = 60;
// Leitprinzip 6: a cohort steers from 50 people, the paywall from 200 views
// a week; below that a number is shown, not judged
const MIN_COHORT = 50;
const MIN_PAYWALL_VIEWS = 200;
// Leitprinzip 6 as well: five documented user conversations a week
const RESEARCH_PER_WEEK = 5;
// Leitprinzip 8: operations under five hours a week (from the end of phase 2)
const MAX_OPS_HOURS = 5;

const nf = new Intl.NumberFormat("de-DE");
const nf1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const euros = (cents) => `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents || 0) / 100)} €`;
const light = (ok) => (ok == null ? "" : ok ? " 🟢" : " 🔴");
const dm = (key) => `${key.slice(8, 10)}.${key.slice(5, 7)}.`;
// "2026-W40" → "KW 40"
const kw = (week) => `KW ${Number(week.slice(-2))}`;

/** The last full week before `now` as { week, monday, sunday }. */
function lastFullWeek(now = new Date()) {
  const monday = shiftDateKey(weekKey(now, ZONE), -7);
  return { week: isoWeek(monday), monday, sunday: shiftDateKey(monday, 6) };
}

/**
 * A week the report can be made for: "YYYY-Www" (or the Monday as
 * "YYYY-MM-DD"), at most the last full week; empty means that one. Returns
 * { week, monday, sunday } or null.
 */
function resolveWeek(input, now = new Date()) {
  const last = lastFullWeek(now);
  if (input == null || input === "") return last;
  let monday = mondayOfIsoWeek(input);
  // A Monday as a date works as well
  if (!monday && /^\d{4}-\d{2}-\d{2}$/.test(String(input)) && weekKey(metrics.dayStart(String(input)), ZONE) === input) monday = String(input);
  if (!monday || monday > last.monday) return null;
  return { week: isoWeek(monday), monday, sunday: shiftDateKey(monday, 6) };
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * The seven snapshots of the week, oldest first (null for a day without
 * one). A finished day that is missing or still partial is counted now, as
 * the morning push does, within the snapshot job's backfill window.
 */
async function weekDays(monday, now) {
  const keys = Array.from({ length: 7 }, (_, i) => shiftDateKey(monday, i));
  const stored = await MetricsDaily.find({ day: { $in: keys } }, { _id: 0, __v: 0 }).lean();
  const byDay = new Map(stored.map((d) => [d.day, d]));
  const today = metrics.todayKey(now);
  const oldest = shiftDateKey(today, -FILL_DAYS);
  for (const key of keys) {
    const d = byDay.get(key);
    if ((!d || d.partial) && key < today && key >= oldest) byDay.set(key, await metrics.saveDay(key, now));
  }
  return keys.map((k) => byDay.get(k) || null);
}

/** Sum of a numeric path over the days that have it. */
const total = (days, path) => days.reduce((s, d) => s + (Number(getPath(d, path)) || 0), 0);
/** Sums of every numeric key of an object path over the days ({ a: 3, b: 1 }). */
function totals(days, path) {
  const out = {};
  for (const d of days) {
    const obj = getPath(d, path);
    if (!obj || typeof obj !== "object") continue;
    for (const [k, v] of Object.entries(obj)) if (typeof v === "number") out[k] = (out[k] || 0) + v;
  }
  return out;
}
const share = (n, of) => (of ? Math.round((n / of) * 100) / 100 : null);

const SOURCE_LABELS = { friend: "Freund·in", tiktok: "TikTok", instagram: "Instagram", flyer: "Flyer", press: "Presse", other: "Sonstiges", none: "ohne Antwort" };

/**
 * The report for one week: { week, from, to, headline, sections: [{ key,
 * title, lines, data }], text }. `text` is the plain text for the mail and
 * the console (German, short lines, traffic lights as in the morning push).
 * Rolling numbers (activation, density, WAU, MRR) are those of the Sunday;
 * what waits (tickets, approvals, reports) is as of now.
 */
async function report(input, now = new Date()) {
  const range = resolveWeek(input, now);
  if (!range) return null;
  const { week, monday, sunday } = range;
  const [from] = metrics.dayRange(monday);
  const [, to] = metrics.dayRange(sunday);
  const endOfWeek = new Date(Math.min(to.getTime() - 1, now.getTime()));

  const [days, prevSunday, config, cohorts, alerts, research, openTickets, overdue, approvals, openReports, reviews] = await Promise.all([
    weekDays(monday, now),
    MetricsDaily.findOne({ day: shiftDateKey(monday, -1) }, { users: 1 }).lean(),
    getConfig(),
    metrics.retention(5, endOfWeek),
    AlertState.find({ lastAt: { $gte: from, $lt: to } }, { tag: 1, level: 1, lastAt: 1 }).sort({ lastAt: 1 }).lean(),
    User.countDocuments({ "research.doneAt": { $gte: from, $lt: to } }),
    SupportTicket.countDocuments({ status: "open" }),
    overdueTickets(now),
    AdDraft.countDocuments({ status: "pending" }),
    Report.countDocuments({ status: "open" }),
    lastReviews(week),
  ]);
  const goals = config.goals;
  const present = days.filter(Boolean);
  const last = [...present].reverse()[0] || null;
  const sections = [];
  const add = (key, title, lines, data) => sections.push({ key, title, lines, data });

  // North star, density, WAU against the week before, talks
  const star = northStar(last, goals);
  const a = star.activation;
  const d = star.density;
  const densityOk = d.c3plus == null || d.sample < MIN_COHORT ? null : d.c3plus >= d.goalPct;
  const wau = last?.users?.wau ?? null;
  const wauBefore = prevSunday?.users?.wau ?? null;
  const wauChangePct = wau != null && wauBefore ? Math.round(((wau - wauBefore) / wauBefore) * 100) : null;
  const talks = { count: total(present, "talks.count"), minutes: total(present, "talks.minutes") + total(present, "circles.roomMinutes") };
  const activationLine = require("./adminPush").activationLine(a);
  add("north", "Nordstern", [
    activationLine,
    d.c3plus == null ? "Dichte: noch keine Daten" : `Dichte: ${d.c3plus} % mit ≥ 3 Kontakten (Ziel ${d.goalPct}${d.sample < MIN_COHORT ? `, erst ${nf.format(d.sample)} gemessen)` : `)${light(densityOk)}`}`,
    wau == null ? "WAU: –" : `WAU: ${nf.format(wau)}${wauChangePct == null ? "" : ` (${wauChangePct >= 0 ? "+" : "−"}${Math.abs(wauChangePct)} % zur Vorwoche)`}`,
    `Gespräche: ${nf.format(talks.count)}${talks.minutes ? ` (${nf.format(talks.minutes)} Min.)` : ""}`,
  ], { activation: a, density: { ...d, ok: densityOk }, wau, wauBefore, wauChangePct, talks });

  // Cohorts: W1 = signed up the week before, active in this one; W4 = signed up four weeks before
  const cohort = (c, index) => (c ? { week: isoWeek(c.week), size: c.size, pct: c.weeks[index] == null ? null : Math.round(c.weeks[index] * 100) } : null);
  const w1 = cohort(cohorts[3], 0);
  const w4 = cohort(cohorts[0], 3);
  const cohortText = (label, c) => (!c || !c.size ? `${label}: keine Anmeldungen` : `${label}: ${c.pct} % (Kohorte ${kw(c.week)}, ${nf.format(c.size)}${c.size < MIN_COHORT ? ", kleine Stichprobe" : ""})`);
  add("cohorts", "Kohorten", [cohortText("Bindung W1", w1), cohortText("Bindung W4", w4)], { w1, w4, minSample: MIN_COHORT });

  // Invite funnel and k
  const users = total(present, "users.new");
  const viaInvite = total(present, "growth.joinedViaInvite");
  const visits = total(present, "growth.inviteVisits.total");
  const k = share(viaInvite, users);
  add("invites", "Einladungen", [
    `Neu: ${nf.format(users)} · über Einladung: ${nf.format(viaInvite)} · Linkbesuche: ${nf.format(visits)}`,
    `k (über Einladung / neu): ${k == null ? "–" : nf2.format(k)}`,
  ], { inviteVisits: visits, invites: total(present, "growth.invites"), joinedViaInvite: viaInvite, newUsers: users, k });

  // New people by their answer (plan 2.10), when the days carry it
  const bySource = totals(present, "growth.bySource");
  if (Object.keys(bySource).length) {
    const parts = Object.entries(bySource).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([s, n]) => `${SOURCE_LABELS[s] || s} ${nf.format(n)}`);
    add("sources", "Herkunft", [parts.length ? `Herkunft: ${parts.join(" · ")}` : "Herkunft: keine Anmeldungen"], { bySource });
  }

  // Subscriptions: the week's movements and the MRR on Sunday
  const plus = Object.fromEntries(["newPaid", "renewed", "cancelled", "expired", "refunds", "trialsStarted", "trialsConverted"].map((key) => [key, total(present, `plus.${key}`)]));
  plus.mrrCents = last?.plus?.mrrCents ?? null;
  const moved = ["newPaid", "renewed", "cancelled", "expired", "trialsStarted", "trialsConverted"].some((key) => plus[key] > 0);
  add("plus", "Wanna yap+", [
    moved || plus.mrrCents > 0
      ? `Plus: +${nf.format(plus.newPaid)} neu · ${nf.format(plus.cancelled)} gekündigt · ${nf.format(plus.expired)} abgelaufen`
      : "Plus: keine Bewegung",
    ...(plus.trialsStarted || plus.trialsConverted ? [`Testphasen: ${nf.format(plus.trialsStarted)} gestartet · ${nf.format(plus.trialsConverted)} umgewandelt`] : []),
    `MRR: ${plus.mrrCents == null ? "–" : `${nf.format(Math.round(plus.mrrCents / 100))} €`}`,
  ], plus);

  // Paywall funnel (plan 2.6a), when the days carry it
  const funnel = totals(present, "plus.funnel");
  if (funnel.paywallView || funnel.purchaseStart) {
    const failures = (funnel.purchaseError || 0) + (funnel.restoreError || 0) + (funnel.offeringEmpty || 0);
    const views = funnel.paywallView || 0;
    add("paywall", "Paywall", [
      `Paywall: ${nf.format(views)} Aufrufe → ${nf.format(funnel.purchaseSuccess || 0)} Käufe${views ? ` (${Math.round(((funnel.purchaseSuccess || 0) / views) * 100)} %)` : ""}${failures ? ` · ${nf.format(failures)} Fehler` : ""}`,
      ...(views < MIN_PAYWALL_VIEWS ? [`erst ab ${nf.format(MIN_PAYWALL_VIEWS)} Aufrufen je Woche aussagekräftig`] : []),
    ], { ...funnel, failures, minViews: MIN_PAYWALL_VIEWS });
  }

  // SMS per sign-up and the variable costs (prices are assumptions, plan 2.5)
  const sms = total(present, "ops.smsStarted");
  const smsPerSignup = users ? Math.round((sms / users) * 10) / 10 : null;
  const costCents = Math.round(total(present, "costs.variableEurCents") * 100) / 100;
  add("costs", "Kosten", [
    smsPerSignup == null ? `SMS: ${nf.format(sms)}, keine Registrierung` : `SMS je Registrierung: ${nf1.format(smsPerSignup)} (${nf.format(sms)} SMS)`,
    `Variable Kosten: ${euros(costCents)} (Preise: Annahme)`,
  ], { smsStarted: sms, smsPerSignup, variableEurCents: costCents });

  // Alerts whose latest firing fell into the week (AlertState keeps only the latest)
  add("alerts", "Alarme", [alerts.length ? `Alarme: ${[...new Set(alerts.map((x) => x.tag))].join(", ")}` : "Alarme: keine"], { tags: alerts.map((x) => ({ tag: x.tag, level: x.level, lastAt: x.lastAt })) });

  // What waits, as of now (lib/today.js)
  const waiting = [];
  if (openTickets) waiting.push(`${nf.format(openTickets)} ${openTickets === 1 ? "Ticket" : "Tickets"}${overdue.length ? ` (${nf.format(overdue.length)} seit über 24 h)` : ""}`);
  if (approvals) waiting.push(`${nf.format(approvals)} ${approvals === 1 ? "Video" : "Videos"} zur Freigabe`);
  if (openReports) waiting.push(`${nf.format(openReports)} ${openReports === 1 ? "Meldung" : "Meldungen"}`);
  add("todo", "Offen", [waiting.length ? `Offen jetzt: ${waiting.join(" · ")}` : "Offen jetzt: nichts"], { openTickets, overdueTickets: overdue.length, approvals, openReports });

  // User research (plan 1.13): research calls held that week
  add("research", "Nutzerforschung", [`Nutzergespräche: ${nf.format(research)} (Ziel ${RESEARCH_PER_WEEK} je Woche)${light(research >= RESEARCH_PER_WEEK)}`], { done: research, goal: RESEARCH_PER_WEEK });

  // Seed cluster (plan 1.13): sign-ups of the seed campaign, without one through invites
  const seedSlug = goals.seedCampaign || null;
  const seedSignups = seedSlug ? present.reduce((s, day) => s + (Number(day.growth?.byCampaign?.[seedSlug]?.new) || 0), 0) : viaInvite;
  const seedGoal = goals.seedSignupsPerWeek;
  add("seed", "Seed-Cluster", [
    `Seed-Cluster (${seedSlug || "über Einladungen"}): ${nf.format(seedSignups)} Registrierungen (Ziel ${nf.format(seedGoal)}, Annahme)${light(seedSignups >= seedGoal)}`,
  ], { campaign: seedSlug, signups: seedSignups, goal: seedGoal, ok: seedSignups >= seedGoal });

  // Hours of operations from the latest acknowledgement up to this week
  const hours = reviews.length ? sumHours(reviews) : null;
  add("hours", "Betrieb", [
    hours
      ? `Betrieb ${kw(reviews[0].week)}: ${nf1.format(hours.total)} h (Alarme ${nf1.format(hours.alerts)} · Support ${nf1.format(hours.support)} · Freigaben ${nf1.format(hours.approvals)}), Ziel unter ${MAX_OPS_HOURS} h${light(hours.total < MAX_OPS_HOURS)}`
      : "Betrieb: noch keine Quittung mit Stunden",
  ], hours ? { week: reviews[0].week, ...hours, goalMax: MAX_OPS_HOURS, admins: reviews.length } : null);

  const missing = days.filter((x) => !x).length;
  const headline = a.pct4w == null ? (wau == null ? `${nf.format(users)} neu` : `WAU ${nf.format(wau)}`) : `Aktivierung ${a.pct4w} %${a.enough ? light(a.ok) : ""}`;
  const title = `Wanna yap? Woche ${Number(week.slice(-2))} (${dm(monday)}–${dm(sunday)}${sunday.slice(0, 4)})`;
  const text = [
    title,
    ...(missing ? [`(${missing} ${missing === 1 ? "Tag" : "Tage"} ohne Tageszahlen)`] : []),
    "",
    ...sections.flatMap((s, i) => (i ? ["", ...s.lines] : s.lines)),
  ].join("\n");
  return { week, from: monday, to: sunday, headline, title, missingDays: missing, sections, text };
}

/**
 * The newest week up to `week` that has acknowledgements, all of them
 * (several admins: their hours add up).
 */
async function lastReviews(week) {
  const newest = await WeeklyReview.findOne({ week: { $lte: week } }, { week: 1 }).sort({ week: -1 }).lean();
  if (!newest) return [];
  return WeeklyReview.find({ week: newest.week }).sort({ ackAt: 1 }).lean();
}

function sumHours(reviews) {
  const out = { alerts: 0, support: 0, approvals: 0 };
  for (const r of reviews) for (const k of Object.keys(out)) out[k] += r.hours?.[k] || 0;
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10) / 10;
  out.total = Math.round((out.alerts + out.support + out.approvals) * 10) / 10;
  return out;
}

// --- Sending ---------------------------------------------------------------------

const consoleUrl = () => `${(process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "")}/console/#weekly`;

/**
 * Claim `week` on AppConfig.ops.weeklyReportFor: true for the one run that
 * may send it. Conditional, so a second run or a second leader gets false.
 */
async function claim(week, now) {
  // An older document may carry ops: null; the dotted $set needs an object
  await AppConfig.updateOne({ key: "app", ops: null }, { $set: { ops: {} } });
  try {
    const res = await AppConfig.updateOne(
      { key: "app", "ops.weeklyReportFor": { $ne: week } },
      { $set: { "ops.weeklyReportFor": week, "ops.weeklyReportAt": now } },
      { upsert: true, setDefaultsOnInsert: false },
    );
    if (!(res.modifiedCount || res.upsertedCount)) return false;
  } catch (err) {
    // Already claimed: the upsert ran into the unique key
    if (err.code === 11000) return false;
    throw err;
  }
  // The first report ever: the dead-man rule weekly_silent counts from here
  await AppConfig.updateOne({ key: "app", "ops.weeklyReportFirstAt": null }, { $set: { "ops.weeklyReportFirstAt": now } });
  return true;
}

/**
 * Send last week's report when it is due: Monday from 08:00 Europe/Berlin
 * (a run missed on Monday catches up later that week), once per week. Run
 * every 15 minutes by the job leader (index.js). Returns { week, mails,
 * pushes } or null when nothing was due.
 */
async function weeklyDue(now = new Date()) {
  const { day, minutes } = localParts(now, ZONE);
  if (day === 1 && minutes < SEND_HOUR * 60) return null;
  const { week } = lastFullWeek(now);
  const stored = await AppConfig.findOne({ key: "app" }, { ops: 1 }).lean();
  if (stored?.ops?.weeklyReportFor === week) return null;
  const owners = await Admin.find({ role: "owner", totpEnabled: true, active: { $ne: false } }, { email: 1 }).lean();
  // A fresh install: nobody to tell yet
  if (!owners.length) return null;
  if (!(await claim(week, now))) return null;

  const r = await report(week, now);
  const footer = `\n\nQuittieren (Stunden Betrieb: Alarme, Support, Freigaben; bis zu drei Entscheidungen): ${consoleUrl()}\nDie Entscheidungen bitte zusätzlich in CMM/docs/DECISIONS.md eintragen.`;
  let mails = 0;
  const mailer = require("./mailer");
  if (mailer.configured()) {
    for (const owner of owners) {
      try {
        await mailer.sendMail({ to: owner.email, subject: `Wanna yap? Woche ${Number(week.slice(-2))}: ${r.headline}`, text: r.text + footer });
        mails++;
      } catch (err) {
        console.error("❌ weekly report mail:", err.reason || err.message);
      }
    }
  }
  const body = r.sections.filter((s) => ["north", "invites", "plus", "alerts"].includes(s.key)).map((s) => s.lines[0]).join(" · ");
  const pushes = await require("./adminPush").notify("weekly", { title: `Wochenreport ${kw(week)}`, body, url: "#weekly", tag: "weekly" });
  return { week, mails, pushes };
}

module.exports = { report, weeklyDue, resolveWeek, lastFullWeek, claim, sumHours, SEND_HOUR, MIN_COHORT, MIN_PAYWALL_VIEWS, RESEARCH_PER_WEEK, MAX_OPS_HOURS };
