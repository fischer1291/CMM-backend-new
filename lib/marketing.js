/**
 * Ad drafts from the marketing agent (CMM repo, marketing/agent). The agent
 * runs once a day as a GitHub Action: it reads context(), writes new ad
 * videos, creates a draft per video and uploads the MP4. People approve or
 * reject them in the console (tab Freigabe); stage 1 posts by hand.
 *
 * Two kinds: "app" (animated app screens, daily) and "hero" (realistic
 * scenes with recurring characters made with Veo, marked as AI, twice a week).
 * Characters get reference images the agent proposes and a person chooses.
 *
 * The agent signs in with MARKETING_AGENT_KEY (Bearer). It can only add
 * drafts, reference images and spending, and read the numbers below; it can
 * never decide, choose or post.
 *
 * Plan 2.14 closes the loop: context() hands back how the posted videos did
 * (views per euro, new users and activation per campaign slug), what the AI
 * costs per posted video, this week's bio link (a campaign
 * bio-<year>-w<week> that ensureBioCampaign() registers every Monday) and
 * how the last runs went; reportRun() (POST /marketing/notify) records each
 * run and raises the alert agent_failed when one failed.
 */
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const AdDraft = require("../models/AdDraft");
const Admin = require("../models/Admin");
const MarketingCharacter = require("../models/MarketingCharacter");
const budget = require("./marketingBudget");
const posting = require("./socialPosting");
const { sendMail, configured: mailConfigured } = require("./mailer");
const { visitStats } = require("./waitlist");
const metrics = require("./metrics");
const { getConfig } = require("./appConfig");
const LandingVisit = require("../models/LandingVisit");
const MarketingSpend = require("../models/MarketingSpend");
const MarketingTally = require("../models/MarketingTally");
const Campaign = require("../models/Campaign");
const { peopleBySlug } = require("./acquisition");
const { alert } = require("./alerts");
const opsCounters = require("./opsCounters");
const { weekKey, isoWeek, shiftDateKey } = require("./localTime");

const TEMPLATES = ["chat", "moment", "list", "story", "hero"];
const KINDS = ["app", "hero"];
const CHARACTER_KEY = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const PLATFORMS = ["instagram", "tiktok"];
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{2,59}$/;
const HASHTAG = /^[\p{L}\p{N}_]{1,40}$/u;
// A style of the agent's own music (CMM marketing/music.js), e.g. "house"
const MUSIC_STYLE = /^[a-z][a-z-]{1,19}$/;
const MAX_CONTENT_BYTES = 8 * 1024;
// Hero episodes the agent gets back: the story so far of every series
const HERO_HISTORY = 60;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
// Alternative opening lines per draft (plan 2.14)
const MAX_HOOK_VARIANTS = 2;
const MAX_HOOK_LENGTH = 120;
// The agent's feedback loop looks at the posts of the last 30 days, top and flop 10
const PERFORMANCE_DAYS = 30;
const PERFORMANCE_TOP = 10;
const ZONE = "Europe/Berlin";
const DAY = 24 * 3600 * 1000;

const site = () => (process.env.SITE_URL || "https://wannayap.app").replace(/\/$/, "");
const consoleUrl = () => `${(process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "")}/console/#approvals`;

