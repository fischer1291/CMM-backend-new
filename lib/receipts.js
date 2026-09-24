/**
 * Expo push receipts. A ticket only says Expo accepted the message; whether
 * Apple/Google delivered it shows up in the receipt ~15 minutes later.
 * Tokens of uninstalled apps (DeviceNotRegistered) are removed, other
 * errors are logged so credential problems don't go unnoticed.
 */
const User = require("../models/User");
const PushTicket = require("../models/PushTicket");
const PushDecision = require("../models/PushDecision");
const { expo } = require("./push");

const RECEIPT_DELAY_MS = 15 * 60 * 1000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const BATCH = 1000;

async function checkReceipts(now = new Date()) {
  const tickets = await PushTicket.find({ createdAt: { $lte: new Date(now - RECEIPT_DELAY_MS) } })
    .sort({ createdAt: 1 })
    .limit(BATCH)
    .lean();
  if (!tickets.length) return { checked: 0, removedTokens: 0, errors: 0 };

  const byId = new Map(tickets.map((t) => [t.ticketId, t]));
  const done = [];
  let removedTokens = 0;
  let errors = 0;

  for (const ids of expo.chunkPushNotificationReceiptIds([...byId.keys()])) {
    let receipts;
    try {
      receipts = await expo.getPushNotificationReceiptsAsync(ids);
    } catch (err) {
      console.error("❌ Push receipts:", err.message);
      continue;
    }
    for (const [id, receipt] of Object.entries(receipts)) {
      done.push(id);
      const delivery = receipt.status === "error" ? receipt.details?.error || "error" : "delivered";
      await PushDecision.updateOne({ ticketId: id }, { delivery }).catch(() => {});
      if (receipt.status !== "error") continue;
      errors++;
      const ticket = byId.get(id);
      const code = receipt.details?.error;
      if (code === "DeviceNotRegistered") {
        const result = await User.updateMany({ pushToken: ticket.token }, { $unset: { pushToken: 1 } });
        removedTokens += result.modifiedCount;
      } else {
        console.error(`❌ Push receipt ${code || "error"} (${ticket.type}): ${receipt.message}`);
      }
    }
  }

  // Receipts that never came are not worth waiting for
  const stale = tickets.filter((t) => now - t.createdAt > GIVE_UP_MS).map((t) => t.ticketId);
  await PushTicket.deleteMany({ ticketId: { $in: [...done, ...stale] } });
  return { checked: tickets.length, removedTokens, errors };
}

module.exports = { checkReceipts, RECEIPT_DELAY_MS };
