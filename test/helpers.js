// Test harness: real app + in-memory MongoDB; Twilio, APNs and Expo are faked.
// With TEST_MONGODB_URI set (the restore drill, README "Backup") the suite runs
// against that cluster instead, in a database of its own that it drops at the
// end; the restored data next to it is never touched.
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
  // Mails "sent" via lib/mailer.js
  mails: [],
  failMailTo: null,
  rejectMailTo: null,
  // Twilio refuses to send to this number
  failSmsTo: null,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "twilio") {
    return () => ({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: async ({ to }) => {
                if (fakes.failSmsTo && to === fakes.failSmsTo) throw new Error("twilio_down");
                fakes.sms.push(to);
              },
            },
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
  if (request === "nodemailer") {
    return {
      createTransport: () => ({
        sendMail: async (mail) => {
          if (fakes.failMailTo && mail.to === fakes.failMailTo) throw new Error("smtp_rejected");
          // The server refuses the recipient (e.g. a domain that takes no mail)
          if (fakes.rejectMailTo && mail.to === fakes.rejectMailTo) {
            throw Object.assign(new Error("Can't send mail - all recipients were rejected: 556 domain does not accept mail"), { code: "EENVELOPE", command: "RCPT TO", responseCode: 556, response: "556 domain does not accept mail" });
          }
          fakes.mails.push(mail);
          return { messageId: `m-${fakes.mails.length}` };
        },
      }),
    };
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

// Every database the suite drops carries this prefix; reset() refuses any other
const TEST_DB_PREFIX = "wannayap-test";

/** The same cluster, another database: "mongodb+srv://u:p@host/prod?x=1" → ".../<name>?x=1". */
function withDatabase(uri, name) {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(String(uri));
  if (!m) throw new Error(`not a MongoDB URI: ${uri}`);
  return `${m[1]}/${name}${m[2] || ""}`;
}

async function setup() {
  if (process.env.TEST_MONGODB_URI) {
    await mongoose.connect(withDatabase(process.env.TEST_MONGODB_URI, `${TEST_DB_PREFIX}-${process.pid}`));
  } else {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(TEST_DB_PREFIX));
  }
  // Short ring timeout so the missed-call path is testable
  ctx = createApp({ ringTimeoutMs: 1500 });
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  ctx.url = `http://127.0.0.1:${ctx.server.address().port}`;
  return ctx;
}

async function teardown() {
  ctx.io.close();
  await new Promise((resolve) => ctx.server.close(resolve));
  if (!mongo) await dropTestDatabase();
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
}

async function dropTestDatabase() {
  const { databaseName } = mongoose.connection.db;
  if (!databaseName.startsWith(TEST_DB_PREFIX)) throw new Error(`refusing to drop database ${databaseName}`);
  await mongoose.connection.db.dropDatabase();
}

async function reset() {
  await dropTestDatabase();
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
  // Unique campaign names: the agent relies on the 409 for a taken one
  await require("../models/AdDraft").syncIndexes();
  await require("../models/ActiveDay").syncIndexes();
  await require("../models/MetricsDaily").syncIndexes();
  require("../lib/metrics").resetActivityCache();
  require("../lib/accessGate").reset();
  require("../lib/appConfig").resetAppCache();
  require("../lib/appConfig").resetFlagsCache();
  require("../lib/appConfig").resetOpsCache();
  await require("../models/SupportTicket").syncIndexes();
  await require("../models/AppConfig").syncIndexes();
  await require("../models/BannedNumber").syncIndexes();
  await require("../models/ClientError").syncIndexes();
  await require("../models/WaitlistEntry").syncIndexes();
  // Unique event ids: the webhook relies on the 11000 for a retried event
  await require("../models/SubscriptionEvent").syncIndexes();
  fakes.sms.length = 0;
  fakes.expoPushes.length = 0;
  fakes.voipPushes.length = 0;
  fakes.mails.length = 0;
  fakes.failMailTo = null;
  fakes.rejectMailTo = null;
  fakes.failSmsTo = null;
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

/** Everyone here has the others' numbers: they may call each other (lib/relations.js isConnected). */
const befriend = (...phones) =>
  Promise.all(phones.map((p) => User.updateOne({ phone: p }, { $addToSet: { contacts: { $each: phones.filter((q) => q !== p) } } })));

module.exports = { setup, teardown, reset, fakes, talked, shareAll, befriend, withDatabase };
