const jwt = require("jsonwebtoken");
const { normalizePhone } = require("./phone");
// Lazily: lib/metrics pulls in every model
const markActive = (phone) => require("./metrics").markActive(phone);

// Tokens are long-lived: the app has no password, re-login needs a new SMS.
const TOKEN_TTL = "180d";

const authRequired = () => process.env.AUTH_REQUIRED === "true";
const jwtSecret = () => process.env.JWT_SECRET || null;

/** Issue a token for a verified phone number, or null if no secret is set. */
function signToken(phone) {
  const secret = jwtSecret();
  if (!secret) return null;
  return jwt.sign({ sub: phone }, secret, { expiresIn: TOKEN_TTL });
}

/** { phone, issuedAt } from a valid token, or null. */
function readToken(token) {
  const secret = jwtSecret();
  if (!secret || !token) return null;
  try {
    const payload = jwt.verify(token, secret);
    return typeof payload.sub === "string" ? { phone: payload.sub, issuedAt: payload.iat || 0 } : null;
  } catch {
    return null;
  }
}

/** Phone number from a valid token, or null. */
const verifyToken = (token) => readToken(token)?.phone ?? null;

/** Phone number from a valid token that moderation hasn't revoked, or null. */
async function acceptToken(token) {
  const read = readToken(token);
  if (!read) return null;
  const { tokenAllowed } = require("./accessGate");
  return (await tokenAllowed(read.phone, read.issuedAt)) ? read.phone : null;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * Express middleware. With a valid token, req.auth = { phone }.
 * An invalid token is always rejected. Without a token, the request is
 * rejected only when AUTH_REQUIRED=true (legacy clients send no token).
 */
async function authenticate(req, res, next) {
  const token = bearerToken(req);
  if (token) {
    const phone = await acceptToken(token).catch(() => null);
    if (!phone) {
      return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }
    req.auth = { phone };
    markActive(phone);
    return next();
  }
  if (authRequired()) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }
  req.auth = null;
  return next();
}

/**
 * The phone number a request acts as. Authenticated requests always act as
 * their own number; a different claimed number is rejected (403).
 * Legacy (token-less) requests fall back to the claimed number.
 * Returns null after sending an error response.
 */
function actingPhone(req, res, claimed) {
  // Claimed numbers come from the app's own E.164 value, maybe without "+"
  const claimedPhone = claimed
    ? normalizePhone(String(claimed), undefined, { preferInternational: true })
    : null;
  if (req.auth) {
    if (claimedPhone && claimedPhone !== req.auth.phone) {
      res.status(403).json({ success: false, error: "Phone does not match token" });
      return null;
    }
    return req.auth.phone;
  }
  if (!claimedPhone) {
    res.status(400).json({ success: false, error: "Phone number required" });
    return null;
  }
  return claimedPhone;
}

/** Socket.IO middleware: socket.data.phone from handshake auth token. */
async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    const phone = await acceptToken(token).catch(() => null);
    if (!phone) return next(new Error("Invalid or expired token"));
    socket.data.phone = phone;
    markActive(phone);
    return next();
  }
  if (authRequired()) return next(new Error("Authentication required"));
  socket.data.phone = null;
  return next();
}

/** Guard for internal/cron endpoints: requires the X-Admin-Key header. */
function requireAdminKey(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.headers["x-admin-key"] !== key) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  return next();
}

module.exports = {
  signToken,
  verifyToken,
  authenticate,
  actingPhone,
  authenticateSocket,
  requireAdminKey,
  authRequired,
};
