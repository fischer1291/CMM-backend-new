/**
 * Unit economics for the console (plan 2.5): what a month of the app costs
 * (variable costs from MetricsDaily.costs, fixed costs from
 * AppConfig.fixedCosts), what it earns after Apple's commission (MRR from
 * MetricsDaily.plus), the contribution per active user and per Plus
 * subscription, the break-even in subscriptions and the runway from the
 * bank balance the owner types in. Every price behind it is an assumption
 * (AppConfig.prices) until checked against the invoices; the console says so.
 */
const SubscriptionEvent = require("../models/SubscriptionEvent");
const metrics = require("./metrics");
const { getConfig } = require("./appConfig");

// A month is the last 30 finished days, scaled up when fewer have costs
const MONTH_DAYS = 30;
const YEARLY = /year|annual|jahr/i;

const round2 = (n) => Math.round(n * 100) / 100;
const startOfToday = (now) => metrics.dayStart(metrics.todayKey(now));

/** Fixed costs that still run today (until null or not before today), in cents per month. */
function activeFixedCosts(list, now = new Date()) {
  const today = startOfToday(now);
  return (list || []).filter((f) => !f.until || new Date(f.until) >= today);
}

/**
 * The list price per month in cents of the last production purchase of a
 * yearly (or monthly) product, yearly divided by twelve; the configured
 * list price when nobody bought one yet; null when neither exists.
 */
async function priceOf(yearly, prices) {
  const last = await SubscriptionEvent.findOne(
    { environment: "PRODUCTION", type: { $in: metrics.PAID_EVENTS }, productId: yearly ? { $regex: YEARLY } : { $not: YEARLY } },
    { productId: 1, priceCents: 1, priceInPurchasedCurrencyCents: 1 },
  )
    .sort({ eventAt: -1 })
    .lean();
  if (last && (last.priceInPurchasedCurrencyCents ?? last.priceCents) != null) return metrics.monthlyCents(last);
  const listed = yearly ? prices.plusYearlyEurCents : prices.plusMonthlyEurCents;
  return listed == null ? null : yearly ? Math.round(listed / 12) : listed;
}

/**
 * The numbers of the "Unit Economics" card. month.* are euro cents per
 * month: variable costs of the last 30 finished days (scaled to 30 when
 * fewer days have a cost column), fixed costs, MRR, net revenue after the
 * commission and the contribution (net revenue - variable costs). perMau,
 * perTalkMinute, contributionPerMau and perPlusSub are cents with two
 * decimals; minutesPerMau are the Agora participant minutes per active
 * user by mode (one decimal); perPlusSub =
 * average plan price per month × (1 - commission) - the variable costs of
 * one Plus user, assumed to be those of an average active user.
 * breakEven*Subs = (fixed costs + variable costs of the free users) /
 * contribution per subscription of that kind, rounded up; null without a
 * price or with a contribution of zero or less. runwayMonths = bank balance
 * / monthly burn (fixed + variable - net revenue), null without a balance
 * or without a burn.
 */
async function summary(now = new Date()) {
  const [series, config] = await Promise.all([metrics.series(MONTH_DAYS + 1, now), getConfig()]);
  const prices = config.prices;
  const latest = series[series.length - 1] || {};
  const finished = series.filter((d) => !d.partial).slice(-MONTH_DAYS);
  const withCosts = finished.filter((d) => d.costs && typeof d.costs.variableEurCents === "number");
  const total = (pick) => withCosts.reduce((s, d) => s + (pick(d) || 0), 0);
  const scale = withCosts.length ? MONTH_DAYS / withCosts.length : null;

  const variable = scale == null ? null : Math.round(total((d) => d.costs.variableEurCents) * scale);
  const minutes = {
    audio: scale == null ? null : Math.round(total((d) => d.costs.agoraAudioMinutes) * scale),
    video: scale == null ? null : Math.round(total((d) => d.costs.agoraVideoMinutes) * scale),
  };
  // Talk minutes as the stats count them: 1:1 talks plus round minutes per participant
  const talkMinutes = scale == null ? null : Math.round(total((d) => (d.talks?.minutes || 0) + (d.circles?.roomMinutes || 0)) * scale);
  const fixedCosts = activeFixedCosts(config.fixedCosts, now);
  const fixed = fixedCosts.reduce((s, f) => s + f.monthlyEurCents, 0);
  const mau = latest.users?.mau || 0;
  const activeStore = latest.plus?.activeStore || 0;
  const mrr = latest.plus?.mrrCents || 0;
  const keep = 1 - prices.appleCommissionPct / 100;
  const netRevenue = Math.round(mrr * keep);

  const perMau = variable != null && mau ? round2(variable / mau) : null;
  const perUser = perMau ?? 0;
  const perPlusSub = activeStore ? round2((mrr / activeStore) * keep - perUser) : null;
  const variableFree = variable == null ? 0 : Math.max(0, variable - activeStore * perUser);
  const breakEven = (monthly) => {
    if (monthly == null) return null;
    const contribution = monthly * keep - perUser;
    return contribution > 0 ? Math.ceil((fixed + variableFree) / contribution) : null;
  };
  const [yearlyPrice, monthlyPrice] = await Promise.all([priceOf(true, prices), priceOf(false, prices)]);

  const burn = fixed + (variable || 0) - netRevenue;
  const bank = config.ops.bankBalanceEurCents;
  return {
    days: withCosts.length,
    month: {
      variableEurCents: variable,
      variablePerDayEurCents: withCosts.length ? round2(total((d) => d.costs.variableEurCents) / withCosts.length) : null,
      fixedEurCents: fixed,
      mrrCents: mrr,
      netRevenueCents: netRevenue,
      contributionCents: variable == null ? null : netRevenue - variable,
      perMau,
      contributionPerMau: variable != null && mau ? round2((netRevenue - variable) / mau) : null,
      minutesPerMau: {
        audio: minutes.audio != null && mau ? Math.round((minutes.audio / mau) * 10) / 10 : null,
        video: minutes.video != null && mau ? Math.round((minutes.video / mau) * 10) / 10 : null,
      },
      perTalkMinute: variable != null && talkMinutes ? round2(variable / talkMinutes) : null,
      perPlusSub,
      mau,
      activeStore,
      agoraMinutes: minutes,
      talkMinutes,
    },
    planPriceMonthlyCents: { yearly: yearlyPrice, monthly: monthlyPrice },
    breakEvenYearlySubs: breakEven(yearlyPrice),
    breakEvenMonthlySubs: breakEven(monthlyPrice),
    burnEurCents: burn,
    bankBalanceEurCents: bank ?? null,
    bankBalanceAt: config.ops.bankBalanceAt || null,
    runwayMonths: bank == null || burn <= 0 ? null : Math.max(0, Math.round((bank / burn) * 10) / 10),
    fixedCosts,
    prices,
  };
}

module.exports = { summary, activeFixedCosts, MONTH_DAYS };
