const mongoose = require("mongoose");

// "Hilfe & Feedback" from the app, answered in the admin console. Plan 2.7
// adds two kinds: "report", a report from someone without an account
// (POST /reports/public, routes/support.js; phone null, contact by the
// optional e-mail), and "moderation", the statement of reasons (DSA Art. 17)
// that lib/moderation.js opens for the affected person when support
// suspends them or hides or deletes one of their moments; they object by
// answering in it.
const REPORT_CATEGORIES = ["harassment", "illegal", "spam", "other"];
const supportTicketSchema = new mongoose.Schema({
  // Only a public report has none
  phone: { type: String, default: null, required: [function () { return this.category !== "report"; }, "phone required"] },
  category: { type: String, enum: ["bug", "idea", "account", "other", "report", "moderation"], required: true },
  // open: waiting for us · answered: waiting for them · closed
  status: { type: String, enum: ["open", "answered", "closed"], default: "open" },
  messages: {
    type: [
      {
        _id: false,
        from: { type: String, enum: ["user", "support"], required: true },
        text: { type: String, required: true },
        by: { type: String, default: null }, // admin e-mail, or "auto" for the outage answer (routes/support.js)
        at: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  // What the app told us when the ticket was opened
  app: { version: String, build: String, platform: String, os: String },
  // Has the user seen the latest support answer?
  unreadByUser: { type: Boolean, default: false },
  // Public report (category "report"): what it is about, the number of the
  // reported person as typed in (normalized), a hint which moment, and the
  // reporter's e-mail for questions, each optional. Subdocuments without a
  // default, so the other kinds of ticket carry neither block
  report: {
    type: new mongoose.Schema(
      {
        category: { type: String, enum: [...REPORT_CATEGORIES, null], default: null },
        reportedPhone: { type: String, default: null },
        momentHint: { type: String, default: null },
      },
      { _id: false },
    ),
    default: undefined,
  },
  email: { type: String, default: null },
  // Statement of reasons (category "moderation"): the measure and its end
  moderation: {
    type: new mongoose.Schema(
      {
        action: { type: String, enum: ["suspend", "hide_moment", "delete_moment", null], default: null },
        until: { type: Date, default: null },
      },
      { _id: false },
    ),
    default: undefined,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

supportTicketSchema.index({ phone: 1, updatedAt: -1 });
supportTicketSchema.index({ status: 1, updatedAt: -1 });
supportTicketSchema.index({ "report.reportedPhone": 1 }, { partialFilterExpression: { category: "report" } });
// Public reports are kept half a year, like in-app reports (models/Report.js)
supportTicketSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600, partialFilterExpression: { category: "report" } });

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
module.exports = Object.assign(SupportTicket, { REPORT_CATEGORIES });
