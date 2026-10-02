/**
 * Error tracking with Sentry (plan 2.1): crashes and unhandled request errors
 * of the backend were only visible in the Render log. init() runs first thing
 * in index.js (before express is loaded, so Sentry's Express integration can
 * hook in) and does nothing without SENTRY_DSN or under tests; then every
 * export here is a no-op. Nothing personal leaves the server: no Sentry user
 * (the backend sets none), no request bodies, cookies, query strings or
 * headers beyond the app's version headers, and phone numbers and e-mail
 * addresses are replaced in every string of an event (scrub). The crash
 * handlers in index.js report through captureException + flush; the
 * Express error handler (setupExpressErrorHandler, app.js) reports 5xx.
 * README "Error tracking (Sentry)".
 */

let Sentry = null;

// Request headers that may go along: the app's version and platform, nothing
// that identifies a person (Authorization, Cookie, X-Forwarded-For …)
const KEEP_HEADERS = new Set(["user-agent", "x-app-version", "x-app-build", "x-app-update", "x-platform"]);

// "+4915111111111", "+49 151 1111 1111", URL-encoded "%2B4915111111111"
const PHONE = /(?:\+|%2B)\d(?:[\s-]?\d){7,14}/gi;
// A bare run of 10–15 digits: the app's Agora uid and Cloudinary public ids
// carry the number without "+" (avatar_4915111111111)
const DIGITS = /(?<!\d)\d{10,15}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;

// Fields Sentry fills itself that must stay intact (ids, versions, times)
const SKIP_KEYS = new Set(["event_id", "trace_id", "span_id", "parent_span_id", "release", "dist", "timestamp", "start_timestamp", "sdk", "debug_meta", "modules"]);
const MAX_DEPTH = 12;

/** Phone numbers and e-mail addresses in one string replaced by placeholders. */
function scrubText(text) {
  if (typeof text !== "string") return text;
  return text.replace(EMAIL, "[E-Mail]").replace(PHONE, "[Nummer]").replace(DIGITS, "[Nummer]");
}

/** A URL without query string and fragment ("/verify/start?phone=…" → "/verify/start"). */
function stripQuery(url) {
  return typeof url === "string" ? url.replace(/[?#].*$/s, "") : url;
}

function scrubDeep(value, depth = 0) {
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) out[key] = SKIP_KEYS.has(key) ? v : scrubDeep(v, depth + 1);
  return out;
}

function scrubRequest(request) {
  if (!request || typeof request !== "object") return request;
  const out = { ...request };
  delete out.data;
  delete out.cookies;
  delete out.query_string;
  delete out.env;
  if (out.url) out.url = stripQuery(out.url);
  if (out.headers && typeof out.headers === "object") {
    out.headers = Object.fromEntries(Object.entries(out.headers).filter(([name]) => KEEP_HEADERS.has(name.toLowerCase())));
  }
  return out;
}

/**
 * beforeSend: the event as Sentry may store it. Pure, so the tests check it
 * directly. Breadcrumbs (console lines, outgoing HTTP) go through the same
 * text scrub; their URLs lose the query string as well.
 */
function scrub(event) {
  if (!event || typeof event !== "object") return event;
  const out = { ...event };
  delete out.user;
  if (out.request) out.request = scrubRequest(out.request);
  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs.map((crumb) => (crumb?.data?.url ? { ...crumb, data: { ...crumb.data, url: stripQuery(crumb.data.url) } } : crumb));
  }
  return scrubDeep(out);
}

/** Whether Sentry runs in this process. */
const active = () => Sentry !== null;

/**
 * Start Sentry when SENTRY_DSN is set (never under NODE_ENV=test). Returns
 * whether it runs. Uncaught exceptions and unhandled rejections stay with the
 * crash handler in index.js (one report, the lease handed over, exit), so
 * Sentry's own handlers for them are left out.
 */
function init(env = process.env) {
  if (Sentry) return true;
  if (!env.SENTRY_DSN || env.NODE_ENV === "test") return false;
  Sentry = require("@sentry/node");
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: env.RENDER_GIT_COMMIT || undefined,
    environment: env.SENTRY_ENVIRONMENT || "production",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrub,
    beforeBreadcrumb: (crumb) => scrub({ breadcrumbs: [crumb] }).breadcrumbs[0],
    integrations: (defaults) => defaults.filter((i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection"),
  });
  console.log(`🛰️ Sentry aktiv (${env.SENTRY_ENVIRONMENT || "production"})`);
  return true;
}

/** Report an error; `context` is Sentry's capture context ({ level, tags, extra }). No-op without DSN. */
function captureException(err, context) {
  if (!Sentry) return;
  try {
    Sentry.captureException(err, context);
  } catch (e) {
    console.error("❌ sentry capture:", e.message);
  }
}

/** Wait up to `ms` for queued events to be sent; resolves true without DSN. */
async function flush(ms = 2000) {
  if (!Sentry) return true;
  try {
    return await Sentry.flush(ms);
  } catch {
    return false;
  }
}

/** Sentry's Express error handler (reports 5xx), after all routes; no-op without DSN. */
function setupExpressErrorHandler(app) {
  if (Sentry) Sentry.setupExpressErrorHandler(app);
}

module.exports = { init, active, captureException, flush, setupExpressErrorHandler, scrub, scrubText, stripQuery, KEEP_HEADERS };
