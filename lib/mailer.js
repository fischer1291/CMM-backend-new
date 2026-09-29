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
// The last result on this instance, for the admin console
const state = { lastOkAt: null, lastError: null };

/** The provider's answer, without anything secret from SMTP_URL. */
function reason(err) {
  let text = [err.responseCode, err.response || err.message].filter(Boolean).join(" ");
  try {
    const url = new URL(process.env.SMTP_URL || "");
    for (const secret of [url.password, decodeURIComponent(url.password)].filter(Boolean)) text = text.split(secret).join("***");
  } catch {}
  return text.slice(0, 300);
}

async function sendMail({ to, subject, text, html, unsubscribe }) {
  if (!configured()) throw new Error("mail_not_configured");
  const headers = unsubscribe
    ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  try {
    const result = await transporter().sendMail({ from: process.env.MAIL_FROM || DEFAULT_FROM, to, subject, text, html, headers });
    state.lastOkAt = new Date();
    return result;
  } catch (err) {
    state.lastError = { at: new Date(), message: reason(err) };
    err.reason = state.lastError.message;
    throw err;
  }
}

/** Connect and sign in to the SMTP server without sending. Returns { ok } or { error }. */
async function check() {
  if (!configured()) return { error: "SMTP_URL fehlt auf Render." };
  try {
    if (transporter().verify) await transporter().verify();
    return { ok: true };
  } catch (err) {
    state.lastError = { at: new Date(), message: reason(err) };
    return { error: state.lastError.message };
  }
}

/** Where mail goes out and how it went lately (never the password). */
function status() {
  let server = null;
  try {
    const url = new URL(process.env.SMTP_URL || "");
    const user = decodeURIComponent(url.username || "");
    server = { host: url.hostname, port: url.port || (url.protocol === "smtps:" ? "465" : "587"), secure: url.protocol === "smtps:", user: user.length > 6 ? `${user.slice(0, 3)}…${user.slice(-3)}` : user ? "***" : "" };
  } catch {}
  return { configured: configured(), server, from: process.env.MAIL_FROM || DEFAULT_FROM, lastOkAt: state.lastOkAt, lastError: state.lastError };
}

module.exports = { sendMail, configured, check, status };
