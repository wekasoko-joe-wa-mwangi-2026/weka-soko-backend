const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");

// Get all chat violations (admin only)
router.get("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { status = "pending" } = req.query;
    const { rows } = await query(
      `SELECT
        cv.id, cv.sender_id, cv.chat_thread_id, cv.message_content, cv.violation_type, cv.reason, cv.status, cv.created_at,
        u.name AS sender_name, u.email AS sender_email,
        l.title AS listing_title,
        ct.buyer_id, ct.seller_id
       FROM chat_violations cv
       JOIN users u ON cv.sender_id = u.id
       JOIN chat_threads ct ON cv.chat_thread_id = ct.id
       JOIN listings l ON ct.listing_id = l.id
       WHERE cv.status = $1
       ORDER BY cv.created_at DESC`,
      [status]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Resolve or dismiss a chat violation (admin only)
router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // \'resolve\' or \'dismiss\'

    if (!["resolve", "dismiss"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const newStatus = action === "resolve" ? "resolved" : "dismissed";

    const { rows } = await query(
      `UPDATE chat_violations
       SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3 RETURNING *`,
      [newStatus, req.user.id, id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Chat violation not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
