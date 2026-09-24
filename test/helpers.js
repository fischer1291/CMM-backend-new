// Test harness: real app + in-memory MongoDB; Twilio, APNs and Expo are faked.
const Module = require("module");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_API_KEY = "admin-key";

const fakes = {
  approvedCode: "123456",
  sms: [],
  expoPushes: [],
  voipPushes: [],
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
        return chunk.map(() => ({ status: "ok" }));
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
  fakes.sms.length = 0;
  fakes.expoPushes.length = 0;
  fakes.voipPushes.length = 0;
}

module.exports = { setup, teardown, reset, fakes };
