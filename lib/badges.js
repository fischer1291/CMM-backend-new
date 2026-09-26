/**
 * The badge album. Badges celebrate connection, never screen time: every
 * metric comes from real conversations (Talk records), shared moments,
 * circles and rituals. No leaderboards: badges are yours, your
 * friendship's, or your circle's.
 *
 * A badge has 1 or 3 tiers (Bronze, Silber, Gold). Secret badges show as
 * "?" until earned.
 */
const Talk = require("../models/Talk");
const CallMoment = require("../models/CallMoment");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const DailyMoment = require("../models/DailyMoment");
const MomentUnlock = require("../models/MomentUnlock");
const { localParts, weekKey, shiftDateKey } = require("./localTime");
const { regionOf } = require("./phone");

const DAY_MS = 24 * 3600 * 1000;
const HOUR_S = 3600;

const n = (v) => String(v);
const hours = (seconds) => `${Math.round(seconds / HOUR_S)}`;

/** Personal badges. `text(target)` describes what a tier needs. */
const CATALOG = [
  // Verbindung
  { id: "first_talk", category: "connection", icon: "chatbubbles", title: "Erstes Gespräch", metric: "talks", tiers: [1], text: () => "Dein erstes echtes Gespräch" },
  { id: "talks", category: "connection", icon: "call", title: "Gesprächig", metric: "talks", tiers: [10, 50, 150], text: (t) => `${n(t)} Gespräche geführt` },
  { id: "people", category: "connection", icon: "people", title: "Dein Kreis", metric: "people", tiers: [5, 15, 30], text: (t) => `Mit ${n(t)} verschiedenen Menschen gesprochen` },
  { id: "reunion", category: "connection", icon: "refresh-circle", title: "Wiedersehen", metric: "reunions", tiers: [1, 5, 15], text: (t) => (t === 1 ? "Mit jemandem gesprochen, von dem du über 30 Tage nichts gehört hattest" : `${n(t)}× ein Wiedersehen nach über 30 Tagen`) },
  { id: "bridge", category: "connection", icon: "git-merge", title: "Brückenbauer", metric: "invitesJoined", tiers: [1, 5, 15], text: (t) => (t === 1 ? "Jemand ist über deine Einladung dazugekommen" : `${n(t)} Menschen sind über deine Einladung dazugekommen`) },
  // Tiefe
  { id: "deep_talk", category: "depth", icon: "water", title: "Tiefgang", metric: "longest", tiers: [30 * 60], text: () => "Ein Gespräch über 30 Minuten" },
  { id: "marathon", category: "depth", icon: "infinite", title: "Marathon", metric: "longest", tiers: [90 * 60], secret: true, text: () => "Ein Gespräch über 90 Minuten" },
  { id: "hours", category: "depth", icon: "time", title: "Zeit geschenkt", metric: "seconds", tiers: [HOUR_S, 10 * HOUR_S, 50 * HOUR_S], text: (t) => (t === HOUR_S ? "Eine Stunde echte Gesprächszeit" : `${hours(t)} Stunden echte Gesprächszeit`) },
  // Rituale
  { id: "streak", category: "rituals", icon: "flame", title: "Dranbleiber", metric: "bestStreak", tiers: [4, 12, 26], text: (t) => `${n(t)} Wochen in Folge gesprochen` },
  { id: "planner", category: "rituals", icon: "calendar", title: "Planer", metric: "planner", tiers: [1], text: () => "Einen Zeitplan eingerichtet" },
  { id: "daily", category: "rituals", icon: "flash", title: "Momentjäger", metric: "dailyJoins", tiers: [1, 10, 50], text: (t) => (t === 1 ? "Beim Yap Moment dabei gewesen" : `${n(t)}× beim Yap Moment dabei`) },
  { id: "curious", category: "rituals", icon: "eye", title: "Neugierig", metric: "unlockDays", tiers: [1], text: () => "Zum ersten Mal die Moments des Tages freigeschaltet" },
  { id: "unlocker", category: "rituals", icon: "lock-open", title: "Immer dabei", metric: "unlockDays", tiers: [7, 30, 100], text: (t) => `An ${n(t)} Tagen die Moments freigeschaltet` },
  { id: "blitz", category: "rituals", icon: "rocket", title: "Blitzstart", metric: "blitz", tiers: [1], secret: true, text: () => "In der ersten Minute beim Yap Moment dabei" },
  // Kreise
  { id: "founder", category: "circles", icon: "home", title: "Gründer", metric: "circlesFounded", tiers: [1], text: () => "Einen Kreis gegründet" },
  { id: "host", category: "circles", icon: "mic", title: "Gastgeber", metric: "roomsStarted", tiers: [1, 10, 30], text: (t) => (t === 1 ? "Eine Runde gestartet" : `${n(t)} Runden gestartet`) },
  { id: "together", category: "circles", icon: "heart-circle", title: "Zusammenhalt", metric: "circleGoalWeeks", tiers: [1, 4, 12], text: (t) => (t === 1 ? "Mit einem Kreis das Wochenziel erreicht" : `${n(t)} Wochen das Wochenziel eines Kreises erreicht`) },
  { id: "full_house", category: "circles", icon: "grid", title: "Volles Haus", metric: "bigRoom", tiers: [1], secret: true, text: () => "In einer Runde mit 4 oder mehr Menschen" },
  // Entdecken
  { id: "storyteller", category: "discover", icon: "sparkles", title: "Erzähler", metric: "moments", tiers: [1, 10, 30], text: (t) => (t === 1 ? "Einen Moment geteilt" : `${n(t)} Momente geteilt`) },
  { id: "supporter", category: "discover", icon: "heart", title: "Unterstützer", metric: "supporter", tiers: [1], text: () => "Wanna yap+ unterstützt" },
  { id: "night_owl", category: "discover", icon: "moon", title: "Nachteule", metric: "nightTalks", tiers: [1], secret: true, text: () => "Ein Gespräch nach 23 Uhr" },
  { id: "early_bird", category: "discover", icon: "sunny", title: "Frühaufsteher", metric: "earlyTalks", tiers: [1], secret: true, text: () => "Ein Gespräch vor 7 Uhr morgens" },
  { id: "long_distance", category: "discover", icon: "airplane", title: "Langstrecke", metric: "abroadTalks", tiers: [1], secret: true, text: () => "Ein Gespräch über Ländergrenzen hinweg" },
  { id: "advent", category: "discover", icon: "snow", title: "Advents-Anrufer", metric: "adventTalks", tiers: [1], secret: true, text: () => "Im Advent miteinander gesprochen" },
  { id: "new_year", category: "discover", icon: "wine", title: "Neujahrsgruß", metric: "newYearTalks", tiers: [1], secret: true, text: () => "Am 1. Januar angerufen" },
];

