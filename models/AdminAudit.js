const mongoose = require("mongoose");

// Every admin action and every look at a person's data. Kept one year.
const adminAuditSchema = new mongoose.Schema({
  admin: { type: String, required: true }, // e-mail at the time
  action: { type: String, required: true }, // e.g. "login", "GET /admin/metrics"
  target: { type: String, default: null }, // e.g. a user's phone
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: null },
  at: { type: Date, default: Date.now },
});

adminAuditSchema.index({ at: -1 });
adminAuditSchema.index({ target: 1, at: -1 });
adminAuditSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

module.exports = mongoose.model("AdminAudit", adminAuditSchema);
