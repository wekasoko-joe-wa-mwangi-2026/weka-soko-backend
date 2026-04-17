
const express = require("express");
const router = express.Router();
const { query, withTransaction } = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { sendNotification } = require("../services/notification.service");
const { ConcurrencyError } = require("../services/concurrency.service");

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
// Uses optimistic locking to prevent race conditions
router.post("/:id/release", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { version } = req.body;
    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND status = ANY($2)`,
      [id, ["holding", "disputed"]]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });
    const escrow = rows[0];

    if (version !== undefined && version !== escrow.version) {
      return res.status(409).json({
        error: "Escrow was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: escrow.version
      });
    }

    const result = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE escrows SET status = 'released', released_at = NOW(), released_by = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING *`,
        [req.user.id, id, escrow.version]
      );

      if (!updateResult.rowCount) {
        throw new ConcurrencyError("Escrow was modified by another request. Please refresh.", "OPTIMISTIC_LOCK_FAILED");
      }

      await client.query(
        `UPDATE listings SET status = 'sold', version = version + 1 WHERE id = $1`,
        [escrow.listing_id]
      );
      await sendNotification(escrow.seller_id, "escrow_released", " Funds Released!", `Admin has released funds for ${escrow.listing_title}.`);
      return updateResult.rows[0];
    });

    res.json({ message: "Escrow funds released to seller." });
  } catch (err) {
    if (err.code === "OPTIMISTIC_LOCK_FAILED") return res.status(409).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── POST /api/admin/escrows/:id/refund ─────────────────────────────────────
// Admin manually refunds funds to buyer
// Uses optimistic locking to prevent race conditions
router.post("/:id/refund", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { version } = req.body;
    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND status = ANY($2)`,
      [id, ["holding", "disputed"]]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });
    const escrow = rows[0];

    if (version !== undefined && version !== escrow.version) {
      return res.status(409).json({
        error: "Escrow was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: escrow.version
      });
    }

    const result = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE escrows SET status = 'refunded', refunded_at = NOW(), refunded_by = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING *`,
        [req.user.id, id, escrow.version]
      );

      if (!updateResult.rowCount) {
        throw new ConcurrencyError("Escrow was modified by another request. Please refresh.", "OPTIMISTIC_LOCK_FAILED");
      }

      await sendNotification(escrow.buyer_id, "escrow_refunded", " Escrow Refunded", `Admin has refunded funds for ${escrow.listing_title}.`);
      return updateResult.rows[0];
    });

    res.json({ message: "Escrow funds refunded to buyer." });
  } catch (err) {
    if (err.code === "OPTIMISTIC_LOCK_FAILED") return res.status(409).json({ error: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
