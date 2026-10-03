/**
 * The store's truth about a user's Plus, applied in one place (plan 2.4):
 * applyStoreState() sets User.plus from what RevenueCat's REST API says
 * about the subscriber, used by POST /me/plus/sync (routes/plus.js) right
 * after a purchase and by the nightly job here. reconcile() checks every
 * user whose Plus came from the store (source store or sandbox) against
 * GET /v1/subscribers/{id}, corrects drift (a missed webhook, a refund that
 * never reached us) and counts: day counters plusReconcileChecked and
 * plusReconcileFixed (lib/opsCounters.js, in MetricsDaily.ops). runDue()
 * runs it once a day between 03:00 and 05:00 Europe/Berlin on the job
 * leader (index.js), booked in AppConfig.ops.plusReconcileFor so two
 * instances or a restart never run it twice. Nothing happens without
 * REVENUECAT_API_KEY.
 */
const User = require("../models/User");
const AppConfig = require("../models/AppConfig");
const revenuecat = require("./revenuecat");
const opsCounters = require("./opsCounters");
const { localParts } = require("./localTime");
const { resetOpsCache } = require("./appConfig");

const ZONE = "Europe/Berlin";
// The window (hours, Europe/Berlin) in which the nightly run happens
const WINDOW_FROM_HOUR = 3;
const WINDOW_TO_HOUR = 5;

const PRODUCT_IDS = ["wannayap_plus_monthly", "wannayap_plus_yearly"];
// Plus that came from the store, in production or from a test account
const STORE_SOURCES = ["store", "sandbox"];

// An admin grant without end date stays whatever the store says
const hasOpenAdminGrant = (user) => user.plus?.source === "admin" && user.plus?.active && !user.plus?.until;

/**
 * User.plus.previousSource for a Plus that now comes from the store: the
 * source it had before (a gift: referral, waitlist, admin, gift; or null)
 * when it switches to the store now, the one remembered when it was from
 * the store already. Set wherever the source becomes store or sandbox
 * (here, routes/plus.js apply and the TRANSFER), so whichever comes first,
 * the webhook or the sync after the purchase, keeps the gift: the gift ->
 * store conversion of plan 2.12 (lib/metrics.js plusDay giftToStore).
 */
const previousSourceFor = (plus) => (STORE_SOURCES.includes(plus?.source) ? plus?.previousSource ?? null : plus?.source || null);

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

// Statuses the store's answer can express (revenuecat.planFromSubscriber);
// "paused" (Google Play) and null (accounts from before the field existed)
// are compared by active and until alone, or every night would count them
// as corrected
const COMPARABLE_STATUS = ["active", "trial", "cancelled", "billing_issue", "expired"];

/**
 * Does `found` (revenuecat.planFromSubscriber, or null for "no subscription")
 * differ from what the user has? Only active, until and status count; the
 * status only when ours is one the store can report; a plan from another
 * source (gift, admin) is never drift.
 */
function differs(user, found) {
  const p = user.plus || {};
  const own = STORE_SOURCES.includes(p.source);
  if (!found) return own && !!p.active;
  if (!found.active && !own) return false;
  if (!!p.active !== found.active || !sameTime(p.until, found.until)) return true;
  return COMPARABLE_STATUS.includes(p.status) && p.status !== found.status;
}

/**
 * Set the user's Plus from the store's answer and save. Returns whether
 * anything changed. The rules of POST /me/plus/sync: a store subscription
 * (active, or anything when the user's Plus is from the store already)
 * replaces what we have, unless an admin grant without end date is open;
 * no subscription at all ends a store Plus that we still show as active.
 */
