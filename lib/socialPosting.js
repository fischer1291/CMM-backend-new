/**
 * Automatic posting of approved ad videos to Instagram (Reels) and TikTok.
 *
 * Approving a draft in the console schedules it for the next free slot
 * (POST_SLOTS, default 12:00 and 18:00 Europe/Berlin, one video per slot);
 * runDue() (every few minutes, background job) posts what is due to every
 * connected platform. AI videos are labelled: Instagram `is_ai_generated`,
 * TikTok `is_aigc`.
 *
 * Instagram: "Instagram API with Instagram Login". The owner pastes the
 * long-lived token from the Meta app dashboard into the console; the backend
 * refreshes it before it runs out (60 days).
 *
 * TikTok: Content Posting API, connected with Login Kit (OAuth) from the
 * console. Mode "inbox" puts the video as a draft into the TikTok app (the
 * person finishes posting there; works before TikTok's audit); mode "direct"
 * posts it (after the audit; before it, TikTok only allows private posts).
 *
 * fetchStats() (leader job post-stats through statsDue(): at most every 6
 * hours, plan 2.14) reads how the videos of the last 30 days did: Instagram
 * media insights and TikTok's video query (scope video.list) into
 * AdDraft.stats, which lib/marketing.js context() hands back to the agent.
 * When none can be read, the channel's lastError says why ("Zahlen: …").
 *
 * Tokens are stored encrypted (AES-256-GCM, key from JWT_SECRET) and never
 * sent to the console. A post is claimed before it is sent, so two runs
 * never post the same video twice.
 */
const crypto = require("crypto");
const AdDraft = require("../models/AdDraft");
const MarketingChannel = require("../models/MarketingChannel");
const { localParts } = require("./localTime");

const ZONE = "Europe/Berlin";
const PLATFORMS = ["instagram", "tiktok"];
const IG = "https://graph.instagram.com";
const TT = "https://open.tiktokapis.com/v2";
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const STUCK_AFTER_MS = 20 * 60 * 1000;
const DAY = 24 * 3600 * 1000;
// Polling while a platform processes the video; tests make it fast
const timing = { pollMs: 15000, polls: 16 };

const api = () => (process.env.PUBLIC_API_URL || "https://api.wannayap.app").replace(/\/$/, "");
const tiktokRedirect = () => `${api()}/marketing/tiktok/callback`;
const tiktokConfigured = () => !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Secrets ------------------------------------------------------------------------

const key = () => crypto.createHash("sha256").update(`${process.env.JWT_SECRET || ""}:marketing-channels`).digest();
function seal(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
function unseal(sealed) {
  if (!sealed) return null;
  const [iv, tag, data] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// --- Slots --------------------------------------------------------------------------

const slots = () =>
  (process.env.POST_SLOTS || "12:00,18:00")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s))
    .map((s) => s.padStart(5, "0"))
    .sort();

/** The instant of local time `minutes` after midnight on `dateKey` in Berlin. */
function atLocal(dateKey, minutes) {
  const midnight = Date.parse(`${dateKey}T00:00:00Z`);
  let t = midnight + minutes * 60000;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t), ZONE);
    const diff = ((midnight - Date.parse(`${p.dateKey}T00:00:00Z`)) / DAY) * 1440 + minutes - p.minutes;
    if (!diff) break;
    t += diff * 60000;
  }
  return new Date(t);
}

/** The next slot at least 10 minutes away that no other draft has taken. */
async function nextSlot(now = new Date()) {
  const taken = new Set(
    (await AdDraft.find({ scheduledAt: { $gte: now } }).select("scheduledAt").lean()).map((d) => d.scheduledAt.getTime()),
  );
  const today = localParts(now, ZONE).dateKey;
  for (let day = 0; day < 30; day++) {
    const dateKey = new Date(Date.parse(`${today}T12:00:00Z`) + day * DAY).toISOString().slice(0, 10);
    for (const s of slots()) {
      const [h, m] = s.split(":").map(Number);
      const at = atLocal(dateKey, h * 60 + m);
      if (at.getTime() >= now.getTime() + 10 * 60000 && !taken.has(at.getTime())) return at;
    }
  }
  return null;
}

// --- Channels -----------------------------------------------------------------------

async function connectedChannels() {
  const list = await MarketingChannel.find({ accessToken: { $ne: null } });
  return Object.fromEntries(list.map((c) => [c._id, c]));
}

