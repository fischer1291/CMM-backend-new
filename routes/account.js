/**
 * DELETE /me: delete the account and all its data.
 * GET /me/export: everything stored about the user, as JSON.
 */
const express = require("express");
const { deleteAccount, exportAccount } = require("../lib/account");

module.exports = (io) => {
  const router = express.Router();
  const requireAuth = (req, res, next) =>
    req.auth ? next() : res.status(401).json({ success: false, error: "Authentication required" });

  router.delete("/me", requireAuth, async (req, res) => {
    try {
      const deleted = await deleteAccount(req.auth.phone, io);
      if (!deleted) return res.status(404).json({ success: false, error: "User not found" });
      console.log("🗑️ Account deleted");
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Account deletion failed:", err.message);
      res.status(500).json({ success: false, error: "Konto konnte nicht gelöscht werden" });
    }
  });

  router.get("/me/export", requireAuth, async (req, res) => {
    const data = await exportAccount(req.auth.phone);
    if (!data) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, data });
  });

  return router;
};
