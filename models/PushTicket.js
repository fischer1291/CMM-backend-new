const mongoose = require("mongoose");

// Expo push tickets waiting for their receipt (see lib/receipts.js).
const pushTicketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  token: { type: String, required: true },
  type: { type: String },
  createdAt: { type: Date, default: Date.now },
});

// Expo keeps receipts for about a day
pushTicketSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });

module.exports = mongoose.model("PushTicket", pushTicketSchema);
