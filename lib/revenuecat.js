/**
 * RevenueCat's REST API (v1), for the cases the webhook alone can't settle:
 * a TRANSFER whose source we don't know, and POST /me/plus/sync right after a
 * purchase or restore in the app. Needs REVENUECAT_API_KEY (secret API key
 * v1); without it nothing is fetched. Tests replace fetchSubscriber.
 */
const API_URL = "https://api.revenuecat.com/v1";

const configured = () => !!process.env.REVENUECAT_API_KEY;

/** GET /subscribers/{app_user_id}: the subscriber object, or null when unknown. */
let fetchSubscriber = async (appUserId) => {
  const res = await fetch(`${API_URL}/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${process.env.REVENUECAT_API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`revenuecat_${res.status}`);
  return (await res.json())?.subscriber || null;
};

/** Tests swap the HTTP call; null restores the real one. */
function setFetchSubscriber(fn) {
  fetchSubscriber = fn || module.exports.realFetchSubscriber;
}

const subscriber = (appUserId) => fetchSubscriber(appUserId);

/** User.plus.status from a webhook event's type and period_type. */
function statusFor(type, periodType) {
  if (["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT"].includes(type)) {
    return periodType === "TRIAL" ? "trial" : "active";
  }
  return { CANCELLATION: "cancelled", BILLING_ISSUE: "billing_issue", SUBSCRIPTION_PAUSED: "paused", EXPIRATION: "expired" }[type] || null;
}

/**
 * What the subscriber's subscriptions say about our products: the one that
 * ends last. { active, until, productId, sandbox, status } or null when the
 * subscriber never bought one of them.
 */
function planFromSubscriber(subscriber, productIds, now = new Date()) {
  let best = null;
  for (const [productId, sub] of Object.entries(subscriber?.subscriptions || {})) {
    if (!productIds.includes(productId) || !sub) continue;
    const until = sub.expires_date ? new Date(sub.expires_date) : null;
    if (!best || (best.until && (!until || until > best.until))) best = { productId, sub, until };
  }
  if (!best) return null;
  const { sub, until, productId } = best;
  const active = !until || until > now;
  const status = !active ? "expired" : sub.billing_issues_detected_at ? "billing_issue" : sub.unsubscribe_detected_at ? "cancelled" : String(sub.period_type || "").toLowerCase() === "trial" ? "trial" : "active";
  return { active, until, productId, sandbox: !!sub.is_sandbox, status };
}

module.exports = { configured, subscriber, setFetchSubscriber, realFetchSubscriber: fetchSubscriber, statusFor, planFromSubscriber };