async function applyStoreState(user, found, now = new Date()) {
  const own = STORE_SOURCES.includes(user.plus?.source);
  if (found && (found.active || own) && !hasOpenAdminGrant(user)) {
    user.plus = { ...user.plus?.toObject?.(), active: found.active, until: found.until, productId: found.productId, status: found.status, source: found.sandbox ? "sandbox" : "store", previousSource: previousSourceFor(user.plus), since: user.plus?.since || now, eventAt: now };
    await user.save();
    return true;
  }
  if (!found && own && user.plus.active) {
    // The store knows nothing about a subscription: whatever we had is gone
    user.plus = { ...user.plus.toObject(), active: false, status: "expired", eventAt: now };
    await user.save();
    return true;
  }
  return false;
}

/**
 * Check every store Plus against RevenueCat and correct what differs.
 * Errors of one subscriber are logged and the run continues. Returns
 * { checked, fixed, failed }, or null without REVENUECAT_API_KEY. `io`
 * tells a corrected user's app (planChanged), when given. Users stream
 * through a cursor with only phone and plus loaded. `now` is the run's
 * start for everyone: a plan that expires while the run is going is
 * caught the next night, which is soon enough.
 */
async function reconcile(now = new Date(), io = null) {
  if (!revenuecat.configured()) return null;
  const result = { checked: 0, fixed: 0, failed: 0 };
  for await (const user of User.find({ "plus.source": { $in: STORE_SOURCES } }, { phone: 1, plus: 1 }).cursor()) {
    try {
      const found = revenuecat.planFromSubscriber(await revenuecat.subscriber(String(user._id)), PRODUCT_IDS, now);
      result.checked++;
      if (!differs(user, found)) continue;
      if (await applyStoreState(user, found, now)) {
        result.fixed++;
        io?.to(`user:${user.phone}`).emit("planChanged", {});
        console.log(`💳 plus-reconcile: ${user._id} corrected to ${found ? `${found.status} until ${found.until?.toISOString() || "–"}` : "no subscription"}`);
      }
    } catch (err) {
      result.failed++;
      console.error(`❌ plus-reconcile ${user._id}:`, err.message);
    }
  }
  if (result.checked) await opsCounters.count("plusReconcileChecked", now, result.checked);
  if (result.fixed) await opsCounters.count("plusReconcileFixed", now, result.fixed);
  if (result.failed) await opsCounters.count("plusReconcileFailed", now, result.failed);
  return result;
}

/**
 * Run reconcile() once a day inside the window. The claim is a conditional
 * update on AppConfig.ops.plusReconcileFor (the day), so a second leader or
 * a restart inside the window finds the day taken. Returns the result, or
 * null when nothing ran.
 */
async function runDue(now = new Date(), io = null) {
  if (!revenuecat.configured()) return null;
  const { dateKey, minutes } = localParts(now, ZONE);
  const hour = Math.floor(minutes / 60);
  if (hour < WINDOW_FROM_HOUR || hour >= WINDOW_TO_HOUR) return null;
  // The ops block may be null (schema default) on a fresh database; a dotted
  // $set into null fails, so turn it into an object first (as routes/ops.js)
  await AppConfig.updateOne({ key: "app", ops: null }, { $set: { ops: {} } });
  await AppConfig.updateOne({ key: "app" }, { $setOnInsert: { key: "app" } }, { upsert: true, setDefaultsOnInsert: false });
  const claimed = await AppConfig.updateOne({ key: "app", "ops.plusReconcileFor": { $ne: dateKey } }, { $set: { "ops.plusReconcileFor": dateKey } });
  if (!claimed.modifiedCount) return null;
  resetOpsCache();
  const result = await reconcile(now, io);
  if (result) console.log(`💳 plus-reconcile: ${result.checked} geprüft, ${result.fixed} korrigiert${result.failed ? `, ${result.failed} fehlgeschlagen` : ""}`);
  return result;
}

module.exports = { previousSourceFor, PRODUCT_IDS, STORE_SOURCES, hasOpenAdminGrant, differs, applyStoreState, reconcile, runDue, WINDOW_FROM_HOUR, WINDOW_TO_HOUR };