/** Bearer MARKETING_AGENT_KEY, compared in constant time. No key set: nobody. */
function agentAuthorized(header) {
  const key = process.env.MARKETING_AGENT_KEY;
  const given = /^Bearer (.+)$/.exec(String(header || ""))?.[1];
  if (!key || key.length < 24 || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The links for a draft: one per platform, so the console can tell them apart. */
const links = (draft) =>
  Object.fromEntries(PLATFORMS.map((p) => [p, `${site()}/?utm_source=${p}&utm_campaign=${encodeURIComponent(draft.campaign)}`]));

/** Cloudinary link that downloads instead of playing. */
const downloadUrl = (draft) =>
  draft.video?.url ? draft.video.url.replace("/video/upload/", `/video/upload/fl_attachment:${draft.campaign}/`) : null;

// Per platform: still on its way or waiting for a person (a TikTok draft in the app)
const UNDER_WAY = ["scheduled", "posting", "processing", "failed", "inbox"];
const openOn = (d, p) => !d.posted?.[p] && UNDER_WAY.includes(d.publish?.[p]?.status);

/**
 * Which tab a draft belongs in: pending, rejected, approved (approved, still to
 * go out somewhere) or posted (out on a platform and nothing left to do: every
 * platform posted, left out, or never meant to be posted there).
 */
function stage(d) {
  if (!["approved", "posted"].includes(d.status)) return d.status;
  const out = PLATFORMS.some((p) => d.posted?.[p]);
  return out && !PLATFORMS.some((p) => openOn(d, p)) ? "posted" : "approved";
}

/** When it last went out on a platform. */
const postedAt = (d) => PLATFORMS.map((p) => d.posted?.[p]).filter(Boolean).sort((a, b) => b - a)[0] || null;

function view(draft) {
  const d = draft.toObject ? draft.toObject() : draft;
  return {
    id: String(d._id),
    campaign: d.campaign,
    status: d.status,
    stage: stage(d),
    postedAt: postedAt(d),
    title: d.title,
    idea: d.idea,
    kind: d.kind || "app",
    ai: !!d.ai,
    characters: d.characters || [],
    episode: d.episode || null,
    hookVariants: d.hookVariants || [],
    stats: statsView(d.stats),
    costEur: d.costEur ?? null,
    template: d.template,
    content: d.content,
    seconds: d.seconds,
    captions: d.captions,
    hashtags: d.hashtags,
    music: d.music?.style ? { style: d.music.style } : null,
    sound: soundView(d.sound),
    model: d.model,
    videoUrl: d.video?.url || null,
    downloadUrl: downloadUrl(d),
    links: links(d),
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    feedback: d.feedback,
    posted: d.posted,
    edited: d.edited?.at ? { at: d.edited.at, by: d.edited.by } : null,
    scheduledAt: d.scheduledAt || null,
    publish: {
      instagram: pick(d.publish?.instagram),
      tiktok: pick(d.publish?.tiktok),
    },
    createdAt: d.createdAt,
  };
}

/** A draft's numbers per platform (plan 2.14), null where nothing was measured yet. */
function statsView(stats) {
  const ig = stats?.instagram?.at ? stats.instagram : null;
  const tk = stats?.tiktok?.at ? stats.tiktok : null;
  if (!ig && !tk) return null;
  const strip = (s, keys) => (s ? Object.fromEntries([...keys, "at"].map((k) => [k, s[k] ?? null])) : null);
  return {
    instagram: strip(ig, ["plays", "reach", "likes", "shares", "saved", "comments"]),
    tiktok: strip(tk, ["views", "likes", "comments", "shares"]),
  };
}

/** Views over both platforms: Instagram plays plus TikTok views, null while neither is measured. */
function viewsOf(stats) {
  const ig = stats?.instagram?.at ? stats.instagram.plays : null;
  const tk = stats?.tiktok?.at ? stats.tiktok.views : null;
  return ig == null && tk == null ? null : (ig || 0) + (tk || 0);
}

/**
 * The agent's alternative hooks: undefined/null → none, otherwise an array
 * of strings. Lenient like the other texts of a draft, because the video
 * is already rendered (and paid for) when it arrives: each is trimmed and
 * cut to 120 characters, empty ones are dropped, the first two are kept.
 * Only a wrong type (no array, or an entry that is no string) is invalid
 * (null).
 */
function hookVariantsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return null;
  return value
    .map((v) => v.trim().slice(0, MAX_HOOK_LENGTH).trim())
    .filter(Boolean)
    .slice(0, MAX_HOOK_VARIANTS);
}

const soundView = (s) => (s?.title ? { title: s.title, artist: s.artist || "", commercial: !!s.commercial, why: s.why || "" } : null);

/** The agent's sound tip, or null: plain short texts, nothing else. */
function soundTip(s) {
  if (!s || typeof s !== "object") return null;
  const title = text(s.title, 100);
  return title ? { title, artist: text(s.artist, 100), commercial: s.commercial === true, why: text(s.why, 300) } : null;
}

const pick = (p) => (p?.status ? { status: p.status, url: p.url || null, error: p.error || null, attempts: p.attempts || 0 } : null);

// --- Agent --------------------------------------------------------------------------

/** New draft, without its video yet. Returns { draft } or { error }. */
async function createDraft(body = {}) {
  const campaign = text(body.campaign, 60).toLowerCase();
  if (!CAMPAIGN.test(campaign)) return { error: "invalid_campaign" };
  if (!TEMPLATES.includes(body.template)) return { error: "invalid_template" };
  const title = text(body.title, 120);
  if (!title) return { error: "invalid_title" };
  const content = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? body.content : null;
  if (!content || Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT_BYTES) return { error: "invalid_content" };
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.map((h) => text(h, 41).replace(/^#/, "")).filter((h) => HASHTAG.test(h)).slice(0, 15)
    : [];
  const hookVariants = hookVariantsOf(body.hookVariants);
  if (!hookVariants) return { error: "invalid_hook_variants" };
  const seconds = Number(body.seconds);
  const kind = KINDS.includes(body.kind) ? body.kind : "app";
  const cost = Number(body.costEur);
  try {
    const draft = await AdDraft.create({
      campaign,
      title,
      idea: text(body.idea, 1500),
      template: body.template,
      content,
      seconds: Number.isFinite(seconds) && seconds > 0 && seconds <= 90 ? seconds : null,
      captions: { instagram: text(body.captions?.instagram, 2200), tiktok: text(body.captions?.tiktok, 2200) },
      hashtags,
      music: { style: MUSIC_STYLE.test(body.music?.style || "") ? body.music.style : null },
      sound: soundTip(body.sound) || {},
      model: text(body.model, 60) || null,
      kind,
      // Hero videos show realistic AI people: always marked, whatever the agent sends
      ai: kind === "hero" || body.ai === true,
      characters: Array.isArray(body.characters) ? body.characters.filter((k) => CHARACTER_KEY.test(k)).slice(0, 6) : [],
      episode: text(body.episode, 800) || null,
      hookVariants,
      costEur: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) / 100 : null,
    });
    return { draft: view(draft) };
  } catch (err) {
    if (err.code === 11000) return { error: "campaign_taken" };
    throw err;
  }
}

let uploader = (buffer, publicId, { resourceType = "video", folder = "marketing" } = {}) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: resourceType, folder, public_id: publicId, overwrite: true }, (error, uploaded) =>
        error ? reject(error) : resolve({ url: uploaded.secure_url, publicId: uploaded.public_id, bytes: uploaded.bytes }),
      )
      .end(buffer);
  });

