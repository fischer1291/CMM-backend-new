/**
 * Where people come from (plan 2.10): the answer to "Woher kennst du Wanna
 * yap?" in onboarding (User.acquisition, POST /me/acquisition) and the
 * campaigns the owner registers in the console (models/Campaign.js,
 * routes/adminCampaigns.js) with their numbers per slug. First-party only:
 * no tracking SDK, no ATT prompt.
 *
 * Why the app cannot tell us the campaign: a /k/<slug> link goes through the
 * download page to the App Store with Apple's campaign token "ct"; Apple
 * reports it in App Store Connect (App Analytics → Campaigns), never to us,
 * and without a tracking SDK there is no deferred deep link that would carry
 * the slug through the install into the app. So the server names a campaign
 * only where it knows one itself: the redeemed waitlist entry
 * (WaitlistEntry.campaign, the landing page's utm_campaign) or the seed
 * campaign the owner marked (AppConfig.goals.seedCampaign) while it runs and
 * the answer fits its channel (CHANNEL_SOURCES, an assumption). Everything
 * else stays null: the console shows those people under their source only.
 */
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const User = require("../models/User");
const Campaign = require("../models/Campaign");
const WaitlistEntry = require("../models/WaitlistEntry");
const LandingVisit = require("../models/LandingVisit");
const MarketingSpend = require("../models/MarketingSpend");
const AdDraft = require("../models/AdDraft");
const { goalsConfig } = require("./appConfig");
const { localParts, shiftDateKey } = require("./localTime");

const { SLUG, CHANNELS, STATUSES } = Campaign;
// The answers the app offers, in its order ("Freund·in", TikTok, Instagram,
// Flyer, Presse, Sonstiges); "none" in the numbers means no answer
const SOURCES = ["friend", "tiktok", "instagram", "flyer", "press", "other"];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// A second answer within this time replaces the first (a slip in onboarding)
const ANSWER_WINDOW_MS = 24 * HOUR;
const MAX_ANDROID_FRIENDS = 5;
// Which answers count for a running seed campaign of a channel (ASSUMPTION:
// a campus seed grows through flyers and friends, a creator posts on TikTok
// or Instagram)
const CHANNEL_SOURCES = {
  tiktok: ["tiktok"],
  instagram: ["instagram"],
  flyer: ["flyer"],
  campus: ["flyer", "friend"],
  creator: ["tiktok", "instagram"],
  press: ["press"],
  other: ["other"],
};
// The console's numbers per slug look this far back
const NUMBERS_DAYS = 90;
const ZONE = "Europe/Berlin";
const MAX_UNREGISTERED = 50;
// 100,000 € in cents: more is a typo
const MAX_BUDGET_CENTS = 10_000_000;

const site = () => (process.env.SITE_URL || "https://wannayap.app").replace(/\/$/, "");
const idAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

/** A campaign slug from a stored utm tag (lowercased), or null when it is none. */
function slugOf(raw) {
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SLUG.test(slug) ? slug : null;
}

/** The answer as GET /me and POST /me/acquisition return it; null before one. */
function acquisitionOf(user) {
  const a = user?.acquisition;
  if (!a?.at) return null;
  return { source: a.source || null, androidFriends: a.androidFriends ?? null, campaign: a.campaign || null, code: a.code || null, at: a.at };
}

/** The invite code of the first inviter, for an account that joined through an invite. */
async function inviteCodeOf(user) {
  if (!user.joinedViaInvite || !user.invitedBy?.length) return null;
  const inviter = await User.findOne({ phone: user.invitedBy[0] }, { inviteCode: 1 }).lean();
  return inviter?.inviteCode || null;
}

const running = (c, now) => c.status === "running" && (!c.startedAt || c.startedAt <= now) && (!c.endedAt || c.endedAt > now);

/** The campaign the server knows for this account (see the head comment), or null. */
async function campaignOf(user, source, now = new Date()) {
  if (user.waitlist?.code) {
    const entry = await WaitlistEntry.findOne({ code: user.waitlist.code }, { campaign: 1 }).lean();
    const slug = slugOf(entry?.campaign);
    if (slug && !slug.startsWith("invite-")) return slug;
  }
  const seed = (await goalsConfig()).seedCampaign;
  if (!seed) return null;
  const campaign = await Campaign.findOne({ slug: seed }, { slug: 1, channel: 1, status: 1, startedAt: 1, endedAt: 1 }).lean();
  return campaign && running(campaign, now) && CHANNEL_SOURCES[campaign.channel]?.includes(source) ? campaign.slug : null;
}

/**
 * POST /me/acquisition: validate and store the answer. Returns
 * { acquisition } or { status, error }.
 */
