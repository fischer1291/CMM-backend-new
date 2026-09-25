const mongoose = require("mongoose");

// "Hilfe & Feedback" from the app, answered in the admin console.
const supportTicketSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  category: { type: String, enum: ["bug", "idea", "account", "other"], required: true },
  // open: waiting for us · answered: waiting for them · closed
  status: { type: String, enum: ["open", "answered", "closed"], default: "open" },
  messages: {
    type: [
      {
        _id: false,
        from: { type: String, enum: ["user", "support"], required: true },
        text: { type: String, required: true },
        by: { type: String, default: null }, // admin e-mail
        at: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  // What the app told us when the ticket was opened
  app: { version: String, build: String, platform: String, os: String },
  // Has the user seen the latest support answer?
  unreadByUser: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

supportTicketSchema.index({ phone: 1, updatedAt: -1 });
supportTicketSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
