/**
 * Keyed pseudonyms (plan 2.8): User.phoneHmac for every account and the
 * one-off re-keying of ActiveDay.who from SHA-256 to the HMAC. Both run from
 * index.js migrate() on every start and are idempotent; the re-keying is
 * marked in AppConfig.migrations so it runs once. Lives here rather than in
 * index.js so the tests can call it. README "Pseudonymous data".
 */
const User = require("../models/User");
const ActiveDay = require("../models/ActiveDay");
const AppConfig = require("../models/AppConfig");

/** Whether the one-off migration `name` already ran (AppConfig.migrations). */
async function migrationDone(name) {
  const applied = await AppConfig.findOne({ key: "app" }, { migrations: 1 }).lean();
  return !!applied?.migrations?.[name];
}

/** Marks `name` as done; creates the config document when there is none yet. */
async function markMigration(name) {
  // An older document may carry migrations: null (the schema default); the
  // dotted $set needs an object there. setDefaultsOnInsert: false keeps a
  // fresh database free of null subtrees (ops, goals, limits)
  await AppConfig.updateOne({ key: "app", migrations: null }, { $set: { migrations: {} } });
  await AppConfig.updateOne({ key: "app" }, { $set: { [`migrations.${name}`]: new Date() } }, { upsert: true, setDefaultsOnInsert: false });
}

/**
 * Moves the ActiveDay rows of one person from `oldKey` to `newKey`. A day
 * that already has a row under the new key (both processes wrote during a
 * deploy overlap) keeps that one; the old row goes. Returns how many rows
 * now carry the new key. Needs the index on `who` (models/ActiveDay.js).
 */
async function rekeyRows(oldKey, newKey) {
  const rows = await ActiveDay.countDocuments({ who: oldKey });
  if (!rows) return 0;
  let dropped = 0;
  try {
    await ActiveDay.updateMany({ who: oldKey }, { $set: { who: newKey } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // updateMany stopped at a day that exists under both keys: finish row by row
    for (const row of await ActiveDay.find({ who: oldKey }, { _id: 1 }).lean()) {
      try {
        await ActiveDay.updateOne({ _id: row._id }, { $set: { who: newKey } });
      } catch (inner) {
        if (inner.code !== 11000) throw inner;
        await ActiveDay.deleteOne({ _id: row._id });
        dropped++;
      }
    }
  }
  return rows - dropped;
}

/**
 * Every account carries the HMAC of its number under the current pepper.
 * Accounts without phoneHmac (from before plan 2.8) get it. An account whose
 * stored phoneHmac was computed with another pepper (the deployment ran on
 * the JWT_SECRET fallback before PHONE_HASH_PEPPER was set) has its
 * ActiveDay rows re-keyed first and then gets the new value: this makes the
 * one switch that happens in practice lossless; the rule stays "set once,
 * never change". Runs on every start, because the comparison itself says
 * what is left to do; the marker `phoneHmac` only records the first run.
 * Returns { added, rekeyed } (accounts).
 */
async function backfillPhoneHmac() {
  let added = 0;
  let rekeyed = 0;
  for (const user of await User.find({}, { phone: 1, phoneHmac: 1 }).lean()) {
    const hmac = User.hmacPhone(user.phone);
    if (user.phoneHmac === hmac) continue;
    if (user.phoneHmac) {
      await rekeyRows(user.phoneHmac, hmac);
      rekeyed++;
    } else {
      added++;
    }
    await User.updateOne({ _id: user._id }, { $set: { phoneHmac: hmac } });
  }
  if (rekeyed) console.warn(`⚠️ phoneHmac re-keyed for ${rekeyed} user(s): the pepper changed (README "Pseudonymous data")`);
  if (!(await migrationDone("phoneHmac"))) await markMigration("phoneHmac");
  return { added, rekeyed };
}

/**
 * ActiveDay rows written with User.hashPhone become rows under User.hmacPhone,
 * once, account by account (rekeyRows). Rows of accounts deleted before this
 * ran have no owner left to re-key them; they stay unreadable and expire
 * with the TTL (COMPLIANCE.md). Rows an old instance still writes with the
 * SHA-256 during the deploy overlap stay as they are: export and deletion
 * reach them through the three keys (lib/account.js), the active-user counts
 * see that person twice for the windows with that day, once.
 * Returns the number of rows re-keyed, or null when it had already run.
 */
async function rekeyActiveDays() {
  if (await migrationDone("activeDayHmac")) return null;
  let rekeyed = 0;
  for (const user of await User.find({}, { phone: 1 }).lean()) {
    rekeyed += await rekeyRows(User.hashPhone(user.phone), User.hmacPhone(user.phone));
  }
  await markMigration("activeDayHmac");
  return rekeyed;
}

module.exports = { migrationDone, markMigration, rekeyRows, backfillPhoneHmac, rekeyActiveDays };
