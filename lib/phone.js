const { parsePhoneNumberFromString } = require("libphonenumber-js");

const FALLBACK_REGION = "DE";

/**
 * Region to use for numbers without a country code: the country of the
 * requesting user's own number (a German user's "0171..." contact is German).
 */
function regionOf(e164) {
  if (!e164) return FALLBACK_REGION;
  const parsed = parsePhoneNumberFromString(e164);
  return (parsed && parsed.country) || FALLBACK_REGION;
}

/**
 * Normalize a phone number to E.164 ("+491711234567").
 * Returns null when the input is not a plausible phone number.
 *
 * `preferInternational`: treat digits without "+" or leading 0 as already
 * containing a country code. Right for numbers the app itself sent (older
 * versions strip the "+" from the user's E.164 number); wrong for address
 * book entries, where "491..." can be a valid German national number.
 */
function normalizePhone(input, defaultRegion = FALLBACK_REGION, { preferInternational = false } = {}) {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/^00/, "+");
  if (!cleaned) return null;

  const international = /^[1-9]\d{7,14}$/.test(cleaned)
    ? parsePhoneNumberFromString(`+${cleaned}`)
    : null;
  if (preferInternational && international && international.isValid()) {
    return international.number;
  }

  const parsed = parsePhoneNumberFromString(cleaned, defaultRegion);
  if (parsed && parsed.isValid()) return parsed.number;
  if (international && international.isValid()) return international.number;
  return parsed && parsed.isPossible() ? parsed.number : null;
}

module.exports = { normalizePhone, regionOf };
