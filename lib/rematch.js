/**
 * Re-match (plan 2.13): "Sag mir, wenn jemand aus meinem Adressbuch
 * dazukommt". Only with the person's opt-in (User.rematch.optIn, PUT
 * /me/rematch), a contact sync (POST /contacts/match, hash variant) keeps
 * the hashes that matched nobody as one AddressBookHash document per owner,
 * each entry peppered (HMAC-SHA256 over the SHA-256 hex the app sent, with
 * the pepper of User.hmacPhone), for 90 days after the last sync. When a new
 * user sets a name (lib/invites.js announceJoined), every owner whose list
 * holds them gets the existing contact_joined push, except people blocked
 * either way and the inviters (they get contact_joined from the invite);
 * then the entry leaves every list. README "Re-match", COMPLIANCE.md.
 */
const User = require("../models/User");
const AddressBookHash = require("../models/AddressBookHash");
const { blockedWith } = require("./relations");
const { notifyMany } = require("./notify");

const MAX_HASHES = 5000;
const KEEP_MS = 90 * 24 * 3600 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * The stored form of a SHA-256 hex from the app: HMAC-SHA256 with the server
 * pepper (User.hmacPhone keys its input with the same pepper as phoneHmac,
 * here the input is the hash, so the two never collide with each other).
 */
const pepperHash = (sha) => User.hmacPhone(sha);

/**
 * Replaces the owner's list with these SHA-256 hashes (the ones of this sync
 * that matched nobody), peppered, deduplicated, at most MAX_HASHES. An empty
 * list removes the document. Returns the number of entries stored.
 */
async function storeHashes(owner, shaHashes, now = new Date()) {
  const valid = [...new Set((shaHashes || []).filter((h) => typeof h === "string" && SHA256_HEX.test(h)))].slice(0, MAX_HASHES);
  if (!valid.length) {
    await AddressBookHash.deleteOne({ owner });
    return 0;
  }
  await AddressBookHash.updateOne(
    { owner },
    { $set: { hashes: valid.map(pepperHash), updatedAt: now, expiresAt: new Date(now.getTime() + KEEP_MS) } },
    { upsert: true },
  );
  return valid.length;
}

/** Opt-out and account deletion: the owner's list goes. */
async function forget(owner) {
  await AddressBookHash.deleteOne({ owner });
}

/**
 * `user` (with phoneHash and a name) just joined: tell the owners whose list
 * holds them, once. Each list loses the entry by a conditional $pull, so two
 * name updates at the same time never push twice. Owners without the opt-in
 * any more, blocked either way, the user's inviters (they hear it from the
 * invite) and the user themself only lose the entry. Returns the owners told.
 */
async function notifyJoined(user, io) {
  if (!user?.phoneHash || !user.name) return [];
  const entry = pepperHash(user.phoneHash);
  const docs = await AddressBookHash.find({ hashes: entry }, { owner: 1 }).lean();
  if (!docs.length) return [];

  const claimed = [];
  for (const doc of docs) {
    const res = await AddressBookHash.updateOne({ _id: doc._id, hashes: entry }, { $pull: { hashes: entry } });
    if (res.modifiedCount) claimed.push(doc.owner);
  }
  const skip = new Set([user.phone, ...(user.invitedBy || []), ...(user.connections || []), ...(user.pendingJoinAnnouncement || [])]);
  const blocked = await blockedWith(user.phone);
  const candidates = claimed.filter((p) => !skip.has(p) && !blocked.has(p));
  if (!candidates.length) return [];
  const owners = (await User.find({ phone: { $in: candidates }, "rematch.optIn": true }, { phone: 1 }).lean()).map((u) => u.phone);
  if (!owners.length) return [];

  for (const phone of owners) {
    io?.to(`user:${phone}`).emit("contactJoined", { phone: user.phone, name: user.name, via: "address_book" });
  }
  await notifyMany(owners, "contact_joined", { phone: user.phone, name: user.name, via: "address_book" });
  return owners;
}

/**
 * Account deletion: the owner's list, and the person's own entry in other
 * lists (left there when they never set a name), go.
 */
async function forgetAccount(phone, phoneHash) {
  await Promise.all([
    forget(phone),
    phoneHash ? AddressBookHash.updateMany({ hashes: pepperHash(phoneHash) }, { $pull: { hashes: pepperHash(phoneHash) } }) : null,
  ]);
}

/** For the export: whether the list exists, how many entries, until when. */
async function summaryOf(owner) {
  const [doc] = await AddressBookHash.aggregate([
    { $match: { owner } },
    { $project: { _id: 0, count: { $size: "$hashes" }, updatedAt: 1, expiresAt: 1 } },
  ]);
  return doc ? { storedHashes: doc.count, updatedAt: doc.updatedAt, expiresAt: doc.expiresAt } : { storedHashes: 0, updatedAt: null, expiresAt: null };
}

module.exports = { storeHashes, notifyJoined, forget, forgetAccount, summaryOf, pepperHash, MAX_HASHES, KEEP_MS };