const CATEGORIES = [
  { id: "connection", title: "Verbindung" },
  { id: "depth", title: "Tiefe" },
  { id: "rituals", title: "Rituale" },
  { id: "circles", title: "Kreise" },
  { id: "discover", title: "Entdecken" },
];

const TIER_NAMES = ["Bronze", "Silber", "Gold"];

/** A badge's state for a metric value. */
function evaluate(badge, value) {
  const tier = badge.tiers.filter((t) => value >= t).length;
  const maxed = tier === badge.tiers.length;
  const next = maxed ? null : badge.tiers[tier];
  const previous = tier ? badge.tiers[tier - 1] : 0;
  const progress = maxed ? 1 : Math.max(0, Math.min(1, (value - previous) / (next - previous)));
  const hidden = badge.secret && tier === 0;
  return {
    id: badge.id,
    category: badge.category,
    icon: hidden ? "help" : badge.icon,
    title: hidden ? "Geheim" : badge.title,
    description: hidden ? "Ein Geheimnis. Vielleicht findest du es ganz nebenbei." : badge.text(next ?? badge.tiers[badge.tiers.length - 1]),
    secret: !!badge.secret,
    tier,
    tiers: badge.tiers.length,
    tierName: badge.tiers.length > 1 && tier ? TIER_NAMES[tier - 1] : null,
    earned: tier > 0,
    progress: hidden ? 0 : progress,
    current: hidden ? null : value,
    next: hidden ? null : next,
  };
}

/** 1:1 talks of `phone` and their own group-call records. */
const talksOf = (phone) =>
  Talk.find({ $or: [{ group: { $ne: true }, participants: phone }, { group: true, owner: phone }] })
    .sort({ startedAt: 1 })
    .lean();

