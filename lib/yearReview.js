/**
 * "Dein Jahr in Gesprächen": a year (in the user's time zone) of talks,
 * people, rituals and moments. Everyone gets the headline numbers; the full
 * story (top people, longest talk, best moment, ...) is Wanna yap+.
 */
const Talk = require("../models/Talk");
const User = require("../models/User");
const CallMoment = require("../models/CallMoment");
const DailyMoment = require("../models/DailyMoment");
const MomentUnlock = require("../models/MomentUnlock");
const { localParts, weekKey, shiftDateKey } = require("./localTime");
const { badgesOf } = require("./badges");

const DAY_MS = 24 * 3600 * 1000;
const minutes = (s) => Math.round(s / 60);

/** Longest run of consecutive weeks (Monday keys) in a set. */
function bestWeekRun(weeks) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const w of [...weeks].sort()) {
    run = prev && shiftDateKey(prev, 7) === w ? run + 1 : 1;
    best = Math.max(best, run);
    prev = w;
  }
  return best;
}

async function yearReview(user, year, { full }) {
  const phone = user.phone;
  const tz = user.timezone || user.schedule?.timezone;
  const inYear = (date) => localParts(date, tz).dateKey.startsWith(`${year}-`);
  // Generous window, then exact by local date
  const from = new Date(Date.UTC(year, 0, 1) - DAY_MS);
  const to = new Date(Date.UTC(year + 1, 0, 1) + DAY_MS);

  const talks = (
    await Talk.find({
      startedAt: { $gte: from, $lt: to },
      $or: [{ group: { $ne: true }, participants: phone }, { group: true, owner: phone }],
    })
      .sort({ startedAt: 1 })
      .lean()
  ).filter((t) => inYear(t.startedAt));

  const perPerson = new Map();
  const perMonth = new Array(12).fill(0);
  const weeks = new Set();
  let seconds = 0;
  let calls = 0;
  let rounds = 0;
  let roundSeconds = 0;
  let longest = null;
  for (const t of talks) {
    seconds += t.seconds;
    perMonth[Number(localParts(t.startedAt, tz).dateKey.slice(5, 7)) - 1] += t.seconds;
    weeks.add(weekKey(t.startedAt, tz));
    const others = t.participants.filter((p) => p !== phone);
    if (t.group) {
      rounds++;
      roundSeconds += t.seconds;
    } else {
      calls++;
      if (!longest || t.seconds > longest.seconds) longest = { seconds: t.seconds, with: others[0] || null, at: t.startedAt };
    }
    for (const other of others) {
      const p = perPerson.get(other) || { seconds: 0, talks: 0 };
      p.seconds += t.group ? Math.round(t.seconds / others.length) : t.seconds;
      p.talks++;
      perPerson.set(other, p);
    }
  }

  const summary = {
    year,
    minutes: minutes(seconds),
    talks: calls,
    people: perPerson.size,
    full,
  };
  if (!full) return summary;

  const top = [...perPerson.entries()].sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 3);
  const firstTalk = talks.find((t) => !t.group) || talks[0] || null;
  const names = await User.find(
    { phone: { $in: [...top.map(([p]) => p), longest?.with, firstTalk?.participants.find((p) => p !== phone)].filter(Boolean) } },
    { phone: 1, name: 1, avatarUrl: 1 },
  ).lean();
  const who = (p) => {
    const u = names.find((x) => x.phone === p);
    return p ? { phone: p, name: u?.name || null, avatarUrl: u?.avatarUrl || null } : null;
  };

  const [daily, unlocks, myMoments, bestMoment, badges] = await Promise.all([
    DailyMoment.countDocuments({ day: { $regex: `^${year}-` }, joined: phone }),
    MomentUnlock.countDocuments({ phone, day: { $regex: `^${year}-` } }),
    CallMoment.find({ userPhone: phone, status: { $ne: "pending" }, timestamp: { $gte: from, $lt: to } }, { timestamp: 1 }).lean(),
    CallMoment.findOne({
      $or: [{ userPhone: phone }, { targetPhone: phone }],
      status: { $ne: "pending" },
      hidden: { $ne: true },
      timestamp: { $gte: from, $lt: to },
    })
      .sort({ totalReactions: -1, timestamp: -1 })
      .lean(),
    badgesOf(user),
  ]);
  const busiest = perMonth.indexOf(Math.max(...perMonth));

  return {
    ...summary,
    topPeople: top.map(([p, v]) => ({ ...who(p), minutes: minutes(v.seconds), talks: v.talks })),
    longest: longest ? { minutes: minutes(longest.seconds), with: who(longest.with), at: longest.at } : null,
    busiestMonth: seconds ? { month: busiest + 1, minutes: minutes(perMonth[busiest]) } : null,
    firstTalk: firstTalk ? { at: firstTalk.startedAt, with: who(firstTalk.participants.find((p) => p !== phone)) } : null,
    bestWeekStreak: bestWeekRun(weeks),
    rounds,
    roundMinutes: minutes(roundSeconds),
    dailyJoins: daily,
    unlockDays: unlocks,
    moments: myMoments.filter((m) => inYear(m.timestamp)).length,
    bestMoment:
      bestMoment && inYear(bestMoment.timestamp)
        ? {
            id: String(bestMoment._id),
            screenshot: bestMoment.screenshot,
            note: bestMoment.note || "",
            reactions: bestMoment.totalReactions || 0,
            with: who(bestMoment.userPhone === phone ? bestMoment.targetPhone : bestMoment.userPhone),
            at: bestMoment.timestamp,
          }
        : null,
    badges: badges.filter((b) => b.earned).length,
  };
}

module.exports = { yearReview, bestWeekRun };
