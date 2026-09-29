const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { encodeCBOR } = require("@levischuck/tiny-cbor");
const { setup, teardown, reset } = require("./helpers");
const Admin = require("../models/Admin");
const { totpAt, currentStep } = require("../lib/adminAuth");

let ctx;
before(async () => {
  process.env.ADMIN_RP_ID = "api.wannayap.test";
  process.env.ADMIN_ORIGIN = "https://api.wannayap.test";
  ctx = await setup();
});
after(async () => {
  delete process.env.ADMIN_RP_ID;
  delete process.env.ADMIN_ORIGIN;
  await teardown();
});
beforeEach(reset);

const EMAIL = "owner@example.com";
const PASSWORD = "a-long-admin-password";
const cookieOf = (res) => (res.headers["set-cookie"] || [])[0]?.split(";")[0];
const admin = (cookie) => ({ Cookie: cookie, "X-Admin-Request": "1" });
let secret;
async function ownerCookie() {
  const who = { email: EMAIL, password: PASSWORD };
  const started = await request(ctx.app).post("/admin/auth/setup").send({ ...who, setupKey: "admin-key" }).expect(200);
  secret = started.body.secret;
  const done = await request(ctx.app).post("/admin/auth/setup/confirm").send({ ...who, code: totpAt(secret, currentStep()) }).expect(200);
  return cookieOf(done);
}
// A code works only once: forget the last one used, then take the current code
async function freshCode() {
  await Admin.updateOne({ email: EMAIL }, { totpLastStep: 0 });
  return totpAt(secret, currentStep());
}

/** A software authenticator with Face ID: one P-256 key, user presence and verification. */
function authenticator({ rpId = "api.wannayap.test", origin = "https://api.wannayap.test", uv = true } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
  const flags = (at) => Buffer.from([0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0)]);
  const count = () => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(counter);
    return b;
  };
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  let userHandle = null;
  return {
    id: credId.toString("base64url"),
    create(options) {
      userHandle = options.user.id;
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpIdHash, flags(true), count(), Buffer.alloc(16), len, credId, Buffer.from(encodeCBOR(cose))]);
      const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: {},
      };
    },
    get(options) {
      counter++;
      const authData = Buffer.concat([rpIdHash, flags(false), count()]);
      const cd = clientData("webauthn.get", options.challenge);
      const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]), privateKey);
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"), userHandle },
        clientExtensionResults: {},
      };
    },
  };
}

async function addPasskey(cookie, device = authenticator()) {
  const opts = (await request(ctx.app).post("/admin/passkeys/options").set(admin(cookie)).send({ code: await freshCode() }).expect(200)).body.options;
  assert.equal(opts.rp.id, "api.wannayap.test");
  assert.equal(opts.authenticatorSelection.userVerification, "required");
  const added = await request(ctx.app).post("/admin/passkeys").set(admin(cookie)).set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)").send({ response: device.create(opts) }).expect(200);
  return { device, list: added.body.passkeys };
}

async function passkeyLogin(device) {
  const opts = (await request(ctx.app).post("/admin/auth/passkey/options").expect(200)).body.options;
  return request(ctx.app).post("/admin/auth/passkey/login").send({ response: device.get(opts) });
}

test("passkeys: adding one needs a fresh code, then Face ID signs in without password and code", async () => {
  const cookie = await ownerCookie();
  await request(ctx.app).post("/admin/passkeys/options").set(admin(cookie)).send({ code: "000000" }).expect(401);
  const { device, list } = await addPasskey(cookie);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "iPhone");
  assert.ok(!JSON.stringify(list).includes("publicKey"), "the console never gets the key");

  const res = await passkeyLogin(device);
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.email, EMAIL);
  const session = cookieOf(res);
  assert.match(session, /^cmm_admin=/);
  await request(ctx.app).get("/admin/me").set(admin(session)).expect(200);
  const stored = (await Admin.findOne({ email: EMAIL })).passkeys[0];
  assert.equal(stored.counter, 1);
  assert.ok(stored.lastUsedAt);
});

test("passkeys: a challenge works once, unknown keys and other sites are refused, removed keys stop working", async () => {
  const cookie = await ownerCookie();
  const { device } = await addPasskey(cookie);

  // Replay: the same signed answer a second time
  const opts = (await request(ctx.app).post("/admin/auth/passkey/options").expect(200)).body.options;
  const answer = device.get(opts);
  await request(ctx.app).post("/admin/auth/passkey/login").send({ response: answer }).expect(200);
  await request(ctx.app).post("/admin/auth/passkey/login").send({ response: answer }).expect(400);

  // A key that was never added
  assert.equal((await passkeyLogin(authenticator())).status, 401);

  // A key registered for a phishing site: the site's answer does not fit ours
  const phishing = authenticator({ origin: "https://api.wannayap.evil" });
  const evil = await request(ctx.app).post("/admin/passkeys/options").set(admin(cookie)).send({ code: await freshCode() }).expect(200);
  await request(ctx.app).post("/admin/passkeys").set(admin(cookie)).send({ response: phishing.create(evil.body.options) }).expect(400);

  // Without Face ID (user verification) it doesn't count
  const noUv = authenticator({ uv: false });
  const o2 = await request(ctx.app).post("/admin/passkeys/options").set(admin(cookie)).send({ code: await freshCode() }).expect(200);
  await request(ctx.app).post("/admin/passkeys").set(admin(cookie)).send({ response: noUv.create(o2.body.options) }).expect(400);

  // Removed: signs in no more
  await request(ctx.app).delete(`/admin/passkeys/${device.id}`).set(admin(cookie)).expect(200);
  assert.equal((await passkeyLogin(device)).status, 401);
});

test("passkeys: a locked account stays locked", async () => {
  const cookie = await ownerCookie();
  const { device } = await addPasskey(cookie);
  await Admin.updateOne({ email: EMAIL }, { lockedUntil: new Date(Date.now() + 60_000) });
  assert.equal((await passkeyLogin(device)).status, 429);
});
