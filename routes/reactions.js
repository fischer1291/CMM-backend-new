const express = require("express");
const router = express.Router();
const CallMoment = require("../models/CallMoment");

// POST /moment/react - Add or remove a reaction
router.post("/react", async (req, res) => {
  try {
    const { momentId, userPhone, emoji } = req.body;

    // Validation
    if (!momentId || !userPhone || !emoji) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: momentId, userPhone, emoji",
      });
    }

    // Valid emojis
    const validEmojis = ["❤️", "😂", "😮", "😢", "😍", "👏"];
    if (!validEmojis.includes(emoji)) {
      return res.status(400).json({
        success: false,
        message: "Invalid emoji",
      });
    }

    // Find the call moment
    const callMoment = await CallMoment.findById(momentId);
    if (!callMoment) {
      return res.status(404).json({
        success: false,
        message: "Call moment not found",
      });
    }

    // Find existing reaction for this emoji
    let reactionIndex = callMoment.reactions.findIndex(
      (r) => r.emoji === emoji,
    );

    if (reactionIndex === -1) {
      // Create new reaction
      callMoment.reactions.push({
        emoji,
        users: [{ phone: userPhone }],
        count: 1,
      });
    } else {
      // Check if user already reacted
      const reaction = callMoment.reactions[reactionIndex];
      const userIndex = reaction.users.findIndex((u) => u.phone === userPhone);

      if (userIndex === -1) {
        // Add user reaction
        reaction.users.push({ phone: userPhone });
        reaction.count += 1;
      } else {
        // Remove user reaction
        reaction.users.splice(userIndex, 1);
        reaction.count -= 1;

        // Remove reaction if count is 0
        if (reaction.count === 0) {
          callMoment.reactions.splice(reactionIndex, 1);
        }
      }
    }

    await callMoment.save();

    // Format reactions for response
    const formattedReactions = callMoment.reactions.map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.count,
      userReacted: reaction.users.some((u) => u.phone === userPhone),
    }));

    res.json({
      success: true,
      reactions: formattedReactions,
      totalReactions: callMoment.totalReactions,
    });
  } catch (error) {
    console.error("Reaction error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