async function answer(phone, body, now = new Date(), retry = true) {
  const source = body?.source;
  if (!SOURCES.includes(source)) return { status: 400, error: "invalid_source" };
  const androidFriends = body?.androidFriends ?? null;
  if (androidFriends !== null && !(Number.isInteger(androidFriends) && androidFriends >= 0 && androidFriends <= MAX_ANDROID_FRIENDS)) {
    return { status: 400, error: "invalid_android_friends" };
  }
  const user = await User.findOne({ phone }, { acquisition: 1, joinedViaInvite: 1, invitedBy: 1, waitlist: 1 }).lean();
  if (!user) return { status: 404, error: "User not found" };
  const first = user.acquisition?.at || null;
  if (first && now - first >= ANSWER_WINDOW_MS) return { status: 409, error: "already_answered" };
  const [code, campaign] = await Promise.all([inviteCodeOf(user), campaignOf(user, source, now)]);
  const acquisition = { source, androidFriends, campaign, code, at: first || now };
  // Conditional on the first answer seen above: two answers at once must not
  // both count as the first
  const res = await User.updateOne({ phone, "acquisition.at": first }, { $set: { acquisition } });
  if (!res.matchedCount) return retry ? answer(phone, body, now, false) : { status: 409, error: "already_answered" };
  return { acquisition };
}

/**
 * A waitlist code was redeemed after the answer: the entry's campaign fills
 * an empty acquisition.campaign (lib/waitlist.js redeem).
 */
async function noteWaitlistCampaign(phone, rawCampaign) {
  const slug = slugOf(rawCampaign);
  if (!slug || slug.startsWith("invite-")) return;
  await User.updateOne({ phone, "acquisition.at": { $ne: null }, "acquisition.campaign": null }, { $set: { "acquisition.campaign": slug } });
}

// --- Campaigns in the console ----------------------------------------------------

/** The links the console generates for a slug. */
function linksOf(slug, channel) {
  return {
    store: `${site()}/k/${slug}`,
    landing: `${site()}/?utm_source=${encodeURIComponent(channel || "other")}&utm_campaign=${encodeURIComponent(slug)}`,
  };
}

/** The store link as an SVG QR code (flyers, posters). */
const qrSvg = (slug) => QRCode.toString(`${site()}/k/${slug}`, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
function dateOf(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
const text = (value, max) => (typeof value === "string" && value.trim().length <= max ? value.trim() : undefined);

/**
 * The fields of a campaign to store from the console's body, or { error }.
 * `existing` is the stored campaign on an update (its slug never changes).
 */
function validCampaign(body, existing = null) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  if (!existing) {
    const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
    if (!SLUG.test(slug)) return { error: "invalid_slug" };
    out.slug = slug;
    if (!("channel" in input)) return { error: "invalid_channel" };
  }
  if ("channel" in input) {
    if (!CHANNELS.includes(input.channel)) return { error: "invalid_channel" };
    out.channel = input.channel;
  }
  if ("status" in input) {
    if (!STATUSES.includes(input.status)) return { error: "invalid_status" };
    out.status = input.status;
  }
  for (const [key, max] of [["title", 80], ["partner", 80], ["notes", 1000]]) {
    if (!(key in input)) continue;
    const value = input[key] == null ? "" : text(input[key], max);
    if (value === undefined) return { error: `invalid_${key}` };
    out[key] = value;
  }
  for (const key of ["startedAt", "endedAt"]) {
    if (!(key in input)) continue;
    const value = dateOf(input[key]);
    if (value === undefined) return { error: "invalid_dates" };
    out[key] = value;
  }
  const startedAt = "startedAt" in out ? out.startedAt : existing?.startedAt || null;
  const endedAt = "endedAt" in out ? out.endedAt : existing?.endedAt || null;
  if (startedAt && endedAt && endedAt < startedAt) return { error: "invalid_dates" };
  if ("budgetEurCents" in input) {
    const v = input.budgetEurCents;
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= MAX_BUDGET_CENTS)) return { error: "invalid_budget" };
    out.budgetEurCents = v;
  }
  return { fields: out };
}

const STATUS_ORDER = { running: 0, planned: 1, ended: 2 };
const plain = (c) => ({
  id: String(c._id),
  slug: c.slug,
  channel: c.channel,
  title: c.title || "",
  startedAt: c.startedAt || null,
  endedAt: c.endedAt || null,
  budgetEurCents: c.budgetEurCents ?? null,
  partner: c.partner || "",
  status: c.status,
  notes: c.notes || "",
  createdBy: c.createdBy || null,
  createdAt: c.createdAt || null,
  updatedAt: c.updatedAt || null,
});

/**
 * New users per campaign slug (User.acquisition.campaign) created since
 * `since`, and how many of them had their first talk within ACTIVATION_DAYS
 * of signing up (User.milestones.firstTalkAt): Map slug → { users,
 * activatedD7 }. `slugs` limits it to those (the marketing agent's videos,
 * lib/marketing.js context(), plan 2.14); without it every slug.
 */
