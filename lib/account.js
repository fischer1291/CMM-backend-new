/**
 * Deleting an account (App Store guideline 5.1.1(v), GDPR Art. 17) and
 * exporting its data (GDPR Art. 15/20).
 */
const cloudinary = require("cloudinary").v2;
const User = require("../models/User");
const Call = require("../models/Call");
const Talk = require("../models/Talk");
const Nudge = require("../models/Nudge");
const CallMoment = require("../models/CallMoment");
const MomentUnlock = require("../models/MomentUnlock");
const SubscriptionEvent = require("../models/SubscriptionEvent");
const PushLog = require("../models/PushLog");
const PushDecision = require("../models/PushDecision");
const PushTicket = require("../models/PushTicket");
const Block = require("../models/Block");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const Invite = require("../models/Invite");
const Circle = require("../models/Circle");
const Room = require("../models/Room");
const ActiveDay = require("../models/ActiveDay");
const revenuecat = require("./revenuecat");

const cloudinaryConfigured = () => !!process.env.CLOUDINARY_API_SECRET;

/** Cloudinary public id of an uploaded image URL, or null for other URLs. */
function publicIdOf(url) {
  const match = /res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?((?:moments|avatars)\/[^.]+)\.\w+$/.exec(url || "");
  return match ? match[1] : null;
}

/** The user's avatar and the pictures of the given moments on Cloudinary. */
async function deleteImages(phone, moments) {
  if (!cloudinaryConfigured()) return;
  const ids = [`avatars/avatar_${phone.replace("+", "")}`, ...moments.map((m) => publicIdOf(m.screenshot))].filter(Boolean);
  await Promise.allSettled(ids.map((id) => cloudinary.uploader.destroy(id)));
}

/**
 * The keys under which the person's activity rows may be stored: the stored
 * HMAC, the HMAC computed now, and the SHA-256 of rows from before plan 2.8
 * that no migration reached.
 */
const activityKeys = (user) => [...new Set([user.phoneHmac, User.hmacPhone(user.phone), User.hashPhone(user.phone)].filter(Boolean))];

/**
 * RevenueCat forgets the subscriber too (REST DELETE, lib/revenuecat.js).
 * Not awaited by the caller and only logged when it fails: the deletion of
 * the account never waits for a third party; the owner sees the error in
 * the logs and deletes by hand.
 */
function forgetSubscriber(user) {
  if (!revenuecat.configured()) return;
  revenuecat.deleteSubscriber(String(user._id)).catch((err) => {
    console.error(`❌ RevenueCat subscriber ${user._id} not deleted:`, err.message);
  });
}

/**
 * Removes the user and everything that belongs to them. Moments they are
 * part of are deleted (the picture shows them, whoever shared it); their
 * reactions on other moments are removed. Other users keep no trace of the
 * number (contacts, sharing lists). Pseudonymous rows (ActiveDay) go by the
 * hash keys of the number, and RevenueCat forgets the subscriber.
 */
