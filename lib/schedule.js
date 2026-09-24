/**
 * Weekly availability schedules: "Mondays 18:00–20:00 I'm available".
 *
 * A job (see index.js) checks every minute. When a slot starts, the user
 * becomes available until the slot ends; the existing moment expiry job
 * ends it. Each slot occurrence is applied once (lastScheduleSlotKey), so
 * going offline by hand during a slot sticks.
 */
const User = require("../models/User");
const { isValidTimezone, localParts } = require("./localTime");

const MAX_SLOTS = 21;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Validates { enabled, timezone, slots: [{ day, start, end }] } where day is
 * 0 (Sunday)..6 and start/end are minutes since midnight (end > start).
 * Returns { value } or { error }.
 */
function parseSchedule(body) {
  if (!body || typeof body !== "object") return { error: "Invalid schedule" };
  const { enabled, timezone, slots } = body;
  if (typeof enabled !== "boolean") return { error: "enabled must be a boolean" };
  if (!isValidTimezone(timezone)) return { error: "Invalid timezone" };
  if (!Array.isArray(slots) || slots.length > MAX_SLOTS) {
    return { error: `slots: at most ${MAX_SLOTS}` };
  }

  const clean = [];
  for (const slot of slots) {
    const day = Number(slot?.day);
    const start = Number(slot?.start);
    const end = Number(slot?.end);
    const valid =
      Number.isInteger(day) && day >= 0 && day <= 6 &&
      Number.isInteger(start) && Number.isInteger(end) &&
      start >= 0 && end <= MINUTES_PER_DAY && end - start >= 15;
    if (!valid) return { error: "Invalid slot" };
    clean.push({ day, start, end });
  }

  // Overlapping slots on the same day would apply twice
  clean.sort((a, b) => a.day - b.day || a.start - b.start);
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].day === clean[i - 1].day && clean[i].start < clean[i - 1].end) {
      return { error: "Slots overlap" };
    }
  }
  return { value: { enabled, timezone, slots: clean } };
}

/** The slot active at `now` for this schedule, with its key and end time; or null. */
function activeSlot(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule.slots?.length) return null;
  const { dateKey, day, minutes } = localParts(now, schedule.timezone);
  const slot = schedule.slots.find((s) => s.day === day && s.start <= minutes && minutes < s.end);
  if (!slot) return null;
  return {
    key: `${dateKey}|${slot.start}`,
    endsAt: new Date(now.getTime() + (slot.end - minutes) * 60 * 1000),
  };
}

/** Next slot start after `now` (within a week), as { day, start } or null. */
function nextSlot(schedule, now = new Date()) {
  if (!schedule?.enabled || !schedule.slots?.length) return null;
  const { day, minutes } = localParts(now, schedule.timezone);
  let best = null;
  for (const slot of schedule.slots) {
    let offset = ((slot.day - day + 7) % 7) * MINUTES_PER_DAY + slot.start - minutes;
    if (offset <= 0) offset += 7 * MINUTES_PER_DAY;
    if (!best || offset < best.offset) best = { offset, slot };
  }
  return { day: best.slot.day, start: best.slot.start, end: best.slot.end, inMinutes: best.offset };
}

/** Make users available whose slot just started. Returns how many changed. */
async function applySchedules(onAvailable, now = new Date()) {
  const users = await User.find({ "schedule.enabled": true, "schedule.slots.0": { $exists: true } });
  let changed = 0;
  for (const user of users) {
    const slot = activeSlot(user.schedule, now);
    if (!slot || slot.key === user.lastScheduleSlotKey) continue;

    const wasAvailable = user.isAvailable;
    user.lastScheduleSlotKey = slot.key;
    if (!wasAvailable) {
      user.isAvailable = true;
      user.availableSource = "schedule";
      user.lastOnline = now;
      user.momentActiveUntil = slot.endsAt;
    } else if (user.momentActiveUntil && user.momentActiveUntil < slot.endsAt) {
      // A running session is stretched to the slot; open-ended availability stays
      user.momentActiveUntil = slot.endsAt;
    }
    await user.save();
    if (!wasAvailable) {
      changed++;
      await onAvailable(user);
    }
  }
  return changed;
}

module.exports = { parseSchedule, activeSlot, nextSlot, applySchedules, MAX_SLOTS };