/** What the console may see: no tokens. */
async function channelStatus() {
  const all = Object.fromEntries((await MarketingChannel.find().lean()).map((c) => [c._id, c]));
  const view = (c) =>
    c?.accessToken
      ? { connected: true, username: c.username, expiresAt: c.expiresAt, refreshExpiresAt: c.refreshExpiresAt, mode: c.mode, privacyLevel: c.privacyLevel, lastError: c.lastError, connectedAt: c.connectedAt }
      : { connected: false, lastError: c?.lastError || null };
  return {
    slots: slots(),
    instagram: view(all.instagram),
    tiktok: { ...view(all.tiktok), configured: tiktokConfigured(), redirectUri: tiktokRedirect() },
  };
}

async function disconnect(platform) {
  if (!PLATFORMS.includes(platform)) return { error: "invalid_platform" };
  await MarketingChannel.deleteOne({ _id: platform });
  return { ok: true };
}

// --- HTTP ---------------------------------------------------------------------------

async function request(url, { method = "GET", form, json, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(json ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data };
}

async function ig(path, opts) {
  const { ok, status, data } = await request(`${IG}${path}`, opts);
  if (!ok || data.error) throw new Error(`Instagram ${status}: ${data.error?.message || data.raw || "Fehler"}`);
  return data;
}

async function tt(path, token, json) {
  const { status, data } = await request(`${TT}${path}`, { method: "POST", json, headers: { Authorization: `Bearer ${token}` } });
  if (data.error && data.error.code !== "ok") throw new Error(`TikTok ${status}: ${data.error.code} ${data.error.message || ""}`.trim());
  if (status >= 400) throw new Error(`TikTok ${status}`);
  return data.data || {};
}

// --- Instagram ----------------------------------------------------------------------

/** The owner pastes the long-lived token from the Meta app dashboard. */
async function connectInstagram(token, by) {
  const t = typeof token === "string" ? token.trim() : "";
  if (t.length < 20 || t.length > 1000 || /\s/.test(t)) return { error: "invalid_token" };
  let me;
  try {
    me = await ig(`/me?fields=user_id,username&access_token=${encodeURIComponent(t)}`);
  } catch (err) {
    return { error: "token_rejected", message: err.message };
  }
  await MarketingChannel.updateOne(
    { _id: "instagram" },
    {
      accessToken: seal(t),
      accountId: String(me.user_id || me.id),
      username: me.username || null,
      // Dashboard tokens are long-lived: 60 days
      expiresAt: new Date(Date.now() + 60 * DAY),
      connectedBy: by,
      connectedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    },
    { upsert: true },
  );
  return { channel: (await channelStatus()).instagram };
}

const caption = (draft, platform) =>
  [draft.captions?.[platform], (draft.hashtags || []).map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);

async function postInstagram(draft, channel) {
  const token = unseal(channel.accessToken);
  const params = { media_type: "REELS", video_url: draft.video.url, caption: caption(draft, "instagram"), share_to_feed: "true", access_token: token };
  if (draft.ai) params.is_ai_generated = "true";
  const container = (await ig(`/${channel.accountId}/media`, { method: "POST", form: params })).id;
  for (let i = 0; ; i++) {
    await sleep(timing.pollMs);
    const s = await ig(`/${container}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram: ${s.status || s.status_code}`);
    if (i >= timing.polls) throw new Error("Instagram verarbeitet das Video zu lange");
  }
  const media = await ig(`/${channel.accountId}/media_publish`, { method: "POST", form: { creation_id: container, access_token: token } });
  const info = await ig(`/${media.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({}));
  return { status: "posted", id: String(media.id), url: info.permalink || null };
}

// --- TikTok -------------------------------------------------------------------------

/** Signed OAuth state: who started it and until when it is valid. */
function tiktokState(adminId, now = Date.now()) {
  const body = `${adminId}.${now + 15 * 60000}.${crypto.randomBytes(8).toString("hex")}`;
  const mac = crypto.createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function checkState(state, now = Date.now()) {
  const parts = String(state || "").split(".");
  if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join(".");
  const mac = crypto.createHmac("sha256", key()).update(body).digest("base64url");
  if (mac.length !== parts[3].length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(parts[3]))) return null;
  if (Number(parts[1]) < now) return null;
  return { adminId: parts[0] };
}

function tiktokAuthorizeUrl(adminId) {
  if (!tiktokConfigured()) return { error: "tiktok_not_configured" };
  const q = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    // video.list: the view counts of our own posts (plan 2.14, fetchStats)
    scope: "user.info.basic,video.upload,video.publish,video.list",
    response_type: "code",
    redirect_uri: tiktokRedirect(),
    state: tiktokState(adminId),
  });
  return { url: `https://www.tiktok.com/v2/auth/authorize/?${q}` };
}

async function tiktokTokens(form) {
  const { data } = await request(`${TT}/oauth/token/`, {
    method: "POST",
    form: { client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, ...form },
  });
  if (!data.access_token) throw new Error(`TikTok-Anmeldung: ${data.error_description || data.error || data.message || "kein Token"}`);
  return data;
}

async function storeTiktok(tokens, by) {
  let username = null;
  try {
    const info = await fetch(`${TT}/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json());
    username = info?.data?.user?.display_name || null;
  } catch {
    // The name is only for the console
  }
  const now = Date.now();
  await MarketingChannel.updateOne(
    { _id: "tiktok" },
    {
      $set: {
        accessToken: seal(tokens.access_token),
        refreshToken: seal(tokens.refresh_token),
        expiresAt: new Date(now + (tokens.expires_in || 86400) * 1000),
        refreshExpiresAt: new Date(now + (tokens.refresh_expires_in || 365 * 86400) * 1000),
        accountId: tokens.open_id || null,
        ...(username ? { username } : {}),
        ...(by ? { connectedBy: by, connectedAt: new Date() } : {}),
        lastError: null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  // Defaults, also when an earlier failed login already left the document behind
  await MarketingChannel.updateOne({ _id: "tiktok", mode: null }, { mode: "inbox" });
  await MarketingChannel.updateOne({ _id: "tiktok", privacyLevel: null }, { privacyLevel: "PUBLIC_TO_EVERYONE" });
}

/** The redirect from TikTok after the owner allowed access. */
async function finishTiktok({ code, state, error }) {
  const who = checkState(state);
  if (!who) return { error: "invalid_state" };
  if (error || !code) return { error: "tiktok_denied" };
  try {
    await storeTiktok(await tiktokTokens({ code, grant_type: "authorization_code", redirect_uri: tiktokRedirect() }), who.adminId);
    return { ok: true };
  } catch (err) {
    await MarketingChannel.updateOne({ _id: "tiktok" }, { lastError: err.message.slice(0, 300) }, { upsert: true });
    return { error: "tiktok_failed" };
  }
}

async function setTiktok({ mode, privacyLevel }) {
  const update = {};
  if (mode !== undefined) {
    if (!["inbox", "direct"].includes(mode)) return { error: "invalid_mode" };
    update.mode = mode;
  }
  if (privacyLevel !== undefined) {
    if (!["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(privacyLevel)) return { error: "invalid_privacy" };
    update.privacyLevel = privacyLevel;
  }
  const c = await MarketingChannel.findOneAndUpdate({ _id: "tiktok", accessToken: { $ne: null } }, update, { new: true });
  if (!c) return { error: "not_connected" };
  return { channel: (await channelStatus()).tiktok };
}

// A TikTok refresh in flight: posting, the token job and fetchStats share it,
// so two refreshes never spend the same refresh token against each other
let tiktokRefreshing = null;

async function tiktokAccess(channel, now = Date.now()) {
  const fresh = (c) => c?.accessToken && c.expiresAt && c.expiresAt.getTime() - now > 5 * 60000;
  if (fresh(channel)) return unseal(channel.accessToken);
  if (!tiktokRefreshing) {
    tiktokRefreshing = (async () => {
      // Another caller may have refreshed since `channel` was read: its refresh token is spent
      const current = (await MarketingChannel.findById("tiktok").lean()) || channel;
      if (fresh(current)) return unseal(current.accessToken);
      const tokens = await tiktokTokens({ grant_type: "refresh_token", refresh_token: unseal(current.refreshToken) });
      await storeTiktok(tokens);
      return tokens.access_token;
    })().finally(() => {
      tiktokRefreshing = null;
    });
  }
  return tiktokRefreshing;
}

async function postTiktok(draft, channel) {
  const token = await tiktokAccess(channel);
  const res = await fetch(draft.video.url);
  if (!res.ok) throw new Error(`Video nicht ladbar (${res.status})`);
  const video = Buffer.from(await res.arrayBuffer());
  const source_info = { source: "FILE_UPLOAD", video_size: video.length, chunk_size: video.length, total_chunk_count: 1 };
  const direct = channel.mode === "direct";
  let init;
  if (direct) {
    const creator = await tt("/post/publish/creator_info/query/", token, {});
    const options = creator.privacy_level_options || [];
    const privacy = options.includes(channel.privacyLevel) ? channel.privacyLevel : options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options[0];
    if (!privacy) throw new Error("TikTok bietet keine Sichtbarkeit an");
    init = await tt("/post/publish/video/init/", token, {
      post_info: {
        title: caption(draft, "tiktok"),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        // Promotes our own app: TikTok's "your brand" disclosure
        brand_organic_toggle: true,
        is_aigc: !!draft.ai,
      },
      source_info,
    });
  } else {
    init = await tt("/post/publish/inbox/video/init/", token, { source_info });
  }
  const up = await fetch(init.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(video.length), "Content-Range": `bytes 0-${video.length - 1}/${video.length}` },
    body: video,
  });
  if (!up.ok) throw new Error(`TikTok-Upload: ${up.status}`);
  return tiktokStatus(token, init.publish_id);
}

async function tiktokStatus(token, publishId) {
  for (let i = 0; ; i++) {
    await sleep(timing.pollMs);
    const s = await tt("/post/publish/status/fetch/", token, { publish_id: publishId });
    if (s.status === "PUBLISH_COMPLETE") {
      // TikTok's field name has this spelling; a private post has no public id
      const id = (s.publicaly_available_post_id || [])[0];
      return { status: "posted", id: String(id || publishId), url: null };
    }
    if (s.status === "SEND_TO_USER_INBOX") return { status: "inbox", id: publishId, url: null };
    if (s.status === "FAILED") throw new Error(`TikTok: ${s.fail_reason || "fehlgeschlagen"}`);
    if (i >= timing.polls) return { status: "processing", id: publishId, url: null };
  }
}

// --- Scheduling and posting ---------------------------------------------------------

/** After approval: the next free slot, for every connected platform. */
async function schedule(draft, now = new Date()) {
  const channels = await connectedChannels();
  const platforms = PLATFORMS.filter((p) => channels[p] && !draft.posted?.[p]);
  if (!platforms.length) return draft;
  const at = await nextSlot(now);
  if (!at) return draft;
  const set = { scheduledAt: at };
  for (const p of platforms) {
    set[`publish.${p}.status`] = "scheduled";
    set[`publish.${p}.attempts`] = 0;
    set[`publish.${p}.error`] = null;
  }
  return AdDraft.findByIdAndUpdate(draft._id, set, { new: true });
}

/** "Jetzt posten" in the console, also to retry a failed platform. */
async function postNow(id, now = new Date()) {
  const draft = await AdDraft.findOne({ _id: id, status: { $in: ["approved", "posted"] } }).catch(() => null);
  if (!draft) return { error: "not_approved" };
  const channels = await connectedChannels();
  const set = { scheduledAt: now };
  let any = false;
  for (const p of PLATFORMS) {
    const st = draft.publish?.[p]?.status;
    if (!channels[p] || draft.posted?.[p] || ["posting", "posted", "inbox", "processing"].includes(st)) continue;
    set[`publish.${p}.status`] = "scheduled";
    set[`publish.${p}.attempts`] = 0;
    set[`publish.${p}.error`] = null;
    any = true;
  }
  if (!any) return { error: "nothing_to_post" };
  return { draft: await AdDraft.findByIdAndUpdate(id, set, { new: true }) };
}

let running = null;
/** Post everything that is due. Returns what happened, per draft and platform. */
function runDue(now = new Date()) {
  if (!running) running = postDue(now).finally(() => (running = null));
  return running;
}

async function postDue(now) {
  const channels = await connectedChannels();
  const results = [];
  // A post that never finished (process died): not retried, a person checks
  for (const p of PLATFORMS) {
    await AdDraft.updateMany(
      { [`publish.${p}.status`]: "posting", [`publish.${p}.lastTryAt`]: { $lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      { [`publish.${p}.status`]: "failed", [`publish.${p}.attempts`]: MAX_ATTEMPTS, [`publish.${p}.error`]: "Abgebrochen: bitte auf der Plattform prüfen, ob der Post erschienen ist" },
    );
  }
  const due = await AdDraft.find({
    status: { $in: ["approved", "posted"] },
    scheduledAt: { $ne: null, $lte: now },
    $or: PLATFORMS.map((p) => ({ [`publish.${p}.status`]: { $in: ["scheduled", "failed", "processing"] } })),
  })
    .sort({ scheduledAt: 1 })
    .limit(5);
  for (const draft of due) {
    for (const p of PLATFORMS) {
      const st = draft.publish?.[p] || {};
      if (!channels[p] || !["scheduled", "failed", "processing"].includes(st.status)) continue;
      if (st.status === "failed" && (st.attempts >= MAX_ATTEMPTS || now - (st.lastTryAt || 0) < RETRY_AFTER_MS)) continue;
      // Claim it, so no other run posts the same video
      const claimed = await AdDraft.findOneAndUpdate(
        { _id: draft._id, [`publish.${p}.status`]: st.status },
        { [`publish.${p}.status`]: "posting", [`publish.${p}.lastTryAt`]: now, $inc: { [`publish.${p}.attempts`]: st.status === "processing" ? 0 : 1 } },
        { new: true },
      );
      if (!claimed) continue;
      let outcome;
      try {
        outcome =
          st.status === "processing" && p === "tiktok"
            ? await tiktokStatus(await tiktokAccess(channels[p]), st.id)
            : await (p === "instagram" ? postInstagram : postTiktok)(claimed, channels[p]);
        const set = { [`publish.${p}.status`]: outcome.status, [`publish.${p}.id`]: outcome.id, [`publish.${p}.url`]: outcome.url, [`publish.${p}.error`]: null };
        if (outcome.status === "posted") {
          set[`posted.${p}`] = new Date();
          set.status = "posted";
        }
        await AdDraft.updateOne({ _id: draft._id }, set);
      } catch (err) {
        outcome = { status: "failed", error: err.message.slice(0, 300) };
        await AdDraft.updateOne({ _id: draft._id }, { [`publish.${p}.status`]: "failed", [`publish.${p}.error`]: outcome.error });
        console.error(`❌ ${p} post ${draft.campaign}:`, outcome.error);
      }
      results.push({ campaign: draft.campaign, platform: p, ...outcome });
      tellPosting(draft, p, outcome, claimed.publish?.[p]?.attempts || 0);
    }
  }
  return results;
}

const LABEL = { instagram: "Instagram", tiktok: "TikTok" };
/** Push to the owners: posted, a TikTok draft to finish, or the last attempt failed. */
function tellPosting(draft, p, outcome, attempts) {
  const { tell } = require("./adminPush");
  const base = { url: "#approvals", tag: `post-${draft.campaign}-${p}` };
  if (outcome.status === "posted") tell("posting", { ...base, title: `Auf ${LABEL[p]} gepostet`, body: `„${draft.title}“ ist online.` });
  else if (outcome.status === "inbox") tell("posting", { ...base, title: "TikTok-Entwurf wartet", body: `„${draft.title}“: in TikTok Text einfügen und veröffentlichen.` });
  else if (outcome.status === "failed" && attempts >= MAX_ATTEMPTS) tell("posting", { ...base, title: `Posten auf ${LABEL[p]} fehlgeschlagen`, body: `„${draft.title}“: ${outcome.error || "unbekannter Fehler"}`, urgency: "high" });
}

/** Keep the tokens alive: Instagram 60 days (refresh at 30 left), TikTok refresh token. */
async function refreshTokens(now = new Date()) {
  const channels = await connectedChannels();
  const done = [];
  const ch = channels.instagram;
  if (ch && ch.expiresAt && ch.expiresAt - now < 30 * DAY) {
    try {
      const data = await ig(`/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(unseal(ch.accessToken))}`);
      await MarketingChannel.updateOne({ _id: "instagram" }, { accessToken: seal(data.access_token), expiresAt: new Date(now.getTime() + (data.expires_in || 60 * 86400) * 1000), lastError: null, updatedAt: now });
      done.push("instagram");
    } catch (err) {
      await MarketingChannel.updateOne({ _id: "instagram" }, { lastError: `Token-Erneuerung: ${err.message.slice(0, 200)}` });
    }
  }
  const tk = channels.tiktok;
  if (tk && tk.expiresAt && tk.expiresAt - now < 6 * 3600 * 1000) {
    try {
      await tiktokAccess(tk, now.getTime());
      done.push("tiktok");
    } catch (err) {
      await MarketingChannel.updateOne({ _id: "tiktok" }, { lastError: `Token-Erneuerung: ${err.message.slice(0, 200)}` });
    }
  }
  return done;
}

// --- Performance (plan 2.14) --------------------------------------------------------

// Posts younger than this are measured; older ones keep their last numbers
const STATS_DAYS = 30;
// Instagram's Reels metrics; "views" replaced "plays" for Reels in 2025.
// Older API versions refuse "views": then the same with "plays"
const IG_METRICS = ["views", "reach", "likes", "shares", "saved", "comments"];
const IG_FALLBACK = ["plays", "reach", "likes", "shares", "saved", "comments"];
// TikTok's video query takes at most 20 ids per call
const TT_BATCH = 20;
// Graph API: (#10) / (#200) are missing permissions, here instagram_business_manage_insights
const IG_PERMISSION = /permission|\(#10\)|\(#200\)/i;
const count = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.max(0, Math.round(Number(v))) : null);

/** One Reel's insights as { plays, reach, likes, shares, saved, comments }. */
async function instagramInsights(mediaId, token) {
  let data;
  try {
    data = await ig(`/${mediaId}/insights?metric=${IG_METRICS.join(",")}&access_token=${encodeURIComponent(token)}`);
  } catch (err) {
    if (!/metric/i.test(err.message)) throw err;
    data = await ig(`/${mediaId}/insights?metric=${IG_FALLBACK.join(",")}&access_token=${encodeURIComponent(token)}`);
  }
  // { data: [{ name, values: [{ value }] }] }, newer versions { name, total_value: { value } }
  const by = Object.fromEntries((data.data || []).map((m) => [m.name, m.total_value?.value ?? m.values?.[0]?.value]));
  return {
    plays: count(by.views ?? by.plays),
    reach: count(by.reach),
    likes: count(by.likes),
    shares: count(by.shares),
    saved: count(by.saved),
    comments: count(by.comments),
  };
}

/** View counts of our own TikTok videos by id: Map id → { views, likes, comments, shares }. */
async function tiktokVideos(ids, token) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += TT_BATCH) {
    const data = await tt("/video/query/?fields=id,view_count,like_count,comment_count,share_count", token, { filters: { video_ids: ids.slice(i, i + TT_BATCH) } });
    for (const v of data.videos || []) {
      out.set(String(v.id), { views: count(v.view_count), likes: count(v.like_count), comments: count(v.comment_count), shares: count(v.share_count) });
    }
  }
  return out;
}

/**
 * Read the numbers of every video posted through the API in the last 30
 * days (leader job every 6 hours, index.js) into AdDraft.stats. A video
 * posted by hand has no platform id and stays without numbers; a TikTok
 * post still in the inbox or private (the publish id, not a video id)
 * too. A failure is logged per video (or per TikTok batch) and the rest
 * goes on; nothing here touches posting. Returns { instagram, tiktok,
 * failed }: how many videos got fresh numbers, and how many could not.
 */
async function fetchStats(now = new Date()) {
  const channels = await connectedChannels();
  const since = new Date(now.getTime() - STATS_DAYS * DAY);
  const result = { instagram: 0, tiktok: 0, failed: 0 };

  if (channels.instagram) {
    const drafts = await AdDraft.find({ "posted.instagram": { $gte: since }, "publish.instagram.status": "posted", "publish.instagram.id": { $ne: null } }, { campaign: 1, "publish.instagram.id": 1 }).lean();
    const token = drafts.length ? unseal(channels.instagram.accessToken) : null;
    let firstError = null;
    for (const d of drafts) {
      try {
        const stats = await instagramInsights(d.publish.instagram.id, token);
        await AdDraft.updateOne({ _id: d._id }, { $set: { "stats.instagram": { ...stats, at: now } } });
        result.instagram++;
      } catch (err) {
        result.failed++;
        // The missing permission says the most; else the first error
        if (!firstError || IG_PERMISSION.test(err.message)) firstError = err.message;
        console.error(`❌ instagram stats ${d.campaign}:`, err.message.slice(0, 200));
      }
    }
    // One reel deleted on Instagram is no news; none readable at all is (most often the missing permission)
    if (result.instagram) await statsError("instagram", null);
    else if (firstError) await statsError("instagram", firstError);
  }

  if (channels.tiktok) {
    const drafts = await AdDraft.find({ "posted.tiktok": { $gte: since }, "publish.tiktok.status": "posted", "publish.tiktok.id": /^\d+$/ }, { campaign: 1, "publish.tiktok.id": 1 }).lean();
    if (drafts.length) {
      try {
        const videos = await tiktokVideos(drafts.map((d) => d.publish.tiktok.id), await tiktokAccess(channels.tiktok, now.getTime()));
        for (const d of drafts) {
          const stats = videos.get(d.publish.tiktok.id);
          if (!stats) {
            // Deleted on TikTok, or not visible to the API (yet)
            result.failed++;
            continue;
          }
          await AdDraft.updateOne({ _id: d._id }, { $set: { "stats.tiktok": { ...stats, at: now } } });
          result.tiktok++;
        }
        await statsError("tiktok", null);
      } catch (err) {
        // Most often a connection from before scope video.list: reconnect once in the console
        result.failed += drafts.length;
        console.error("❌ tiktok stats:", err.message.slice(0, 200));
        await statsError("tiktok", err.message);
      }
    }
  }
  return result;
}

// What the console shows when the numbers cannot be read: the channel's
// lastError (channelStatus), marked "Zahlen:" so posting and token errors
// keep the line and the next good reading clears only its own message
const STATS_ERROR = /^Zahlen:/;
function statsErrorText(platform, message) {
  const m = String(message || "");
  if (platform === "instagram" && IG_PERMISSION.test(m))
    return "Zahlen: Instagram verweigert die Insights. Erzeuge den Token mit der Berechtigung instagram_business_manage_insights neu und trag ihn hier ein.";
  if (platform === "tiktok" && /scope/i.test(m)) return "Zahlen: TikTok fehlt das Recht video.list. Trenne den Kanal einmal und verbinde ihn neu.";
  return `Zahlen: ${m.slice(0, 200)}`;
}

/** Set (message) or clear (null) the stats line on a channel, never over another error. */
async function statsError(platform, message) {
  try {
    if (message === null) await MarketingChannel.updateOne({ _id: platform, lastError: STATS_ERROR }, { $set: { lastError: null } });
    else await MarketingChannel.updateOne({ _id: platform, $or: [{ lastError: null }, { lastError: STATS_ERROR }] }, { $set: { lastError: statsErrorText(platform, message) } });
  } catch (err) {
    console.error(`❌ ${platform} stats error note:`, err.message);
  }
}

// How often the numbers are read; the job checks every 30 minutes and the
// last reading is stored, so deploys (every one restarts the timers) never
// postpone it for good
const STATS_EVERY_MS = 6 * 3600 * 1000;

/**
 * fetchStats() at most once per 6 hours (leader job post-stats, index.js):
 * claims the reading with a conditional update of MarketingTally "runs"
 * lastStatsAt, so a restart or a second instance never reads twice. Returns
 * fetchStats()'s result, or null when the last reading is younger.
 */
async function statsDue(now = new Date()) {
  const MarketingTally = require("../models/MarketingTally");
  try {
    await MarketingTally.updateOne({ _id: "runs" }, { $setOnInsert: { lastStatsAt: null } }, { upsert: true });
  } catch (err) {
    // Two upserts at once: the other one created it
    if (err.code !== 11000) throw err;
  }
  const claimed = await MarketingTally.updateOne(
    { _id: "runs", $or: [{ lastStatsAt: null }, { lastStatsAt: { $lte: new Date(now.getTime() - STATS_EVERY_MS) } }] },
    { $set: { lastStatsAt: now } }
  );
  if (!claimed.modifiedCount) return null;
  return fetchStats(now);
}

module.exports = {
  PLATFORMS,
  STATS_DAYS,
  STATS_EVERY_MS,
  fetchStats,
  statsDue,
  timing,
  slots,
  atLocal,
  nextSlot,
  channelStatus,
  connectInstagram,
  tiktokAuthorizeUrl,
  finishTiktok,
  setTiktok,
  disconnect,
  schedule,
  postNow,
  runDue,
  refreshTokens,
  checkState,
  tiktokState,
};
