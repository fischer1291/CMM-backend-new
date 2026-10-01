/**
 * Reset an admin's second factor when the authenticator is gone (a lost phone
 * and no second owner to invite them again): node scripts/reset-admin-totp.js
 * <email>, on Render in the service's Shell. Switches TOTP off, draws a new
 * secret, signs out every session and prints a one-time setup link (7 days),
 * which runs through the console's normal invitation flow: new password, scan
 * the new secret, confirm with a code. Passkeys and settings stay.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const { newTotpSecret, newInviteToken, hashInviteToken, inviteExpiry, INVITE_DAYS } = require("../lib/adminAuth");

async function main() {
  const email = String(process.argv[2] || "").toLowerCase().trim();
  if (!email) {
    console.error("Usage: node scripts/reset-admin-totp.js <email>");
    process.exit(2);
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set");
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const admin = await Admin.findOne({ email });
  if (!admin) {
    console.error(`No admin with the address ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const token = newInviteToken();
  admin.totpEnabled = false;
  admin.totpSecret = newTotpSecret();
  admin.sessionVersion += 1;
  admin.failedLogins = 0;
  admin.lockedUntil = null;
  admin.inviteTokenHash = hashInviteToken(token);
  admin.inviteExpiresAt = inviteExpiry();
  admin.invitedBy = "reset-admin-totp";
  await admin.save();
  const base = (process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "");
  console.log(`TOTP reset for ${admin.email} (${admin.role}); every session is signed out.`);
  console.log(`Set up again within ${INVITE_DAYS} days (new password, new authenticator entry):`);
  console.log(`${base}/console/#setup/${token}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
