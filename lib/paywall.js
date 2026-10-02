/**
 * The paywall funnel and the plan limits people run into (plan 2.6a),
 * without an event log: the app reports each paywall step with where the
 * paywall was opened from (POST /me/plus/funnel, routes/plus.js), the server
 * counts every refusal by a plan limit, and both land in the day counters
 * (lib/opsCounters.js). lib/metrics.js computeDay turns them into
 * MetricsDaily.plus.funnel and plus.limitHits; lib/alerts.js reads the
 * failure steps for purchase_failures. Counter names are camelCase without
 * "_": paywallView, purchaseSuccess ..., paywallViewFromLimitCircles,
 * purchaseSuccessFromSettings ..., limitHitCircles, limitHitRoomMinutes ...
 * The step and source names are the contract with the app (CMM
 * app/plus.tsx, router.push('/plus?from=<source>')).
 */
const opsCounters = require("./opsCounters");

const STEPS = ["paywall_view", "purchase_start", "purchase_success", "purchase_cancel", "purchase_error", "restore_success", "restore_error", "offering_empty"];
const SOURCES = [
  "settings", "memories", "appicon", "year", "room",
  "limit_circles", "limit_rituals", "limit_members", "limit_moments",
  "referral", "plus_expiring", "billing_issue", "plus_winback_3", "plus_winback_30", "cancel", "trial_ending", "push", "other",
];
// Steps counted per source too: views and purchases are what "Paywall-View
// -> Kauf je Quelle" needs; the rest stays a day total
const BY_SOURCE = { paywall_view: "view", purchase_success: "success" };
// What the alert purchase_failures adds up
const FAILURE_STEPS = ["purchase_error", "restore_error", "offering_empty"];

/** "limit_circles" -> "limitCircles"; "plus_winback_3" -> "plusWinback3". */
const camel = (name) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const upper = (name) => name.charAt(0).toUpperCase() + name.slice(1);
/** The day counter of a step: "paywall_view" -> "paywallView". */
const stepCounter = (step) => camel(step);
/** The day counter of a step from a source: paywallViewFromLimitCircles. */
const sourceCounter = (step, from) => `${camel(step)}From${upper(camel(from))}`;
const sourceOf = (from) => (SOURCES.includes(from) ? from : "other");
const swallow = (err) => console.error("❌ opsCounters:", err.message);

/** Count one funnel step (validated by the caller) for its source. */
async function countStep(step, from, now = new Date()) {
  const source = sourceOf(from);
  await opsCounters.count(stepCounter(step), now);
  if (BY_SOURCE[step]) await opsCounters.count(sourceCounter(step, source), now);
}

/**
 * A plan limit refused something: limitHit + the limit in CamelCase
 * (limitHitCircles, limitHitMomentsPerDay, limitHitVideo ...). Fire and
 * forget: a refusal never waits for or fails on its counter.
 */
function countLimitHit(limit, now = new Date()) {
  opsCounters.count(`limitHit${upper(limit)}`, now).catch(swallow);
}

/** MetricsDaily.plus.funnel from one day's counters. */
function funnelOf(counts) {
  const funnel = {};
  for (const step of STEPS) funnel[stepCounter(step)] = counts[stepCounter(step)] || 0;
  const bySource = {};
  for (const from of SOURCES) {
    const row = {};
    for (const [step, key] of Object.entries(BY_SOURCE)) row[key] = counts[sourceCounter(step, from)] || 0;
    if (Object.values(row).some((n) => n > 0)) bySource[from] = row;
  }
  funnel.bySource = bySource;
  return funnel;
}

/** MetricsDaily.plus.limitHits from one day's counters: { circles: 2, roomMinutes: 1, ... }. */
function limitHitsOf(counts) {
  const hits = {};
  for (const [name, n] of Object.entries(counts)) {
    const limit = name.startsWith("limitHit") ? name.slice("limitHit".length) : "";
    if (limit && n > 0) hits[limit.charAt(0).toLowerCase() + limit.slice(1)] = n;
  }
  return hits;
}

/** Today's failures for the alert: { purchaseError, restoreError, offeringEmpty }. */
const failuresOf = (counts) => Object.fromEntries(FAILURE_STEPS.map((step) => [stepCounter(step), counts[stepCounter(step)] || 0]));

module.exports = { STEPS, SOURCES, FAILURE_STEPS, countStep, countLimitHit, funnelOf, limitHitsOf, failuresOf, sourceOf, stepCounter, sourceCounter };