async function deleteAccount(phone, io) {
  const user = await User.findOne({ phone });
  if (!user) return false;

  // Contacts see the user go offline before they disappear
  const followers = await User.find({ contacts: phone }, "phone");
  if (followers.length) {
    io?.to(followers.map((f) => `user:${f.phone}`)).emit("statusUpdate", {
      phone,
      isAvailable: false,
      lastOnline: new Date(),
      mood: null,
      availableUntil: null,
    });
  }

  // Reactions on other people's moments
  const reacted = await CallMoment.find({ "reactions.users.phone": phone });
  for (const moment of reacted) {
    for (const reaction of moment.reactions) {
      const before = reaction.users.length;
      reaction.users = reaction.users.filter((u) => u.phone !== phone);
      reaction.count -= before - reaction.users.length;
    }
    moment.reactions = moment.reactions.filter((r) => r.count > 0);
    await moment.save();
  }

  // Older moments may store the number without "+"
  const ownMoments = {
    $or: [phone, phone.replace("+", "")].flatMap((p) => [{ userPhone: p }, { targetPhone: p }]),
  };
  const moments = await CallMoment.find(ownMoments, "screenshot").lean();

  forgetSubscriber(user);
  await Promise.all([
    CallMoment.deleteMany(ownMoments),
    Call.deleteMany({ $or: [{ caller: phone }, { callee: phone }] }),
    Talk.deleteMany({ participants: phone }),
    MomentUnlock.deleteMany({ phone }),
    ActiveDay.deleteMany({ who: { $in: activityKeys(user) } }),
    Nudge.deleteMany({ $or: [{ from: phone }, { to: phone }] }),
    PushLog.deleteMany({ to: phone }),
    PushDecision.deleteMany({ $or: [{ to: phone }, { about: phone }] }),
    Block.deleteMany({ $or: [{ blocker: phone }, { blocked: phone }] }),
    Report.deleteMany({ $or: [{ reporter: phone }, { reported: phone }] }),
    SupportTicket.deleteMany({ phone }),
    Invite.deleteMany({ $or: [{ from: phone }, { toHash: user.phoneHash }] }),
    Circle.updateMany(
      { $or: [{ "members.phone": phone }, { "invites.phone": phone }, { "invites.hash": user.phoneHash }] },
      { $pull: { members: { phone }, invites: { $or: [{ phone }, { hash: user.phoneHash }] } } },
    ),
    Room.updateMany({ "participants.phone": phone }, { $pull: { participants: { phone } } }),
    user.pushToken ? PushTicket.deleteMany({ token: user.pushToken }) : null,
    User.updateMany(
      { $or: [{ contacts: phone }, { connections: phone }, { "statsSharing.sharedWith": phone }] },
      { $pull: { contacts: phone, connections: phone, "statsSharing.sharedWith": phone, "circles.$[].members": phone } },
    ),
    deleteImages(phone, moments).catch((err) => console.error("❌ Cloudinary cleanup:", err.message)),
  ]);
  // Circles nobody is left in; the creator's rights go to the next member
  await Circle.deleteMany({ members: { $size: 0 } });
  const created = await Circle.find({ createdBy: phone });
  for (const c of created) {
    c.createdBy = c.members[0].phone;
    await c.save();
  }
  await User.deleteOne({ phone });

  // Sign out every device of the user
  io?.in(`user:${phone}`).disconnectSockets(true);
  return true;
}

