const mongoose = require("mongoose");

// Leases for work only one instance may do (lib/leader.js).
const lockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

module.exports = mongoose.model("Lock", lockSchema);
