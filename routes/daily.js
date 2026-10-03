/**
 * GET /daily: is the daily Yap Moment running, am I in, who else is, and
 * (plan 2.13) when does today's start, for the countdown?
 * POST /daily/join { mood? }: I'm in: available until the moment ends.
 */
const express = require("express");
const { noteUnlock } = require("../lib/unlock");
const User = require("../models/User");
const DailyMoment = require("../models/DailyMoment");
const { activeMomentFor, momentFor, zoneOf } = require("../lib/dailyMoment");
const { broadcastStatus } = require("./status");

/** Joiners stay available a little after the window, to finish the call they started */
const AFTER_MS = 5 * 60 * 1000;

module.exports = (io) => {
  const router = express.Router();
  router.use("/daily", (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" }),
  );

  /**
   * Today's moment of the user's zone while it is still ahead (plan 2.13):
   * { nextAt, nextEndsAt }, both null once it runs or is over, and for a
   * moment created after 21:00 (sentAt set, it never fires). momentFor
   * creates the day's moment when the minute tick has not yet; a failure
   * only costs the countdown.
   */
  async function upcoming(me, now) {
    try {
      const today = await momentFor(zoneOf(me), now);
      if (!today.sentAt && today.at > now) return { nextAt: today.at, nextEndsAt: today.endsAt };
    } catch (err) {
      console.error("❌ daily nextAt:", err.message);
    }
    return { nextAt: null, nextEndsAt: null };
  }

  router.get("/daily", async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    const now = new Date();
    const moment = await activeMomentFor(me, now);
    if (!moment) return res.json({ success: true, active: false, ...(await upcoming(me, now)) });

    // Contacts who joined and are still available
    const joined = moment.joined.filter((p) => p !== me.phone && me.contacts.includes(p));
    const available = await User.find({ phone: { $in: joined }, isAvailable: true }, "phone").lean();
    res.json({
      success: true,
      active: true,
      startedAt: moment.at,
      endsAt: moment.endsAt,
      joined: moment.joined.includes(me.phone),
      participants: available.map((u) => u.phone),
      nextAt: null,
      nextEndsAt: null,
    });
  });

  router.post("/daily/join", async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    const moment = await activeMomentFor(me);
    if (!moment) return res.status(409).json({ success: false, error: "not_active" });

    const fast = Date.now() - moment.at.getTime() <= 60 * 1000;
    await DailyMoment.updateOne(
      { _id: moment._id },
      { $addToSet: fast ? { joined: me.phone, fast: me.phone } : { joined: me.phone } },
    );
    // Joining the Yap Moment unlocks the day's moments
    await noteUnlock(me, "daily");
    const wasAvailable = me.isAvailable;
    me.isAvailable = true;
    me.availableSource = "daily";
    me.lastOnline = new Date();
    me.mood = typeof req.body?.mood === "string" ? req.body.mood.slice(0, 20) : me.mood;
    const until = new Date(moment.endsAt.getTime() + AFTER_MS);
    if (!me.momentActiveUntil || me.momentActiveUntil < until) me.momentActiveUntil = until;
    await me.save();

    // Everyone already got the daily push: live update only, no extra pushes
    broadcastStatus(io, me, { becameAvailable: false }).catch(() => {});
    res.json({ success: true, endsAt: moment.endsAt, availableUntil: me.momentActiveUntil, wasAvailable });
  });

  return router;
};
