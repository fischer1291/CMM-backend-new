/**
 * Passkeys for the admin console: sign in with Face ID or Touch ID instead of
 * password and code. A passkey needs the device and its biometrics (user
 * verification is required), so it replaces both factors. Adding one needs a
 * signed-in session plus a fresh code from the authenticator app.
 *
 * The relying party is the host the console runs on (ADMIN_RP_ID, default the
 * host of PUBLIC_API_URL, i.e. api.wannayap.app).
 */
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const Admin = require("../models/Admin");
const AdminChallenge = require("../models/AdminChallenge");

const MAX_PASSKEYS = 10;

function rp() {
  const rpID = process.env.ADMIN_RP_ID || new URL(process.env.PUBLIC_API_URL || "https://api.wannayap.app").hostname;
  return { rpID, origin: process.env.ADMIN_ORIGIN || `https://${rpID}` };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const device = (ua = "") => (/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "Gerät");

/** The challenge a response answers, from its clientDataJSON. */
function challengeOf(response) {
  try {
    return JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")).challenge || null;
  } catch {
    return null;
  }
}

/** Use a stored challenge once. Returns it or null. */
async function consume(challenge, purpose, adminId = null) {
  if (typeof challenge !== "string" || challenge.length > 200) return null;
  const doc = await AdminChallenge.findOneAndDelete({ _id: challenge, purpose, ...(adminId ? { admin: adminId } : {}) });
  if (!doc || Date.now() - doc.createdAt > 5 * 60 * 1000) return null;
  return challenge;
}

// --- Adding a passkey (signed in) ----------------------------------------------------

async function registrationOptions(admin) {
  const { rpID } = rp();
  const options = await generateRegistrationOptions({
    rpName: "Wanna yap? Admin",
    rpID,
    userName: admin.email,
    userID: Buffer.from(String(admin._id)),
    attestationType: "none",
    excludeCredentials: (admin.passkeys || []).map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await AdminChallenge.create({ _id: options.challenge, purpose: "register", admin: admin._id });
  return options;
}

async function register(admin, response, userAgent) {
  if ((admin.passkeys || []).length >= MAX_PASSKEYS) return { error: "too_many" };
  const challenge = await consume(challengeOf(response), "register", admin._id);
  if (!challenge) return { error: "expired" };
  const { rpID, origin } = rp();
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (err) {
    return { error: "invalid", message: err.message };
  }
  if (!result.verified) return { error: "invalid" };
  const { credential } = result.registrationInfo;
  const updated = await Admin.findOneAndUpdate(
    { _id: admin._id, "passkeys.credentialId": { $ne: credential.id } },
    {
      $push: {
        passkeys: {
          credentialId: credential.id,
          publicKey: b64url(credential.publicKey),
          counter: credential.counter || 0,
          transports: credential.transports || [],
          name: device(userAgent),
        },
      },
    },
    { new: true },
  );
  if (!updated) return { error: "exists" };
  return { admin: updated };
}

async function remove(admin, credentialId) {
  const res = await Admin.updateOne({ _id: admin._id }, { $pull: { passkeys: { credentialId: String(credentialId || "") } } });
  return res.modifiedCount > 0;
}

const list = (admin) => (admin.passkeys || []).map((p) => ({ id: p.credentialId, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));

// --- Signing in ----------------------------------------------------------------------

async function loginOptions() {
  const { rpID } = rp();
  // No list of keys: the device offers the passkeys it has for this site
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
  await AdminChallenge.create({ _id: options.challenge, purpose: "login" });
  return options;
}

/** Returns { admin } or { error }. */
async function login(response) {
  const challenge = await consume(challengeOf(response), "login");
  if (!challenge) return { error: "expired" };
  const id = typeof response?.id === "string" ? response.id : "";
  const admin = await Admin.findOne({ totpEnabled: true, "passkeys.credentialId": id });
  if (!admin) return { error: "unknown" };
  if (admin.lockedUntil && admin.lockedUntil > new Date()) return { error: "locked", until: admin.lockedUntil };
  const key = admin.passkeys.find((p) => p.credentialId === id);
  const { rpID, origin } = rp();
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: key.credentialId, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports },
    });
  } catch (err) {
    return { error: "invalid", message: err.message };
  }
  if (!result.verified) return { error: "invalid" };
  key.counter = result.authenticationInfo.newCounter;
  key.lastUsedAt = new Date();
  admin.lastLoginAt = new Date();
  admin.failedLogins = 0;
  await admin.save();
  return { admin };
}

module.exports = { rp, registrationOptions, register, remove, list, loginOptions, login };
