/**
 * Personal talk-time stats: how much time a user spent in real
 * conversations, computed from Talk records in the user's time zone.
 *
 * Deliberately gentle: streaks count *weeks* with at least one conversation
 * (a busy Tuesday doesn't break anything), and the per-person breakdown is
 * never shared with anyone else.
 */
const Talk = require("../models/Talk");
const CallMoment = require("../models/CallMoment");
const { localParts, weekKey, shiftDateKey } = require("./localTime");

const WEEKS_SHOWN = 8;

const BADGES = [
  { id: "first_talk", title: "Erstes Gespräch", description: "Dein erstes echtes Gespräch", target: 1, metric: "talks" },
  { id: "deep_talk", title: "Tiefgang", description: "Ein Gespräch über 30 Minuten", target: 30 * 60, metric: "longest" },
  { id: "hour", title: "Eine Stunde", description: "60 Minuten Gesprächszeit", target: 60 * 60, metric: "seconds" },
  { id: "ten_talks", title: "Zehn Gespräche", description: "10 Gespräche geführt", target: 10, metric: "talks" },
  { id: "streak_4", title: "Dranbleiber", description: "4 Wochen in Folge gesprochen", target: 4, metric: "bestStreak" },
  { id: "circle", title: "Dein Kreis", description: "Mit 5 verschiedenen Menschen gesprochen", target: 5, metric: "people" },
  { id: "ten_hours", title: "Zehn Stunden", description: "10 Stunden Gesprächszeit", target: 10 * 60 * 60, metric: "seconds" },
  { id: "planner", title: "Planer", description: "Einen Zeitplan eingerichtet", target: 1, metric: "planner" },
  { id: "storyteller", title: "Erzähler", description: "Einen Moment geteilt", target: 1, metric: "moments" },
];

/** Consecutive weeks with talks, ending this week (or last week, so a streak survives until Sunday). */
function currentStreak(weeks, thisWeek) {
  let week = weeks.has(thisWeek) ? thisWeek : shiftDateKey(thisWeek, -7);
  let streak = 0;
  while (weeks.has(week)) {
    streak++;
    week = shiftDateKey(week, -7);
  }
  return streak;
}

function bestStreak(weeks) {
  let best = 0;
  for (const week of weeks) {
    if (weeks.has(shiftDateKey(week, -7))) continue; // not the start of a run
    let length = 0;
    for (let w = week; weeks.has(w); w = shiftDateKey(w, 7)) length++;
    best = Math.max(best, length);
  }
  return best;
}

/**
 * Stats for `user` (needs phone, schedule, and optionally schedule.timezone).
 * `timezone` overrides the stored one (the app sends the device's zone).
 */
async function statsFor(user, { timezone, now = new Date() } = {}) {
  const tz = timezone || user.schedule?.timezone;
  const phone = user.phone;
  const [talks, moments] = await Promise.all([
    Talk.find({ participants: phone }).sort({ startedAt: -1 }).lean(),
    CallMoment.countDocuments({ userPhone: phone }),
  ]);

  const thisWeek = weekKey(now, tz);
  const thisMonth = localParts(now, tz).dateKey.slice(0, 7);
  const weekSeconds = new Map();
  const people = new Map();
  let seconds = 0;
  let monthSeconds = 0;
  let longest = 0;

  for (const talk of talks) {
    seconds += talk.seconds;
    longest = Math.max(longest, talk.seconds);
    const week = weekKey(talk.startedAt, tz);
    weekSeconds.set(week, (weekSeconds.get(week) || 0) + talk.seconds);
    if (localParts(talk.startedAt, tz).dateKey.startsWith(thisMonth)) monthSeconds += talk.seconds;

    const other = talk.participants.find((p) => p !== phone);
    if (other) {
      const entry = people.get(other) || { phone: other, seconds: 0, talks: 0, lastTalkAt: talk.startedAt };
      entry.seconds += talk.seconds;
      entry.talks += 1;
      people.set(other, entry);
    }
  }

  const weekSet = new Set(weekSeconds.keys());
  const metrics = {
    talks: talks.length,
    seconds,
    longest,
    people: people.size,
    bestStreak: bestStreak(weekSet),
    planner: user.schedule?.enabled && user.schedule.slots?.length ? 1 : 0,
    moments,
  };

  const weeks = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
    const week = shiftDateKey(thisWeek, -7 * i);
    weeks.push({ week, seconds: weekSeconds.get(week) || 0 });
  }

  return {
    totals: {
      weekSeconds: weekSeconds.get(thisWeek) || 0,
      lastWeekSeconds: weekSeconds.get(shiftDateKey(thisWeek, -7)) || 0,
      monthSeconds,
      allTimeSeconds: seconds,
      talks: talks.length,
      longestSeconds: longest,
    },
    weeks,
    streak: { current: currentStreak(weekSet, thisWeek), best: metrics.bestStreak },
    badges: BADGES.map(({ metric, target, ...badge }) => ({
      ...badge,
      earned: metrics[metric] >= target,
      progress: Math.min(metrics[metric] / target, 1),
    })),
    people: [...people.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 10),
  };
}

/** What others may see: no per-person breakdown, no history of whom you talk to. */
function sharedView(stats) {
  return {
    totals: {
      weekSeconds: stats.totals.weekSeconds,
      monthSeconds: stats.totals.monthSeconds,
      allTimeSeconds: stats.totals.allTimeSeconds,
    },
    streak: stats.streak,
    badges: stats.badges.filter((b) => b.earned).map(({ id, title, description }) => ({ id, title, description })),
  };
}

/** May `viewer` see `owner`'s shared stats? */
function canView(owner, viewer) {
  const { visibility = "private", sharedWith = [] } = owner.statsSharing || {};
  if (visibility === "contacts") return owner.contacts.includes(viewer);
  if (visibility === "selected") return sharedWith.includes(viewer) && owner.contacts.includes(viewer);
  return false;
}

module.exports = { statsFor, sharedView, canView, BADGES };
