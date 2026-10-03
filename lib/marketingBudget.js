/**
 * Marketing budget: a daily and a weekly cap (Europe/Berlin, weeks from
 * Monday) for everything the marketing agent pays for (Claude, Veo, images).
 *
 * The agent reserves an estimate before each paid call. The reservation only
 * goes through if both the day and the week stay within their caps; the
 * totals are raised with a conditional $inc, so the check and the booking are
 * one step. Afterwards the agent settles the real cost (or releases the
 * reservation when nothing was spent). A reservation the agent never settles
 * keeps counting with its estimate: when in doubt, it counts as spent.
 *
 * Amounts are kept in euro cents; a real cost above the estimate is booked
 * as is (the money is spent), it only blocks later reservations.
 *
 * Paid reach (provider "media", plan 2.7) goes through the same caps, but
 * only once the launch gate is open: while lib/launchChecklist.js reports
 * an incomplete list, reserve() refuses it with launch_checklist_incomplete.
 * The AI providers (anthropic, google) are not gated.
 */
const MarketingSpend = require("../models/MarketingSpend");
const MarketingTally = require("../models/MarketingTally");
const { localParts, weekKey } = require("./localTime");

const ZONE = "Europe/Berlin";
// The owner's budget from the start (set in the console afterwards)
const DEFAULT_DAILY_CENTS = 500;
const DEFAULT_WEEKLY_CENTS = 2500;
const MAX_CENTS = 100000;
const PROVIDERS = ["anthropic", "google", "media"];
// Providers that need the launch checklist complete
const GATED = ["media"];

const cents = (eur) => Math.round(Number(eur) * 100);
const eur = (c) => Math.round(c) / 100;
const periods = (now) => ({ day: localParts(now, ZONE).dateKey, week: weekKey(now, ZONE) });

async function caps() {
  const doc = await MarketingTally.findById("caps").lean();
  return {
    dailyCents: doc?.dailyCents ?? DEFAULT_DAILY_CENTS,
    weeklyCents: doc?.weeklyCents ?? DEFAULT_WEEKLY_CENTS,
    updatedBy: doc?.updatedBy || null,
    updatedAt: doc?.updatedAt || null,
  };
}

async function spent(now = new Date()) {
  const { day, week } = periods(now);
  const [d, w] = await Promise.all([MarketingTally.findById(`day:${day}`).lean(), MarketingTally.findById(`week:${week}`).lean()]);
  return { day, week, dayCents: d?.cents || 0, weekCents: w?.cents || 0 };
}

/** Caps, what is spent today and this week (reserved counts), what is left. */
async function status(now = new Date()) {
  const [c, s] = await Promise.all([caps(), spent(now)]);
  return {
    day: s.day,
    week: s.week,
    dailyEur: eur(c.dailyCents),
    weeklyEur: eur(c.weeklyCents),
    spentTodayEur: eur(s.dayCents),
    spentWeekEur: eur(s.weekCents),
    leftEur: eur(Math.max(0, Math.min(c.dailyCents - s.dayCents, c.weeklyCents - s.weekCents))),
    updatedBy: c.updatedBy,
    updatedAt: c.updatedAt,
  };
}

/** Owner sets the caps in the console. */
async function setCaps({ dailyEur, weeklyEur }, by) {
  const daily = cents(dailyEur);
  const weekly = cents(weeklyEur);
  if (!Number.isFinite(daily) || !Number.isFinite(weekly) || daily < 0 || weekly < 0 || daily > MAX_CENTS || weekly > MAX_CENTS) {
    return { error: "invalid_budget" };
  }
  if (daily > weekly) return { error: "daily_above_weekly" };
  await MarketingTally.updateOne(
    { _id: "caps" },
    { dailyCents: daily, weeklyCents: weekly, updatedBy: by, updatedAt: new Date() },
    { upsert: true },
  );
  return { budget: await status() };
}

/** Raise a period total by `amount` only if it stays within `cap`. */
async function raise(id, amount, cap) {
  await MarketingTally.updateOne({ _id: id }, { $setOnInsert: { cents: 0 } }, { upsert: true });
  const res = await MarketingTally.updateOne({ _id: id, cents: { $lte: cap - amount } }, { $inc: { cents: amount } });
  return res.modifiedCount === 1;
}

