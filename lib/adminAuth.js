/**
 * Admin console sign-in: passwords (scrypt), TOTP (RFC 6238) and a session
 * cookie. Admin sessions are signed with a key derived from JWT_SECRET, so
 * app tokens and admin sessions can never be swapped.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const AdminAudit = require("../models/AdminAudit");

const COOKIE = "cmm_admin";
const SESSION_HOURS = 12;
const ROLES = { viewer: 1, support: 2, owner: 3 };

// --- Passwords -------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** At least 12 characters. */
const strongEnough = (password) => typeof password === "string" && password.length >= 12 && password.length <= 200;

// --- TOTP --------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function fromBase32(text) {
  let bits = "";
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const newTotpSecret = () => base32(crypto.randomBytes(20));

function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

/** The matching time step (±1 for clock drift), or null. */
function checkTotp(secret, code, now = Date.now()) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

const otpauthUrl = (email, secret) =>
  `otpauth://totp/${encodeURIComponent(`Wanna Yap Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent("Wanna Yap Admin")}&algorithm=SHA1&digits=6&period=30`;

// --- Sessions ----------------------------------------------------------------

function sessionKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("cmm-admin-session").digest();
}

function signSession(admin) {
  const key = sessionKey();
  if (!key) return null;
  return jwt.sign({ sub: String(admin._id), v: admin.sessionVersion, aud: "admin" }, key, { expiresIn: `${SESSION_HOURS}h` });
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "test" ? "" : " Secure;";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// --- Audit -------------------------------------------------------------------

async function audit(req, action, { target = null, meta = null, admin } = {}) {
  try {
    await AdminAudit.create({ admin: admin || req.admin?.email || "unknown", action, target, meta, ip: req.ip });
  } catch (err) {
    console.error("❌ admin audit:", err.message);
  }
}

// --- Middleware --------------------------------------------------------------

/**
 * Requires a valid admin session with at least `role`. Changing requests must
 * also carry "X-Admin-Request: 1" (the console always sends it; a form on
 * another site can't), on top of the SameSite=Strict cookie.
 */
function requireAdmin(role = "viewer") {
  return async (req, res, next) => {
    const key = sessionKey();
    const token = readCookie(req, COOKIE);
    if (!key || !token) return res.status(401).json({ success: false, error: "admin_login_required" });
    let payload;
    try {
      payload = jwt.verify(token, key, { audience: "admin" });
    } catch {
      return res.status(401).json({ success: false, error: "admin_login_required" });
    }
    const admin = await Admin.findById(payload.sub).catch(() => null);
    if (!admin || !admin.totpEnabled || admin.sessionVersion !== payload.v) {
      return res.status(401).json({ success: false, error: "admin_login_required" });
    }
    if (req.method !== "GET" && req.headers["x-admin-request"] !== "1") {
      return res.status(403).json({ success: false, error: "missing_admin_header" });
    }
    if ((ROLES[admin.role] || 0) < ROLES[role]) {
      return res.status(403).json({ success: false, error: "forbidden" });
    }
    req.admin = admin;
    return next();
  };
}

module.exports = {
  COOKIE,
  hashPassword,
  checkPassword,
  strongEnough,
  newTotpSecret,
  totpAt,
  currentStep,
  checkTotp,
  otpauthUrl,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
  audit,
  requireAdmin,
};
