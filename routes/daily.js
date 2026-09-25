/**
 * GET /daily: is the daily Call Me Moment running, am I in, who else is?
 * POST /daily/join { mood? }: I'm in: available until the moment ends.
 */
const express = require("express");
const User = require("../models/User");
const DailyMoment = require("../models/DailyMoment");
const { activeMomentFor } = require("../lib/dailyMoment");
const { broadcastStatus } = require("./status");

/** Joiners stay available a little after the window, to finish the call they started */
const AFTER_MS = 5 * 60 * 1000;

module.exports = (io) => {
  const router = express.Router();
  router.use("/daily", (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" }),
  );

  router.get("/daily", async (req, res) => {
    const me = await User.findOne({ phone: req.auth.phone });
    if (!me) return res.status(404).json({ success: false });
    const moment = await activeMomentFor(me);
    if (!moment) return res.json({ success: true, active: false });

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