/** Everything stored about the user, as plain JSON. */
async function exportAccount(phone) {
  const user = await User.findOne({ phone }).lean();
  if (!user) return null;
  const [moments, talks, calls, nudges, circles, tickets, subscriptions, activeDays] = await Promise.all([
    CallMoment.find({ $or: [{ userPhone: phone }, { targetPhone: phone }] }).lean(),
    Talk.find({ participants: phone }).lean(),
    Call.find({ $or: [{ caller: phone }, { callee: phone }] }).lean(),
    Nudge.find({ $or: [{ from: phone }, { to: phone }] }).lean(),
    Circle.find({ "members.phone": phone }).lean(),
    SupportTicket.find({ phone }).lean(),
    // RevenueCat's app user id is our user id (routes/plus.js)
    SubscriptionEvent.find({ $or: [{ userId: user._id }, { appUserId: String(user._id) }] }).sort({ eventAt: 1 }).lean(),
    ActiveDay.find({ who: { $in: activityKeys(user) } }, { day: 1 }).sort({ day: 1 }).lean(),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      phone: user.phone,
      name: user.name || "",
      avatarUrl: user.avatarUrl || null,
      timezone: user.timezone || null,
      locale: user.locale || null,
      inviteCode: user.inviteCode || null,
      isAvailable: user.isAvailable,
      lastOnline: user.lastOnline,
    },
    settings: {
      notifications: user.notificationPrefs || null,
      schedule: user.schedule || null,
      statsSharing: user.statsSharing || null,
    },
    // Registered people from your address book that the app matched
    contacts: user.contacts || [],
    // People you got connected with through an invite
    connections: user.connections || [],
    devices: {
      pushNotifications: !!user.pushToken,
      voipCalls: !!user.voipToken,
    },
    moments: moments.map((m) => ({
      sharedBy: m.userPhone,
      with: m.targetPhone,
      note: m.note,
      mood: m.mood,
      callDuration: m.callDuration,
      image: m.screenshot.startsWith("data:") ? "(Bild in der Datenbank)" : m.screenshot,
      reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count })),
      at: m.timestamp,
    })),
    conversations: talks.map((t) => ({
      with: t.participants.find((p) => p !== phone) || null,
      startedAt: t.startedAt,
      seconds: t.seconds,
    })),
    calls: calls.map((c) => ({
      direction: c.caller === phone ? "outgoing" : "incoming",
      other: c.caller === phone ? c.callee : c.caller,
      status: c.status,
      createdAt: c.createdAt,
      acceptedAt: c.acceptedAt || null,
      endedAt: c.endedAt || null,
    })),
    nudges: nudges.map((n) => ({ from: n.from, to: n.to, at: n.createdAt })),
    circles: circles.map((c) => ({
      name: c.name,
      emoji: c.emoji,
      founder: c.createdBy === phone,
      members: c.members.map((m) => m.phone),
      joinedAt: c.members.find((m) => m.phone === phone)?.joinedAt || null,
    })),
    app: user.app || null,
    badges: { showcase: user.showcase || [] },
    // When each onboarding step was reached, see README "Onboarding milestones"
    milestones: {
      verifiedAt: user.milestones?.verifiedAt || null,
      contactsSyncedAt: user.milestones?.contactsSyncedAt || null,
      firstRegisteredContactAt: user.milestones?.firstRegisteredContactAt || null,
      pushGrantedAt: user.milestones?.pushGrantedAt || null,
      firstCallAt: user.milestones?.firstCallAt || null,
      firstTalkAt: user.milestones?.firstTalkAt || null,
      firstInviteAt: user.firstInviteAt || null,
    },
    // The research invitation and the person's answer, see README "User research"
    research: {
      invitedAt: user.research?.invitedAt || null,
      bookedAt: user.research?.bookedAt || null,
      dismissedAt: user.research?.dismissedAt || null,
      doneAt: user.research?.doneAt || null,
    },
    support: tickets.map((t) => ({ category: t.category, status: t.status, messages: t.messages.map(({ from, text, at }) => ({ from, text, at })), createdAt: t.createdAt })),
    // What the person agreed to in onboarding (plan 1.6, COMPLIANCE.md)
    consent: {
      ageConfirmedAt: user.consent?.ageConfirmedAt || null,
      termsVersion: user.consent?.termsVersion || null,
      privacyVersion: user.consent?.privacyVersion || null,
    },
    // Wanna yap+ and the subscription events the store sent for this person
    // (README "Subscriptions"); they stay after a deletion as proof of the
    // purchases, see COMPLIANCE.md
    plus: {
      active: !!user.plus?.active,
      until: user.plus?.until || null,
      since: user.plus?.since || null,
      source: user.plus?.source || null,
      productId: user.plus?.productId || null,
      status: user.plus?.status || null,
    },
    // Days the app was used (ActiveDay, kept 400 days under a keyed hash of
    // the number, COMPLIANCE.md); nothing but the dates
    activeDays: [...new Set(activeDays.map((a) => a.day))],
    subscriptions: subscriptions.map((e) => ({
      type: e.type,
      productId: e.productId,
      store: e.store,
      environment: e.environment,
      periodType: e.periodType,
      priceCents: e.priceCents,
      currency: e.currency,
      priceInPurchasedCurrencyCents: e.priceInPurchasedCurrencyCents,
      cancelReason: e.cancelReason,
      purchasedAt: e.purchasedAt,
      expirationAt: e.expirationAt,
      eventAt: e.eventAt,
    })),
  };
}

module.exports = { deleteAccount, exportAccount, publicIdOf };
