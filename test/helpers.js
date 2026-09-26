// Test harness: real app + in-memory MongoDB; Twilio, APNs and Expo are faked.
const Module = require("module");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_API_KEY = "admin-key";
// Test-only value; real certificates only come from the deployment environment
process.env.AGORA_APP_CERTIFICATE = "0123456789abcdef0123456789abcdef";
process.env.CLOUDINARY_CLOUD_NAME = "testcloud";

const fakes = {
  approvedCode: "123456",
  sms: [],
  expoPushes: [],
  voipPushes: [],
  // ticket id -> receipt, filled by tests
  receipts: {},
  ticketCounter: 0,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "twilio") {
    return () => ({
      verify: {
        v2: {
          services: () => ({
            verifications: { create: async ({ to }) => fakes.sms.push(to) },
            verificationChecks: {
              create: async ({ code }) => ({
                status: code === fakes.approvedCode ? "approved" : "pending",
              }),
            },
          }),
        },
      },
    });
  }
  if (request === "expo-server-sdk") {
    class Expo {
      static isExpoPushToken(t) {
        return typeof t === "string" && t.startsWith("ExponentPushToken[");
      }
      chunkPushNotifications(m) {
        return [m];
      }
      async sendPushNotificationsAsync(chunk) {
        fakes.expoPushes.push(...chunk);
        return chunk.map(() => ({ status: "ok", id: `ticket-${++fakes.ticketCounter}` }));
      }
      chunkPushNotificationReceiptIds(ids) {
        return [ids];
      }
      async getPushNotificationReceiptsAsync(ids) {
        return Object.fromEntries(ids.filter((id) => fakes.receipts[id]).map((id) => [id, fakes.receipts[id]]));
      }
    }
    return { Expo };
  }
  if (request === "node-apn") {
    class Provider {
      async send(notification) {
        fakes.voipPushes.push(notification.payload);
        return { sent: [{}], failed: [] };
      }
    }
    return { Provider, Notification: class {} };
  }
  return originalLoad.apply(this, arguments);
};

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createApp } = require("../app");
const User = require("../models/User");

let mongo;
let ctx;

async function setup() {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Short ring timeout so the missed-call path is testable
  ctx = createApp({ ringTimeoutMs: 1500 });
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
  return ctx;
}

async function teardown() {
  ctx.io.close();
  await new Promise((resolve) => ctx.server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
}

async function reset() {
  await mongoose.connection.db.dropDatabase();
  await User.syncIndexes();
  await require("../models/Call").syncIndexes();
  await require("../models/Talk").syncIndexes();
  await require("../models/Nudge").syncIndexes();
  await require("../models/PushLog").syncIndexes();
  await require("../models/PushTicket").syncIndexes();
  await require("../models/PushDecision").syncIndexes();
  await require("../models/Block").syncIndexes();
  await require("../models/Report").syncIndexes();
  await require("../models/Invite").syncIndexes();
  await require("../models/DailyMoment").syncIndexes();
  await require("../models/Circle").syncIndexes();
  await require("../models/Room").syncIndexes();
  await require("../models/Admin").syncIndexes();
  await require("../models/ActiveDay").syncIndexes();
  await require("../models/MetricsDaily").syncIndexes();
  require("../lib/metrics").resetActivityCache();
  require("../lib/accessGate").reset();
  require("../lib/appConfig").resetAppCache();
  await require("../models/SupportTicket").syncIndexes();
  await require("../models/AppConfig").syncIndexes();
  await require("../models/BannedNumber").syncIndexes();
  fakes.sms.length = 0;
  fakes.expoPushes.length = 0;
  fakes.voipPushes.length = 0;
  fakes.receipts = {};
}

/** a and b just finished a two-minute call (moments need a real call). */
let callCounter = 0;
async function talked(a, b) {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 60 * 1000);
  await require("../models/Call").create({
    callId: `test-call-${++callCounter}`,
    channel: `test_channel_${callCounter}`,
    caller: a,
    callee: b,
    status: "ended",
    createdAt: start,
    acceptedAt: start,
    endedAt: now,
  });
}

/** The other person agreed to every pending moment. */
async function shareAll() {
  await require("../models/CallMoment").updateMany({ status: "pending" }, { status: "shared", sharedAt: new Date() });
}

module.exports = { setup, teardown, reset, fakes, talked, shareAll };