function bestStreakOf(weeks) {
  let best = 0;
  for (const week of weeks) {
    if (weeks.has(shiftDateKey(week, -7))) continue;
    let length = 0;
    for (let w = week; weeks.has(w); w = shiftDateKey(w, 7)) length++;
    best = Math.max(best, length);
  }
  return best;
}

/** Everything the personal badges measure, for `user`. */
async function metricsOf(user) {
  const phone = user.phone;
  const tz = user.timezone || user.schedule?.timezone;
  const [talks, moments, dailyJoins, blitz, circlesFounded, roomsStarted, myCircles, unlockDays] = await Promise.all([
    talksOf(phone),
    CallMoment.countDocuments({ userPhone: phone, status: { $ne: "pending" } }),
    DailyMoment.countDocuments({ joined: phone }),
    DailyMoment.exists({ fast: phone }),
    Circle.countDocuments({ createdBy: phone }),
    Room.countDocuments({ startedBy: phone }),
    Circle.find({ "members.phone": phone }, "goalWeeks").lean(),
    MomentUnlock.countDocuments({ phone }),
  ]);

  const myRegion = regionOf(phone);
  const people = new Set();
  const lastTalkWith = new Map();
  const weeks = new Set();
  const m = { talks: talks.length, seconds: 0, longest: 0, reunions: 0, nightTalks: 0, earlyTalks: 0, abroadTalks: 0, adventTalks: 0, newYearTalks: 0, bigRoom: 0 };

  for (const t of talks) {
    m.seconds += t.seconds;
    m.longest = Math.max(m.longest, t.seconds);
    weeks.add(weekKey(t.startedAt, tz));
    const { minutes, dateKey } = localParts(t.startedAt, tz);
    if (minutes >= 23 * 60 || minutes < 4 * 60) m.nightTalks++;
    if (minutes >= 5 * 60 && minutes < 7 * 60) m.earlyTalks++;
    const monthDay = dateKey.slice(5);
    if (monthDay >= "12-01" && monthDay <= "12-24") m.adventTalks++;
    if (monthDay === "01-01") m.newYearTalks++;
    if (t.group && t.participants.length >= 4) m.bigRoom = 1;

    const others = t.participants.filter((p) => p !== phone);
    if (others.some((p) => regionOf(p) !== myRegion)) m.abroadTalks++;
    for (const other of others) {
      people.add(other);
      const last = lastTalkWith.get(other);
      if (last && t.startedAt - last >= 30 * DAY_MS) m.reunions++;
      lastTalkWith.set(other, t.startedAt);
    }
  }

  return {
    ...m,
    people: people.size,
    bestStreak: bestStreakOf(weeks),
    planner: user.schedule?.enabled && user.schedule.slots?.length ? 1 : 0,
    moments,
    dailyJoins,
    blitz: blitz ? 1 : 0,
    circlesFounded,
    roomsStarted,
    circleGoalWeeks: Math.max(0, ...myCircles.map((c) => (c.goalWeeks || []).length)),
    invitesJoined: user.invitesJoined || 0,
    unlockDays,
    supporter: user.plus?.since ? 1 : 0,
  };
}

/** All personal badges with their state. */
async function badgesOf(user) {
  const metrics = await metricsOf(user);
  return CATALOG.map((b) => evaluate(b, metrics[b.metric] || 0));
}

/** Badges earned (or tiered up) since the user last saw them. */
function newlyEarned(badges, seen) {
  if (!seen) return [];
  return badges.filter((b) => b.tier > (seen[b.id] || 0));
}

const seenState = (badges) => Object.fromEntries(badges.map((b) => [b.id, b.tier]));

/** The unearned, visible badge that's closest: "Noch 1 Gespräch bis …" */
function nextUp(badges) {
  const candidates = badges.filter((b) => !b.secret && b.next !== null && b.progress >= 0.5 && b.progress < 1);
  const best = candidates.sort((a, b) => b.progress - a.progress)[0];
  if (!best) return null;
  const remaining = best.next - best.current;
  const byMetric = {
    talks: remaining === 1 ? "Noch 1 Gespräch" : `Noch ${remaining} Gespräche`,
    seconds: `Noch ${Math.ceil(remaining / 60)} Min. Gesprächszeit`,
    bestStreak: remaining === 1 ? "Noch 1 Woche" : `Noch ${remaining} Wochen`,
    people: remaining === 1 ? "Noch 1 neuer Mensch" : `Noch ${remaining} neue Menschen`,
  };
  const metric = CATALOG.find((c) => c.id === best.id).metric;
  const tierName = best.tiers > 1 ? ` (${TIER_NAMES[best.tier]})` : "";
  return {
    id: best.id,
    icon: best.icon,
    title: best.title,
    progress: best.progress,
    hint: `${byMetric[metric] || "Fast geschafft"} bis ${best.title}${tierName}`,
  };
}