/** Tests replace the Cloudinary upload. */
function setUploader(fn) {
  uploader = fn;
}

/** The MP4 for a draft that is still rendering. Then it waits for approval. */
async function attachVideo(id, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return { error: "invalid_video" };
  if (buffer.length > MAX_VIDEO_BYTES) return { error: "video_too_large" };
  // ISO base media file: "ftyp" at offset 4
  if (buffer.subarray(4, 8).toString("latin1") !== "ftyp") return { error: "invalid_video" };
  const draft = await AdDraft.findById(id).catch(() => null);
  if (!draft) return { error: "not_found" };
  if (draft.status !== "rendering") return { error: "already_uploaded" };
  const video = await uploader(buffer, draft.campaign);
  draft.video = video;
  draft.status = "pending";
  await draft.save();
  return { draft: view(draft) };
}

/** Mail to the owners: new videos are waiting. Quietly skipped without SMTP. */
async function notifyOwners() {
  const pending = await AdDraft.countDocuments({ status: "pending" });
  if (pending) {
    require("./adminPush").tell("approvals", {
      title: pending === 1 ? "Ein Werbevideo wartet auf dich" : `${pending} Werbevideos warten auf dich`,
      body: "Der Marketing-Agent hat Neues für Instagram und TikTok. Tippen zum Ansehen und Freigeben.",
      url: "#approvals",
      tag: "approvals",
    });
  }
  if (!pending || !mailConfigured()) return { pending, mailed: 0 };
  const owners = await Admin.find({ role: "owner", totpEnabled: true, active: { $ne: false } }).select("email").lean();
  let mailed = 0;
  for (const { email } of owners) {
    try {
      await sendMail({
        to: email,
        subject: `${pending} ${pending === 1 ? "Werbevideo wartet" : "Werbevideos warten"} auf deine Freigabe`,
        text: `Der Marketing-Agent hat neue Videos für Instagram und TikTok vorbereitet.\n\nAnsehen und freigeben: ${consoleUrl()}`,
        html: `<p>Der Marketing-Agent hat neue Videos für Instagram und TikTok vorbereitet.</p><p><a href="${consoleUrl()}">Ansehen und freigeben</a></p>`,
      });
      mailed++;
    } catch (err) {
      console.error("❌ marketing notify:", err.message);
    }
  }
  return { pending, mailed };
}

