/**
 * The one Twilio client: sign-up codes go through Verify (routes/verify.js),
 * alerts go as plain SMS to the owner's phone (lib/alerts.js). The sender of
 * those is TWILIO_SMS_FROM (a Twilio number or a Messaging Service SID);
 * without it no alert SMS goes out. Tests fake the module (test/helpers.js).
 */
const twilio = require("twilio");

let instance = null;
function client() {
  if (!instance) instance = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return instance;
}

const smsConfigured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM);

/** One plain SMS (not a verification code). Throws when Twilio refuses. */
async function sendSms(to, body) {
  if (!smsConfigured()) throw new Error("sms_not_configured");
  const from = process.env.TWILIO_SMS_FROM;
  const sender = /^MG[0-9a-f]{32}$/i.test(from) ? { messagingServiceSid: from } : { from };
  return client().messages.create({ to, body: String(body).slice(0, 320), ...sender });
}

module.exports = { client, sendSms, smsConfigured };
