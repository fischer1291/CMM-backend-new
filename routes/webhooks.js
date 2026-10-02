/**
 * Webhooks that are signed over the raw request body, mounted in app.js
 * before the JSON parser and outside the app's token check. POST
 * /webhooks/sentry (plan 2.1): a Sentry Internal Integration calls it for
 * alert rules with the action "Send a notification via <integration>"
 * ("event_alert", level fatal or error: the rule's own filters decide which
 * project alerts at which level) and, if its issue webhooks are switched on,
 * for every new issue of the whole organisation ("issue", action "created").
 * Those bypass every rule filter and the app reports each handled error as
 * level error, so they only alert at level fatal. Either becomes the alert
 * sentry_fatal (lib/alerts.js: push, mail, SMS to the owner). The alert text carries only project, level,
 * release, the short issue id and the Sentry link, never the error message:
 * it may contain user data and it reaches lock screens and inboxes.
 * README "Error tracking (Sentry)".
 */
const crypto = require("crypto");
const express = require("express");
const opsCounters = require("../lib/opsCounters");
const { alert } = require("../lib/alerts");

const countOps = (name) => opsCounters.count(name).catch((err) => console.error("❌ opsCounters:", err.message));

/** sentry-hook-signature: HMAC-SHA256 (hex) of the raw body with SENTRY_WEBHOOK_SECRET, compared in constant time. */
function sentrySignatureValid(rawBody, signature, secret = process.env.SENTRY_WEBHOOK_SECRET) {
  if (!secret || typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

// Only plain identifiers go into the alert text (it ends up in an SMS)
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;
const slug = (value) => {
  const s = typeof value === "number" ? String(value) : value;
  return typeof s === "string" && SLUG.test(s) ? s : null;
};
// event_alert carries the project as a numeric id; its API url
// ".../api/0/projects/<org>/<project>/events/<id>/" names the slug. A bare
// number says nothing to the reader, so it is left out
const projectOf = (source) => {
  const named = slug(source.project?.slug) || slug(source.project?.name) || slug(source.project_slug) || slug(source.project);
  if (named && !/^\d+$/.test(named)) return named;
  const fromUrl = typeof source.url === "string" && /^https:\/\/(?:[a-z0-9-]+\.)?sentry\.io\/api\/0\/projects\/[^/]+\/([^/]+)\//i.exec(source.url);
  const fromUrlSlug = fromUrl && slug(fromUrl[1]);
  return fromUrlSlug && !/^\d+$/.test(fromUrlSlug) ? fromUrlSlug : null;
};
// The app's release is "<bundleId>@<version>+<build>", the backend's the commit
const releaseOf = (value) => {
  const raw = typeof value === "string" ? value : value?.version;
  if (typeof raw !== "string") return null;
  const short = raw.split("@").pop().slice(0, 12);
  return /^[A-Za-z0-9._+-]{1,12}$/.test(short) ? short : null;
};
// Links into Sentry only (sentry.io or <org>.sentry.io)
const SENTRY_LINK = /^https:\/\/(?:[a-z0-9-]+\.)?sentry\.io\/[^\s<>"]*$/i;
const linkOf = (...candidates) => candidates.find((url) => typeof url === "string" && url.length <= 300 && SENTRY_LINK.test(url)) || null;

/**
 * What a Sentry webhook means for us: null to ignore it, otherwise the
 * alert text. Pure, so the tests check it directly.
 */
function sentryAlertText(resource, payload) {
  let source;
  let levels;
  if (resource === "event_alert") {
    source = payload?.data?.event;
    levels = ["fatal", "error"];
  } else if (resource === "issue" && payload?.action === "created") {
    // Organisation-wide, past every alert rule: fatal only (README)
    source = payload?.data?.issue;
    levels = ["fatal"];
  } else return null;
  if (!source || typeof source !== "object") return null;
  const level = source.level;
  if (!levels.includes(level)) return null;

  const project = projectOf(source);
  const release = releaseOf(source.release);
  const shortId = slug(source.shortId) || slug(source.short_id) || slug(source.issue_id);
  const link = linkOf(source.web_url, source.issue_url, source.permalink);
  const what = level === "fatal" ? "Neuer fataler Absturz" : "Neuer Fehler";
  const parts = [`${what} in ${project ? `Projekt ${project}` : "Sentry"}`];
  if (release) parts.push(`Release ${release}`);
  if (shortId) parts.push(`Issue ${shortId}`);
  return `${parts.join(", ")}. ${link || "Details in Sentry."}`;
}

module.exports = () => {
  const router = express.Router();

  router.post("/webhooks/sentry", express.raw({ type: () => true, limit: "256kb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!sentrySignatureValid(raw, req.headers["sentry-hook-signature"])) {
      countOps("sentryUnauthorized");
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ success: false, error: "invalid_json" });
    }
    const text = sentryAlertText(String(req.headers["sentry-hook-resource"] || ""), payload);
    // Sentry waits only briefly for the answer: reply first, alert after
    res.json({ success: true });
    if (!text) return;
    alert("sentry_fatal", text, { level: "error", title: "Neuer Absturz (Sentry)" }).catch((err) => console.error("❌ sentry alert:", err.message));
  });

  return router;
};

module.exports.sentrySignatureValid = sentrySignatureValid;
module.exports.sentryAlertText = sentryAlertText;