/**
 * What the agent needs to decide: visits and sign-ups per campaign (30 days),
 * the recent drafts with the decisions and reasons people gave, the budget,
 * the north star (rolling activation and address book density against the
 * goals: no paid reach while activation is under goal) and the characters
 * with their chosen reference images. The hero episodes
 * come on their own as well: with daily app videos they would soon drop out
 * of the recent drafts, and the series need their whole story. `notes` are
 * the owner's hints from the Monday review (AppConfig.marketingNotes, plan
 * 2.11, e.g. the hook topic of the week), null when there are none.
 * Plan 2.14 adds `performance` (top and flop of the posted videos by views
 * per euro, see performance()), `aiCostPerPostedVideoEur`, this week's
 * `bioLink` and `runs` (how the last runs went).
 */
async function context(now = new Date()) {
  const [visits, drafts, heroes, money, characters, pct4w, dens, config, perf, aiCost, runs] = await Promise.all([
    visitStats(now),
    AdDraft.find({ status: { $ne: "rendering" } }).sort({ createdAt: -1 }).limit(40).lean(),
    AdDraft.find({ status: { $ne: "rendering" }, kind: "hero" }).sort({ createdAt: -1 }).limit(HERO_HISTORY).lean(),
    budget.status(now),
    listCharacters(),
    metrics.activation4w(now),
    metrics.density(now),
    getConfig(),
    performance(now),
    aiCostPerPostedVideo(now),
    runStatus(),
  ]);
  const { goals } = config;
  return {
    notes: config.marketingNotes || null,
    performance: perf,
    aiCostPerPostedVideoEur: aiCost,
    bioLink: bioLink(now),
    runs: { lastRunAt: runs.lastRunAt, lastOkAt: runs.lastOkAt, lastFailedAt: runs.lastFailedAt, lastStep: runs.lastStep, lastDurationSec: runs.lastDurationSec },
    visits,
    budget: money,
    activation: { pct4w: pct4w.pct, sample: pct4w.measured, goalPct: goals.activationPct, density: dens.c3plus, densityGoalPct: goals.densityPct },
    characters,
    drafts: drafts.map(contextDraft),
    heroes: heroes.map(contextDraft),
  };
}

/** One draft as the agent sees it. */
function contextDraft(d) {
  return {
    campaign: d.campaign,
    kind: d.kind || "app",
    status: d.status,
    title: d.title,
    idea: d.idea,
    template: d.template,
    content: d.content,
    characters: d.characters || [],
    episode: d.episode || null,
    hookVariants: d.hookVariants || [],
    stats: statsView(d.stats),
    feedback: d.feedback,
    posted: d.posted,
    music: d.music?.style ? { style: d.music.style } : null,
    sound: soundView(d.sound),
    // A person rewrote the texts: theirs and the agent's, to learn from
    edited: d.edited?.at
      ? { captions: d.captions, hashtags: d.hashtags, before: { captions: d.edited.captions, hashtags: d.edited.hashtags } }
      : null,
    createdAt: d.createdAt,
  };
}

// --- Performance, bio link and runs (plan 2.14) --------------------------------------

/** What a campaign's AI calls cost: settled at their cost, reserved at the estimate. */
const SPEND_EUR = { $sum: { $cond: [{ $eq: ["$status", "settled"] }, { $ifNull: ["$costEur", "$estimateEur"] }, "$estimateEur"] } };
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
const postedSince = (since) => ({ $or: PLATFORMS.map((p) => ({ [`posted.${p}`]: { $gte: since } })) });

/**
 * The videos posted in the last 30 days, ranked by views per euro: { top,
 * flop }, each up to 10 (top best first, flop worst first; with fewer than
 * 20 measured they split the list, so no video is in both). views:
 * Instagram plays plus TikTok views (AdDraft.stats, lib/socialPosting.js
 * fetchStats); costEur: the MarketingSpend booked for the campaign (or the
 * draft's own costEur when the agent booked none under its name);
 * newUsers and activatedD7: the campaign tab's numbers for the slug
 * (lib/acquisition.js peopleBySlug, users created in these 30 days). Only
 * videos with views and a cost are ranked: a video without numbers yet is
 * neither top nor flop.
 */