// --- Friendship and circle badges -------------------------------------------

const FRIENDSHIP = [
  { id: "f_talks", icon: "chatbubbles", title: "Viel zu erzählen", metric: "talks", tiers: [5, 25, 100], text: (t) => `${n(t)} Gespräche miteinander` },
  { id: "f_time", icon: "time", title: "Zeit füreinander", metric: "seconds", tiers: [HOUR_S, 10 * HOUR_S, 50 * HOUR_S], text: (t) => (t === HOUR_S ? "Eine Stunde miteinander gesprochen" : `${hours(t)} Stunden miteinander gesprochen`) },
  { id: "f_streak", icon: "flame", title: "Beständig", metric: "bestStreak", tiers: [4, 12], text: (t) => `${n(t)} Wochen in Folge miteinander gesprochen` },
  { id: "f_year", icon: "infinite", title: "Ein Jahr in Kontakt", metric: "days", tiers: [365], text: () => "Seit über einem Jahr sprecht ihr miteinander" },
];

/** What `a` and `b` built together (only these two see it). */
async function friendshipOf(a, b, tz, now = new Date()) {
  const talks = await Talk.find({
    $or: [
      { group: { $ne: true }, participants: { $all: [a, b] } },
      { group: true, owner: a, participants: b },
    ],
  })
    .sort({ startedAt: 1 })
    .lean();
  const weeks = new Set(talks.map((t) => weekKey(t.startedAt, tz)));
  const metrics = {
    talks: talks.length,
    seconds: talks.reduce((s, t) => s + t.seconds, 0),
    bestStreak: bestStreakOf(weeks),
    days: talks.length ? Math.floor((now - talks[0].startedAt) / DAY_MS) : 0,
  };
  return {
    together: { talks: metrics.talks, seconds: metrics.seconds, since: talks[0]?.startedAt ?? null },
    badges: FRIENDSHIP.map((f) => evaluate(f, metrics[f.metric])),
  };
}

const CIRCLE = [
  { id: "c_goal", icon: "heart-circle", title: "Zusammenhalt", metric: "goalWeeks", tiers: [1, 4, 12], text: (t) => (t === 1 ? "Eine Woche, in der alle miteinander gesprochen haben" : `${n(t)} Wochen, in denen alle miteinander gesprochen haben`) },
  { id: "c_rooms", icon: "mic", title: "Runde um Runde", metric: "rooms", tiers: [1, 10, 50], text: (t) => (t === 1 ? "Die erste gemeinsame Runde" : `${n(t)} gemeinsame Runden`) },
  { id: "c_ritual", icon: "repeat", title: "Ritual gelebt", metric: "rituals", tiers: [1, 4, 12], text: (t) => (t === 1 ? "Das Ritual zum ersten Mal gelebt" : `Das Ritual ${n(t)}× gelebt`) },
  { id: "c_all", icon: "people-circle", title: "Alle dabei", metric: "allIn", tiers: [1], text: () => "Eine Runde, in der alle dabei waren" },
];

/** Badges a circle earned together. */
async function circleBadgesOf(circle) {
  const rooms = await Room.find({ circleId: circle._id, "participants.1": { $exists: true } }, "startedBy participants").lean();
  const members = circle.members.length;
  const metrics = {
    goalWeeks: (circle.goalWeeks || []).length,
    rooms: rooms.length,
    rituals: rooms.filter((r) => r.startedBy === "ritual").length,
    allIn: members >= 2 && rooms.some((r) => new Set(r.participants.map((p) => p.phone)).size >= members) ? 1 : 0,
  };
  return CIRCLE.map((c) => evaluate(c, metrics[c.metric]));
}

module.exports = {
  CATALOG,
  CATEGORIES,
  TIER_NAMES,
  evaluate,
  metricsOf,
  badgesOf,
  newlyEarned,
  seenState,
  nextUp,
  friendshipOf,
  circleBadgesOf,
};
