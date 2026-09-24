/**
 * Calendar helpers in a user's time zone (IANA name, e.g. "Europe/Berlin").
 * Node ships full ICU, so Intl handles zones and DST.
 */
const DEFAULT_TIMEZONE = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map();
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  return formatters.get(timeZone);
}

function isValidTimezone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

const zoneOr = (timeZone) => (isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE);

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Local calendar parts of `date` in `timeZone`:
 * { dateKey: "YYYY-MM-DD", day: 0 (Sun)..6, minutes: minutes since local midnight }
 */
function localParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(zoneOr(timeZone)).formatToParts(date)) {
    parts[type] = value;
  }
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    day: WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Monday (as "YYYY-MM-DD") of the local week that contains `date`. */
function weekKey(date, timeZone) {
  const { dateKey, day } = localParts(date, timeZone);
  const sinceMonday = (day + 6) % 7;
  return shiftDateKey(dateKey, -sinceMonday);
}

/** "YYYY-MM-DD" plus `days` (calendar arithmetic, zone independent). */
function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

module.exports = { DEFAULT_TIMEZONE, isValidTimezone, zoneOr, localParts, weekKey, shiftDateKey };
