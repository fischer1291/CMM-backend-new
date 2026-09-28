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

const TEMPLATES = ["chat", "moment", "list", "hero"];
const KINDS = ["app", "hero"];
const CHARACTER_KEY = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const PLATFORMS = ["instagram", "tiktok"];
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{2,59}$/;
const HASHTAG = /^[\p{L}\p{N}_]{1,40}$/u;
const MAX_CONTENT_BYTES = 8 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

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

function view(draft) {
  const d = draft.toObject ? draft.toObject() : draft;
  return {
    id: String(d._id),
    campaign: d.campaign,
    status: d.status,
    title: d.title,
    idea: d.idea,
    kind: d.kind || "app",
    ai: !!d.ai,
    characters: d.characters || [],
    episode: d.episode || null,
    costEur: d.costEur ?? null,
    template: d.template,
    content: d.content,
    seconds: d.seconds,
    captions: d.captions,
    hashtags: d.hashtags,
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
      model: text(body.model, 60) || null,
      kind,
      // Hero videos show realistic AI people: always marked, whatever the agent sends
      ai: kind === "hero" || body.ai === true,
      characters: Array.isArray(body.characters) ? body.characters.filter((k) => CHARACTER_KEY.test(k)).slice(0, 6) : [],
      episode: text(body.episode, 800) || null,
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
  const owners = await Admin.find({ role: "owner", totpEnabled: true }).select("email").lean();
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
 * the recent drafts with the decisions and reasons people gave, the budget
 * and the characters with their chosen reference images.
 */
async function context(now = new Date()) {
  const [visits, drafts, money, characters] = await Promise.all([
    visitStats(now),
    AdDraft.find({ status: { $ne: "rendering" } }).sort({ createdAt: -1 }).limit(40).lean(),
    budget.status(now),
    listCharacters(),
  ]);
  return {
    visits,
    budget: money,
    characters,
    drafts: drafts.map((d) => ({
      campaign: d.campaign,
      kind: d.kind || "app",
      status: d.status,
      title: d.title,
      idea: d.idea,
      template: d.template,
      content: d.content,
      characters: d.characters || [],
      episode: d.episode || null,
      feedback: d.feedback,
      posted: d.posted,
      // A person rewrote the texts: theirs and the agent's, to learn from
      edited: d.edited?.at
        ? { captions: d.captions, hashtags: d.hashtags, before: { captions: d.edited.captions, hashtags: d.edited.hashtags } }
        : null,
      createdAt: d.createdAt,
    })),
  };
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

const LIST_STATUS = { pending: ["pending"], approved: ["approved", "posted"], rejected: ["rejected"], all: ["pending", "approved", "posted", "rejected"] };

async function list(status = "pending") {
  const [drafts, counts] = await Promise.all([
    AdDraft.find({ status: { $in: LIST_STATUS[status] || LIST_STATUS.pending } }).sort({ createdAt: -1 }).limit(60),
    AdDraft.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  return { drafts: drafts.map(view), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
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
  context,
  list,
  decide,
  markPosted,
  editTexts,
};
