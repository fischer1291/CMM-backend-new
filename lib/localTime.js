/**
 * Calendar helpers in a user's time zone (IANA name, e.g. "Europe/Berlin"),
 * and ISO week labels ("2026-W40") for the weekly report (lib/weeklyReport.js).
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

/**
 * ISO 8601 week of the week that starts on `monday` ("YYYY-MM-DD"), as
 * "YYYY-Www" (e.g. "2026-W40"): the week belongs to the year of its Thursday.
 */
function isoWeek(monday) {
  const thursday = shiftDateKey(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const dayOfYear = Math.round((Date.parse(`${thursday}T00:00:00Z`) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  return `${year}-W${String(Math.floor((dayOfYear - 1) / 7) + 1).padStart(2, "0")}`;
}

/** Monday ("YYYY-MM-DD") of an ISO week "YYYY-Www", or null when there is no such week. */
function mondayOfIsoWeek(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(label || ""));
  if (!m) return null;
  const [year, week] = [Number(m[1]), Number(m[2])];
  if (week < 1 || week > 53) return null;
  // 4 January always lies in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = shiftDateKey(jan4.toISOString().slice(0, 10), -((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  // Week 53 exists only in some years
  return isoWeek(monday) === label ? monday : null;
}

module.exports = { DEFAULT_TIMEZONE, isValidTimezone, zoneOr, localParts, weekKey, shiftDateKey, isoWeek, mondayOfIsoWeek };
