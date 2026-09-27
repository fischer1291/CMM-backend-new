/**
 * E-mail via SMTP (any provider: Brevo, Postmark, Amazon SES, Mailjet …).
 *
 *   SMTP_URL   e.g. smtps://user:pass@smtp-relay.brevo.com:465
 *   MAIL_FROM  e.g. "Wanna yap? <hallo@wannayap.app>"
 *
 * Without SMTP_URL nothing is sent (the admin console says so); in tests the
 * transport is faked (test/helpers.js).
 */
const nodemailer = require("nodemailer");

const DEFAULT_FROM = "Wanna yap? <hallo@wannayap.app>";
let transport = null;

const configured = () => !!process.env.SMTP_URL || process.env.NODE_ENV === "test";

function transporter() {
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL || { jsonTransport: true });
  return transport;
}

/**
 * Send one mail. `unsubscribe` (an https URL) adds the List-Unsubscribe
 * headers with one-click unsubscribe (RFC 8058), which Gmail and Yahoo
 * require for bulk mail.
 */
async function sendMail({ to, subject, text, html, unsubscribe }) {
  if (!configured()) throw new Error("mail_not_configured");
  const headers = unsubscribe
    ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return transporter().sendMail({ from: process.env.MAIL_FROM || DEFAULT_FROM, to, subject, text, html, headers });
}

module.exports = { sendMail, configured };
