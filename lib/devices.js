/**
 * The devices an account is signed in on (plan 2.9): read and clean the
 * X-Device-Id / X-Device-Model headers the app sends, keep User.devices
 * (at most MAX_DEVICES, the least recently seen fall out), refresh an entry
 * at most every REFRESH_MS per device on authenticated requests, and tell
 * which entry is the calling device. The id is the iOS identifierForVendor
 * or a UUID the app made once (never an advertising id); it decides whether
 * a sign-in comes from a known device (routes/verify.js: recycled numbers,
 * the new_device push).
 */
const User = require("../models/User");

const MAX_DEVICES = 10;
// Authenticated requests refresh lastSeenAt this rarely per device
const REFRESH_MS = 6 * 3600 * 1000;
const DEVICE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_MODEL_LENGTH = 40;
const VERSION = /^\d{1,3}(\.\d{1,3}){0,2}$/;

/** The calling device's id from X-Device-Id, or null when missing or malformed. */
function deviceIdOf(headers) {
  const id = String(headers?.["x-device-id"] || "").trim();
  return DEVICE_ID.test(id) ? id : null;
}

/**
 * What the headers say about the calling device, or null without a valid
 * X-Device-Id: { id, model, platform, appVersion, appBuild }. The model is
 * free text from the device (expo-device modelName), stripped of control
 * characters and cut to MAX_MODEL_LENGTH.
 */
function deviceOf(headers) {
  const id = deviceIdOf(headers);
  if (!id) return null;
  const model =
    String(headers["x-device-model"] || "")
      .replace(/[\u0000-\u001f\u007f<>]/g, "")
      .trim()
      .slice(0, MAX_MODEL_LENGTH) || null;
  const platform = ["ios", "android", "web"].includes(headers["x-platform"]) ? headers["x-platform"] : null;
  const version = String(headers["x-app-version"] || "").slice(0, 20);
  const appVersion = VERSION.test(version) ? version : null;
  const appBuild = String(headers["x-app-build"] || "").replace(/[^\d]/g, "").slice(0, 8) || null;
  return { id, model, platform, appVersion, appBuild };
}

/** Is `id` one of the account's known devices? */
const knownDevice = (user, id) => !!id && (user?.devices || []).some((d) => d.id === id);

// phone -> Map(device id -> { at, sig }) of the last write by this instance
const written = new Map();
const signature = (device) => `${device.model}|${device.platform}|${device.appVersion}|${device.appBuild}`;

/**
 * Store `device` (deviceOf) on the account: refresh the entry with the same
 * id, or add one and keep the MAX_DEVICES most recently seen. Two steps, the
 * second only when the first found nothing; a concurrent add of the same id
 * is excluded by the filter of the second.
 */
async function rememberDevice(phone, device, now = new Date()) {
  if (!phone || !device?.id) return;
  const set = { "devices.$.lastSeenAt": now };
  for (const key of ["model", "platform", "appVersion", "appBuild"]) {
    if (device[key]) set[`devices.$.${key}`] = device[key];
  }
  const { matchedCount } = await User.updateOne({ phone, "devices.id": device.id }, { $set: set });
  if (!matchedCount) {
    const entry = {
      id: device.id,
      model: device.model || null,
      platform: device.platform || null,
      appVersion: device.appVersion || null,
      appBuild: device.appBuild || null,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await User.updateOne(
      { phone, "devices.id": { $ne: device.id } },
      { $push: { devices: { $each: [entry], $sort: { lastSeenAt: 1 }, $slice: -MAX_DEVICES } } },
    );
  }
  note(phone, device, now);
}

function note(phone, device, now) {
  let mine = written.get(phone);
  if (!mine) {
    mine = new Map();
    written.set(phone, mine);
    if (written.size > 50_000) written.delete(written.keys().next().value);
  }
  mine.set(device.id, { at: now.getTime(), sig: signature(device) });
}

/**
 * For every authenticated request (lib/auth.js, next to rememberApp): a
 * write only when this instance has not written the device in REFRESH_MS
 * or the model or app version changed. Fire and forget.
 */
function touchDevice(phone, headers, now = new Date()) {
  const device = deviceOf(headers);
  if (!phone || !device) return;
  const last = written.get(phone)?.get(device.id);
  if (last && now.getTime() - last.at < REFRESH_MS && last.sig === signature(device)) return;
  note(phone, device, now);
  rememberDevice(phone, device, now).catch((err) => {
    written.get(phone)?.delete(device.id);
    console.error("❌ rememberDevice:", err.message);
  });
}

/** Forget what this instance wrote for `phone` (after logout-all), or everything. */
function forgetDevices(phone) {
  if (phone) written.delete(phone);
  else written.clear();
}

/** The account's devices for GET /me/devices, most recently seen first. */
function listDevices(user, currentId) {
  return [...(user?.devices || [])]
    .sort((a, b) => (b.lastSeenAt?.getTime?.() || 0) - (a.lastSeenAt?.getTime?.() || 0))
    .map((d) => ({
      id: d.id,
      model: d.model || null,
      platform: d.platform || null,
      appVersion: d.appVersion || null,
      appBuild: d.appBuild || null,
      lastSeenAt: d.lastSeenAt || null,
      current: !!currentId && d.id === currentId,
    }));
}

module.exports = { deviceIdOf, deviceOf, knownDevice, rememberDevice, touchDevice, forgetDevices, listDevices, MAX_DEVICES, REFRESH_MS };