/**
 * Reserve `estimateEur` for one paid call. Returns { reservation } or
 * { error: "budget_exceeded", budget } when the day or week would go over.
 */
async function reserve({ provider, purpose, campaign, note, estimateEur }, now = new Date()) {
  const amount = cents(estimateEur);
  if (!PROVIDERS.includes(provider)) return { error: "invalid_provider" };
  if (typeof purpose !== "string" || !/^[a-z0-9-]{2,40}$/.test(purpose)) return { error: "invalid_purpose" };
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CENTS) return { error: "invalid_amount" };
  if (GATED.includes(provider) && !(await require("./launchChecklist").complete(now))) return { error: "launch_checklist_incomplete" };
  const { day, week } = periods(now);
  const c = await caps();
  if (!(await raise(`day:${day}`, amount, c.dailyCents))) return { error: "budget_exceeded", budget: await status(now) };
  if (!(await raise(`week:${week}`, amount, c.weeklyCents))) {
    await MarketingTally.updateOne({ _id: `day:${day}` }, { $inc: { cents: -amount } });
    return { error: "budget_exceeded", budget: await status(now) };
  }
  const entry = await MarketingSpend.create({
    day,
    week,
    provider,
    purpose,
    campaign: typeof campaign === "string" ? campaign.slice(0, 60) : null,
    note: typeof note === "string" ? note.slice(0, 200) : null,
    estimateEur: eur(amount),
  });
  return { reservation: { id: String(entry._id), estimateEur: entry.estimateEur, budget: await status(now) } };
}

/** Book the real cost of a reservation (0 when the call cost nothing). */
async function settle(id, costEur) {
  const cost = cents(costEur);
  if (!Number.isFinite(cost) || cost < 0 || cost > MAX_CENTS) return { error: "invalid_amount" };
  const entry = await MarketingSpend.findOneAndUpdate(
    { _id: id, status: "reserved" },
    { status: "settled", costEur: eur(cost), settledAt: new Date() },
    { new: true },
  ).catch(() => null);
  if (!entry) return { error: "not_reserved" };
  const diff = cost - cents(entry.estimateEur);
  if (diff) {
    await MarketingTally.updateOne({ _id: `day:${entry.day}` }, { $inc: { cents: diff } });
    await MarketingTally.updateOne({ _id: `week:${entry.week}` }, { $inc: { cents: diff } });
  }
  return { entry };
}

/** Nothing was spent (the call failed before it cost anything). */
async function release(id) {
  const entry = await MarketingSpend.findOneAndUpdate(
    { _id: id, status: "reserved" },
    { status: "released", costEur: 0, settledAt: new Date() },
    { new: true },
  ).catch(() => null);
  if (!entry) return { error: "not_reserved" };
  const back = -cents(entry.estimateEur);
  await MarketingTally.updateOne({ _id: `day:${entry.day}` }, { $inc: { cents: back } });
  await MarketingTally.updateOne({ _id: `week:${entry.week}` }, { $inc: { cents: back } });
  return { entry };
}

/** For the console: the budget, spending per provider this week, the last entries. */
async function overview(now = new Date()) {
  const budget = await status(now);
  const [byProvider, entries] = await Promise.all([
    MarketingSpend.aggregate([
      { $match: { week: budget.week, status: { $ne: "released" } } },
      { $group: { _id: "$provider", eur: { $sum: { $ifNull: ["$costEur", "$estimateEur"] } } } },
    ]),
    MarketingSpend.find({ status: { $ne: "released" } }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  return {
    budget,
    weekByProvider: Object.fromEntries(byProvider.map((p) => [p._id, Math.round(p.eur * 100) / 100])),
    entries: entries.map((e) => ({
      at: e.createdAt,
      provider: e.provider,
      purpose: e.purpose,
      campaign: e.campaign,
      note: e.note,
      eur: e.costEur ?? e.estimateEur,
      status: e.status,
    })),
  };
}

module.exports = { PROVIDERS, GATED, status, setCaps, reserve, settle, release, overview, DEFAULT_DAILY_CENTS, DEFAULT_WEEKLY_CENTS };
