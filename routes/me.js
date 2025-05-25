const express = require("express");
const router = express.Router();
const User = require("../models/User");

function normalizePhone(phone) {
  return phone
    .trim()
    .replace(/^00/, "+")
    .replace(/^(\s*)/, "")
    .replace(/^(?!\+)/, "+");
}

// GET /me?phone=...
router.get("/", async (req, res) => {
  let { phone } = req.query;
  if (!phone)
    return res
      .status(400)
      .json({ success: false, error: "Phone number required" });

  phone = normalizePhone(phone);
  console.log("📞 Normalized phone:", phone);

  try {
    const user = await User.findOne({ phone });
    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    res.json({
      success: true,
      user: {
        phone: user.phone,
        name: user.name || "",
        avatarUrl: user.avatarUrl || "",
        lastOnline: user.lastOnline || null, // ✅ hinzugefügt
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /me/update
router.post("/update", async (req, res) => {
  let { phone, name, avatarUrl } = req.body;
  if (!phone)
    return res
      .status(400)
      .json({ success: false, error: "Phone number is required" });

  phone = normalizePhone(phone);
  try {
    const user = await User.findOneAndUpdate(
      { phone },
      { name, avatarUrl },
      { new: true, upsert: false },
    );

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    res.json({
      success: true,
      user: {
        phone: user.phone,
        name: user.name || "",
        avatarUrl: user.avatarUrl || "",
        lastOnline: user.lastOnline || null, // ✅ optional auch hier mitliefern
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