async function performance(now = new Date()) {
  const since = new Date(now.getTime() - PERFORMANCE_DAYS * DAY);
  const drafts = await AdDraft.find(postedSince(since), { campaign: 1, title: 1, template: 1, kind: 1, stats: 1, costEur: 1, posted: 1 }).lean();
  if (!drafts.length) return { top: [], flop: [] };
  const slugs = drafts.map((d) => d.campaign);
  const [spendRows, people] = await Promise.all([
    MarketingSpend.aggregate([
      { $match: { campaign: { $in: slugs }, status: { $in: ["reserved", "settled"] } } },
      { $group: { _id: "$campaign", eur: SPEND_EUR } },
    ]),
    peopleBySlug(since, slugs),
  ]);
  const spend = new Map(spendRows.map((r) => [r._id, r.eur]));
  const ranked = drafts
    .map((d) => {
      const views = viewsOf(d.stats);
      const cost = spend.has(d.campaign) ? spend.get(d.campaign) : d.costEur;
      const costEur = Number.isFinite(cost) ? round(cost, 2) : null;
      const sum = (k) => (d.stats?.instagram?.[k] || 0) + (d.stats?.tiktok?.[k] || 0);
      return {
        campaign: d.campaign,
        title: d.title,
        template: d.template,
        kind: d.kind || "app",
        postedAt: postedAt(d),
        views,
        likes: views == null ? null : sum("likes"),
        shares: views == null ? null : sum("shares"),
        costEur,
        viewsPerEur: views != null && costEur > 0 ? round(views / costEur, 1) : null,
        newUsers: people.get(d.campaign)?.users || 0,
        activatedD7: people.get(d.campaign)?.activatedD7 || 0,
      };
    })
    .filter((r) => r.viewsPerEur != null)
    .sort((a, b) => b.viewsPerEur - a.viewsPerEur || b.views - a.views || a.campaign.localeCompare(b.campaign));
  const topCount = Math.min(PERFORMANCE_TOP, Math.ceil(ranked.length / 2));
  const flopCount = Math.min(PERFORMANCE_TOP, ranked.length - topCount);
  return { top: ranked.slice(0, topCount), flop: ranked.slice(ranked.length - flopCount).reverse() };
}

/**
 * AI euros per video that actually went out: everything the agent spent on
 * AI (anthropic, google; not media) in the last 30 days (MarketingSpend, settled at cost, reserved at the
 * estimate) over the videos posted on at least one platform in that time.
 * null while nothing was posted.
 */
async function aiCostPerPostedVideo(now = new Date()) {
  const since = new Date(now.getTime() - PERFORMANCE_DAYS * DAY);
  const [rows, posted] = await Promise.all([
    // AI providers only: paid reach (media, plan 2.7) is not a cost of making a video
    MarketingSpend.aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ["reserved", "settled"] }, provider: { $nin: budget.GATED } } },
      { $group: { _id: null, eur: SPEND_EUR } },
    ]),
    AdDraft.countDocuments(postedSince(since)),
  ]);
  return posted ? round((rows[0]?.eur || 0) / posted, 2) : null;
}

/** This week's bio link campaign (ISO week of Europe/Berlin): { slug, week, monday }. */
function bioCampaign(now = new Date()) {
  const monday = weekKey(now, ZONE);
  const label = isoWeek(monday);
  return { slug: `bio-${label.toLowerCase()}`, week: Number(label.slice(6)), monday };
}

/** The link for the Instagram and TikTok bio this week: /k/bio-<year>-w<week>. */
const bioLink = (now = new Date()) => `${site()}/k/${bioCampaign(now).slug}`;

/**
 * Register this week's bio link campaign (leader job, hourly, index.js), so
 * the campaign tab counts the bio link per week: channel other, running
 * from Monday 00:00 Berlin for 7 days. Idempotent over the slug, and a
 * campaign the owner already changed is left alone. Earlier bio weeks that
 * ran out are set to ended. Returns { slug, created, ended }.
 */
async function ensureBioCampaign(now = new Date()) {
  const { slug, week, monday } = bioCampaign(now);
  const startedAt = posting.atLocal(monday, 0);
  const endedAt = posting.atLocal(shiftDateKey(monday, 7), 0);
  let created = false;
  if (!(await Campaign.exists({ slug }))) {
    try {
      await Campaign.create({
        slug,
        channel: "other",
        title: `Bio-Link KW ${week}`,
        status: "running",
        startedAt,
        endedAt,
        notes: "Automatisch angelegt: der Link in der Instagram- und TikTok-Bio dieser Woche.",
        createdBy: "automatisch",
      });
      created = true;
    } catch (err) {
      // Two leaders at once: the other one created it
      if (err.code !== 11000) throw err;
    }
  }
  const ended = await Campaign.updateMany({ slug: /^bio-\d{4}-w\d{2}$/, status: "running", endedAt: { $lte: now } }, { $set: { status: "ended" } });
  return { slug, created, ended: ended.modifiedCount };
}

