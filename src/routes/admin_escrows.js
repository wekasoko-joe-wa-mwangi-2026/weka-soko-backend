
const express = require("express");
const router = express.Router();
const { query, withTransaction } = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { sendNotification } = require("../services/notification.service");

// ── GET /api/admin/escrows ──────────────────────────────────────────────────
// Admin gets all escrows, including disputed ones
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, b.name AS buyer_name, s.name AS seller_name, l.title AS listing_title
       FROM escrows e
       JOIN users b ON e.buyer_id = b.id
       JOIN users s ON e.seller_id = s.id
       JOIN listings l ON e.listing_id = l.id
       ORDER BY e.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/escrows/:id/release ─────────────────────────────────────
// Admin manually releases funds to seller
router.post("/:id/release", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND status = ANY($2)`,
      [id, ["holding", "disputed"]]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE escrows SET status = 'released', released_at = NOW(), released_by = $1 WHERE id = $2`,
        [req.user.id, id]
      );
      await client.query(
        `UPDATE listings SET status = 'sold' WHERE id = $1`,
        [rows[0].listing_id]
      );
      // Notify seller
      await sendNotification(rows[0].seller_id, "escrow_released", "💰 Funds Released!", `Admin has released funds for ${rows[0].listing_title}.`);
    });
    res.json({ message: "Escrow funds released to seller." });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/escrows/:id/refund ──────────────────────────────────────
// Admin manually refunds funds to buyer
router.post("/:id/refund", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND status = ANY($2)`,
      [id, ["holding", "disputed"]]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE escrows SET status = 'refunded', refunded_at = NOW(), refunded_by = $1 WHERE id = $2`,
        [req.user.id, id]
      );
      // Notify buyer
      await sendNotification(rows[0].buyer_id, "escrow_refunded", "💸 Escrow Refunded", `Admin has refunded funds for ${rows[0].listing_title}.`);
    });
    res.json({ message: "Escrow funds refunded to buyer." });
  } catch (err) {
    next(err};
  }
});

module.exports = router;