async function peopleBySlug(since, slugs = null) {
  const { ACTIVATION_DAYS } = require("./metrics");
  const users = await User.find(
    { _id: { $gte: idAt(since) }, "acquisition.campaign": slugs ? { $in: slugs } : { $nin: [null, ""] } },
    { "acquisition.campaign": 1, "milestones.firstTalkAt": 1 },
  ).lean();
  const window = ACTIVATION_DAYS * DAY;
  const people = new Map();
  for (const u of users) {
    const slug = u.acquisition.campaign;
    const row = people.get(slug) || { users: 0, activatedD7: 0 };
    row.users++;
    const at = u._id.getTimestamp().getTime();
    const talk = u.milestones?.firstTalkAt;
    if (talk && talk.getTime() - at < window) row.activatedD7++;
    people.set(slug, row);
  }
  return people;
}

/**
 * GET /admin/campaigns: every campaign with its numbers of the last
 * NUMBERS_DAYS days, and the slugs seen in that time that nobody
 * registered. visits and storeClicks from LandingVisit (utm_campaign),
 * waitlist from confirmed WaitlistEntry, users and activatedD7 (first talk
 * within 7 days of signing up, User.milestones.firstTalkAt) from
 * User.acquisition.campaign of the accounts created in that time,
 * spendEurCents from MarketingSpend (settled: the real cost, reserved: the
 * estimate, released: nothing). Invite links ("invite-CODE") and the
 * marketing agent's own video campaigns (AdDraft, tab Freigabe) are not
 * listed as unregistered.
 */
async function campaignNumbers(now = new Date()) {
  const firstDay = shiftDateKey(localParts(now, ZONE).dateKey, -(NUMBERS_DAYS - 1));
  const since = new Date(now.getTime() - NUMBERS_DAYS * DAY);
  const notEmpty = { $nin: [null, ""] };
  const [campaigns, visitRows, waitlistRows, people, spendRows, draftCampaigns, goals] = await Promise.all([
    Campaign.find({}).lean(),
    LandingVisit.aggregate([
      { $match: { day: { $gte: firstDay }, campaign: notEmpty } },
      { $group: { _id: { $toLower: "$campaign" }, visits: { $sum: "$visits" }, storeClicks: { $sum: "$storeClicks" } } },
    ]),
    WaitlistEntry.aggregate([
      { $match: { status: "confirmed", confirmedAt: { $gte: since }, campaign: notEmpty } },
      { $group: { _id: { $toLower: "$campaign" }, n: { $sum: 1 } } },
    ]),
    peopleBySlug(since),
    MarketingSpend.aggregate([
      { $match: { createdAt: { $gte: since }, campaign: notEmpty, status: { $in: ["reserved", "settled"] } } },
      {
        $group: {
          _id: { $toLower: "$campaign" },
          eur: { $sum: { $cond: [{ $eq: ["$status", "settled"] }, { $ifNull: ["$costEur", "$estimateEur"] }, "$estimateEur"] } },
        },
      },
    ]),
    AdDraft.distinct("campaign"),
    goalsConfig(),
  ]);

  const visits = new Map(visitRows.map((r) => [r._id, r]));
  const waitlist = new Map(waitlistRows.map((r) => [r._id, r.n]));
  const spend = new Map(spendRows.map((r) => [r._id, Math.round((r.eur || 0) * 100)]));
  const numbersOf = (slug) => ({
    visits: visits.get(slug)?.visits || 0,
    storeClicks: visits.get(slug)?.storeClicks || 0,
    waitlist: waitlist.get(slug) || 0,
    users: people.get(slug)?.users || 0,
    activatedD7: people.get(slug)?.activatedD7 || 0,
    spendEurCents: spend.get(slug) || 0,
  });

  const registered = new Set(campaigns.map((c) => c.slug));
  const skip = new Set(draftCampaigns.map((c) => String(c).toLowerCase()));
  const seen = new Set([...visits.keys(), ...waitlist.keys(), ...people.keys()]);
  const unregistered = [...seen]
    .filter((slug) => slug && !registered.has(slug) && !skip.has(slug) && !slug.startsWith("invite-"))
    .map((slug) => {
      const n = numbersOf(slug);
      return { slug, visits: n.visits, waitlist: n.waitlist, users: n.users };
    })
    .sort((a, b) => b.visits + b.waitlist + b.users - (a.visits + a.waitlist + a.users) || a.slug.localeCompare(b.slug))
    .slice(0, MAX_UNREGISTERED);

  const sorted = campaigns.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0),
  );
  return {
    days: NUMBERS_DAYS,
    seedCampaign: goals.seedCampaign || null,
    campaigns: sorted.map((c) => ({ ...plain(c), links: linksOf(c.slug, c.channel), numbers: numbersOf(c.slug) })),
    unregistered,
  };
}

module.exports = {
  SOURCES,
  CHANNEL_SOURCES,
  ANSWER_WINDOW_MS,
  NUMBERS_DAYS,
  slugOf,
  acquisitionOf,
  answer,
  noteWaitlistCampaign,
  linksOf,
  qrSvg,
  validCampaign,
  campaignNumbers,
  peopleBySlug,
  plainCampaign: plain,
};