const RUN_FIELDS = ["lastRunAt", "lastOkAt", "lastFailedAt", "lastStep", "lastRunUrl", "lastDurationSec"];

/** How the agent's runs went (MarketingTally "runs"); every field null before the first report. */
async function runStatus() {
  const doc = await MarketingTally.findById("runs").lean();
  return Object.fromEntries(RUN_FIELDS.map((k) => [k, doc?.[k] ?? null]));
}

/** The step a failed run names: letters, digits and a few separators, at most 60 characters. */
const stepOf = (v) => (typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._:/()-]/gu, "").trim().slice(0, 60) || null : null);

/** A link to the GitHub Actions run (https on github.com only), else null. */
function runUrlOf(v) {
  if (typeof v !== "string" || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * POST /marketing/notify at the end of every agent run (CMM
 * .github/workflows/marketing-agent.yml, marketing/agent/daily.js and
 * hero.js). body: { failed?, step?, runUrl?, durationSec? }.
 * Without failed (a run that went through): the mail and push about
 * drafts waiting (notifyOwners) and runs.lastOkAt. With failed: true (the
 * workflow's `if: failure()` step): runs.lastFailedAt and lastStep, and
 * the alert agent_failed with the step and the run link, never an error
 * text (the log stays in GitHub). Lenient on purpose: a step name or link
 * it doesn't accept is left out, so a failure report never gets lost over
 * its details. Day counters agentRunsOk / agentRunsFailed count the runs.
 */
async function reportRun(body = {}, now = new Date()) {
  const failed = body?.failed === true;
  const step = stepOf(body?.step);
  const runUrl = runUrlOf(body?.runUrl);
  const seconds = typeof body?.durationSec === "number" && Number.isFinite(body.durationSec) && body.durationSec >= 0 && body.durationSec <= 86400 ? Math.round(body.durationSec) : null;
  const set = { lastRunAt: now, updatedAt: now };
  if (runUrl) set.lastRunUrl = runUrl;
  if (seconds !== null) set.lastDurationSec = seconds;
  if (failed) Object.assign(set, { lastFailedAt: now, lastStep: step });
  else set.lastOkAt = now;
  await MarketingTally.updateOne({ _id: "runs" }, { $set: set }, { upsert: true });
  await opsCounters.count(failed ? "agentRunsFailed" : "agentRunsOk", now).catch((err) => console.error("❌ agent run counter:", err.message));
  if (!failed) return notifyOwners();
  const text = `Der Lauf ist im Schritt „${step || "unbekannt"}“ abgebrochen.${runUrl ? ` Log: ${runUrl}` : " Log: GitHub → Actions → marketing-agent."} Der nächste Lauf startet nach Zeitplan.`;
  let alerted = false;
  try {
    alerted = await alert("agent_failed", text, { level: "warn", title: "Marketing-Agent fehlgeschlagen", now });
  } catch (err) {
    console.error("❌ agent_failed alert:", err.message);
  }
  return { alerted };
}

/** The console's line about the agent: bio link, last runs, AI euros per posted video. */
async function agentOverview(now = new Date()) {
  const [runs, aiCost, tally] = await Promise.all([runStatus(), aiCostPerPostedVideo(now), MarketingTally.findById("runs", { lastStatsAt: 1 }).lean()]);
  const { slug, week } = bioCampaign(now);
  return { bioLink: bioLink(now), bioSlug: slug, bioWeek: week, runs, aiCostPerPostedVideoEur: aiCost, lastStatsAt: tally?.lastStatsAt ?? null };
}

// --- Characters ---------------------------------------------------------------------

function characterView(c) {
  return {
    key: c.key,
    name: c.name,
    summary: c.summary,
    chosen: c.chosen?.url || null,
    candidates: (c.candidates || []).map((i) => i.url),
    wantsNew: !!c.wantsNew,
    feedback: c.feedback || null,
  };
}

async function listCharacters() {
  return (await MarketingCharacter.find().sort({ key: 1 }).lean()).map(characterView);
}

/** The agent keeps name and summary in sync with the repo (marketing/agent/characters.js). */
async function upsertCharacter(key, { name, summary } = {}) {
  if (!CHARACTER_KEY.test(key || "")) return { error: "invalid_character" };
  const n = text(name, 40);
  if (!n) return { error: "invalid_name" };
  const c = await MarketingCharacter.findOneAndUpdate(
    { key },
    { name: n, summary: text(summary, 600), updatedAt: new Date() },
    { upsert: true, new: true },
  );
  return { character: characterView(c) };
}

/** One reference image proposal (PNG or JPEG). Clears a "new suggestions" request. */
async function addCandidate(key, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024 || buffer.length > MAX_IMAGE_BYTES) return { error: "invalid_image" };
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!png && !jpeg) return { error: "invalid_image" };
  const c = await MarketingCharacter.findOne({ key });
  if (!c) return { error: "not_found" };
  if (c.candidates.length >= MAX_CANDIDATES && !c.wantsNew) return { error: "enough_candidates" };
  const image = await uploader(buffer, `${key}-${Date.now()}`, { resourceType: "image", folder: "marketing/characters" });
  if (c.wantsNew) c.candidates = [];
  c.wantsNew = false;
  c.candidates.push({ url: image.url, publicId: image.publicId });
  c.updatedAt = new Date();
  await c.save();
  return { character: characterView(c) };
}

/** A person picks one of the candidates as the reference. */
async function chooseCharacterImage(key, url) {
  const c = await MarketingCharacter.findOne({ key });
  if (!c) return { error: "not_found" };
  const image = c.candidates.find((i) => i.url === url);
  if (!image) return { error: "unknown_image" };
  c.chosen = { url: image.url, publicId: image.publicId };
  c.updatedAt = new Date();
  await c.save();
  return { character: characterView(c) };
}

/** Ask the agent for new proposals next run, with what should change. */
async function requestNewImages(key, feedback) {
  const c = await MarketingCharacter.findOneAndUpdate(
    { key },
    { wantsNew: true, feedback: text(feedback, 400) || null, updatedAt: new Date() },
    { new: true },
  );
  if (!c) return { error: "not_found" };
  return { character: characterView(c) };
}

// --- Console ------------------------------------------------------------------------

const TABS = ["pending", "approved", "posted", "rejected"];
const LIST_LIMIT = 60;

/**
 * The drafts of one tab (pending, approved, posted, rejected) and how many are
 * in each. approved and posted both come from the approved videos, split by
 * stage(); posted ones carry their visits via their campaign link.
 */
async function list(tab = "pending") {
  if (!TABS.includes(tab)) tab = "pending";
  const [byStatus, live] = await Promise.all([
    AdDraft.aggregate([{ $match: { status: { $in: ["pending", "rejected"] } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    AdDraft.find({ status: { $in: ["approved", "posted"] } }).select("status posted publish").lean(),
  ]);
  const counts = Object.fromEntries(byStatus.map((c) => [c._id, c.n]));
  const ids = { approved: [], posted: [] };
  for (const d of live) ids[stage(d)].push(d._id);
  counts.approved = ids.approved.length;
  counts.posted = ids.posted.length;

  let drafts;
  if (tab === "pending" || tab === "rejected") {
    drafts = await AdDraft.find({ status: tab }).sort(tab === "rejected" ? { decidedAt: -1, createdAt: -1 } : { createdAt: -1 }).limit(LIST_LIMIT);
  } else {
    drafts = await AdDraft.find({ _id: { $in: ids[tab] } });
    // Still to go out: next slot first; out: latest first
    drafts.sort(tab === "approved"
      ? (a, b) => (a.scheduledAt || Infinity) - (b.scheduledAt || Infinity) || b.createdAt - a.createdAt
      : (a, b) => (postedAt(b) || 0) - (postedAt(a) || 0));
    drafts = drafts.slice(0, LIST_LIMIT);
  }
  const views = drafts.map(view);
  if (tab === "posted" && views.length) {
    const visits = await LandingVisit.aggregate([
      { $match: { campaign: { $in: views.map((v) => v.campaign) } } },
      { $group: { _id: "$campaign", visits: { $sum: "$visits" }, submitted: { $sum: "$submitted" } } },
    ]);
    const by = new Map(visits.map((v) => [v._id, v]));
    for (const v of views) v.visits = { visits: by.get(v.campaign)?.visits || 0, submitted: by.get(v.campaign)?.submitted || 0 };
  }
  return { drafts: views, counts };
}

/** approve / reject a pending draft. The reason helps the agent next time. */
async function decide(id, action, by, feedback) {
  if (!["approve", "reject"].includes(action)) return { error: "invalid_action" };
  const draft = await AdDraft.findOneAndUpdate(
    { _id: id, status: "pending" },
    { status: action === "approve" ? "approved" : "rejected", decidedBy: by, decidedAt: new Date(), feedback: text(feedback, 500) || null },
    { new: true },
  ).catch(() => null);
  if (!draft) return { error: "not_pending" };
  // Approved: goes out in the next free slot on every connected platform
  if (action === "approve") return { draft: view(await posting.schedule(draft)) };
  return { draft: view(draft) };
}

const MAX_HASHTAGS = 5; // Instagram's limit per post

/**
 * Change captions and hashtags before a video goes out (owner, console).
 * The agent's own texts are kept on the first change, so it can see what a
 * person changed. body: { captions: { instagram, tiktok }, hashtags: [..] or "#a #b" }.
 */
async function editTexts(id, body = {}, by) {
  const draft = await AdDraft.findOne({ _id: id, status: { $in: ["pending", "approved"] } }).catch(() => null);
  if (!draft) return { error: "not_editable" };
  if (PLATFORMS.some((p) => ["posting", "processing", "posted", "inbox"].includes(draft.publish?.[p]?.status) || draft.posted?.[p])) return { error: "already_posting" };
  const raw = typeof body.hashtags === "string" ? body.hashtags.split(/[\s,]+/) : Array.isArray(body.hashtags) ? body.hashtags : null;
  const hashtags = raw ? [...new Set(raw.map((h) => text(h, 41).replace(/^#/, "").toLowerCase()).filter(Boolean))] : draft.hashtags;
  if (hashtags.some((h) => !HASHTAG.test(h))) return { error: "invalid_hashtag" };
  if (hashtags.length > MAX_HASHTAGS) return { error: "too_many_hashtags" };
  const captions = {
    instagram: body.captions?.instagram !== undefined ? text(body.captions.instagram, 2200) : draft.captions.instagram,
    tiktok: body.captions?.tiktok !== undefined ? text(body.captions.tiktok, 2200) : draft.captions.tiktok,
  };
  if (!captions.instagram || !captions.tiktok) return { error: "empty_caption" };
  if (!draft.edited?.at) draft.edited = { captions: { instagram: draft.captions.instagram, tiktok: draft.captions.tiktok }, hashtags: [...draft.hashtags] };
  draft.edited.at = new Date();
  draft.edited.by = by;
  draft.captions = captions;
  draft.hashtags = hashtags;
  await draft.save();
  return { draft: view(draft) };
}

/**
 * Leave a platform out for this video (e.g. posting failed and it is not worth
 * another try, or the TikTok draft was deleted). "Jetzt posten" brings it back.
 */
async function skipPlatform(id, platform) {
  if (!PLATFORMS.includes(platform)) return { error: "invalid_platform" };
  const draft = await AdDraft.findOne({ _id: id, status: { $in: ["approved", "posted"] } }).catch(() => null);
  if (!draft) return { error: "not_approved" };
  const st = draft.publish?.[platform]?.status;
  if (draft.posted?.[platform] || ["posting", "processing", "posted"].includes(st)) return { error: "already_posting" };
  draft.publish[platform].status = "skipped";
  draft.publish[platform].error = null;
  await draft.save();
  return { draft: view(draft) };
}

/** Posted by hand on a platform (or undone). */
async function markPosted(id, platform, posted = true) {
  if (!PLATFORMS.includes(platform)) return { error: "invalid_platform" };
  const draft = await AdDraft.findOne({ _id: id, status: { $in: ["approved", "posted"] } }).catch(() => null);
  if (!draft) return { error: "not_approved" };
  draft.posted[platform] = posted ? new Date() : null;
  draft.status = PLATFORMS.some((p) => draft.posted[p]) ? "posted" : "approved";
  await draft.save();
  return { draft: view(draft) };
}

module.exports = {
  TEMPLATES,
  stage,
  skipPlatform,
  agentAuthorized,
  listCharacters,
  upsertCharacter,
  addCandidate,
  chooseCharacterImage,
  requestNewImages,
  createDraft,
  attachVideo,
  setUploader,
  notifyOwners,
  reportRun,
  agentOverview,
  ensureBioCampaign,
  bioLink,
  performance,
  context,
  list,
  decide,
  markPosted,
  editTexts,
};
