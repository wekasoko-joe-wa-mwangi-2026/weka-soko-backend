// src/routes/admin.js
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const [listings, users, payments, violations, escrows, disputes] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'sold') AS sold,
        COUNT(*) FILTER (WHERE status = 'locked') AS locked,
        COUNT(*) AS total
        FROM listings`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE role = 'seller') AS sellers,
        COUNT(*) FILTER (WHERE role = 'buyer') AS buyers,
        COUNT(*) FILTER (WHERE is_suspended = TRUE) AS suspended
        FROM users`),
      query(`SELECT
        COUNT(*) FILTER (WHERE type = 'unlock' AND status = 'confirmed') AS unlock_count,
        SUM(amount_kes) FILTER (WHERE type = 'unlock' AND status = 'confirmed') AS unlock_revenue,
        SUM(amount_kes) FILTER (WHERE type = 'escrow' AND status = 'confirmed') AS escrow_volume,
        COUNT(*) FILTER (WHERE type = 'escrow' AND status = 'confirmed') AS escrow_count
        FROM payments`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE severity = 'warning') AS warnings,
        COUNT(*) FILTER (WHERE severity = 'flagged') AS flagged,
        COUNT(*) FILTER (WHERE severity = 'suspended') AS suspended,
        COUNT(*) FILTER (WHERE reviewed = FALSE) AS unreviewed
        FROM chat_violations`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'holding') AS active FROM escrows`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'open') AS open FROM disputes`),
    ]);

    res.json({
      listings: listings.rows[0],
      users: users.rows[0],
      payments: payments.rows[0],
      violations: violations.rows[0],
      escrows: escrows.rows[0],
      disputes: disputes.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/violations ─────────────────────────────────────────────────
router.get("/violations", async (req, res, next) => {
  try {
    const { reviewed, severity } = req.query;
    const conditions = [];
    const params = [];

    if (reviewed !== undefined) {
      params.push(reviewed === "true");
      conditions.push(`cv.reviewed = $${params.length}`);
    }
    if (severity) {
      params.push(severity);
      conditions.push(`cv.severity = $${params.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows } = await query(
      `SELECT cv.*, u.name AS user_name, u.email AS user_email, u.anon_tag, u.violation_count,
              l.title AS listing_title
       FROM chat_violations cv
       JOIN users u ON u.id = cv.user_id
       LEFT JOIN listings l ON l.id = cv.listing_id
       ${where}
       ORDER BY cv.created_at DESC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/violations/:id/review ─────────────────────────────────────
router.post("/violations/:id/review", async (req, res, next) => {
  try {
    const { action } = req.body; // "dismiss" | "warn" | "suspend"
    const { id } = req.params;

    const { rows } = await query(`SELECT * FROM chat_violations WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Violation not found" });

    const v = rows[0];
    await query(`UPDATE chat_violations SET reviewed = TRUE WHERE id = $1`, [id]);

    if (action === "suspend") {
      await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [v.user_id]);
    } else if (action === "warn") {
      await query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, 'warning', '⚠️ Account Warning', 'You have received a warning for attempting to share contact information in chat. Further violations will result in suspension.')`,
        [v.user_id]
      );
    }

    res.json({ message: `Violation ${action}d` });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/escrows ────────────────────────────────────────────────────
router.get("/escrows", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*,
        l.title AS listing_title,
        buyer.name AS buyer_name, buyer.email AS buyer_email, buyer.phone AS buyer_phone,
        seller.name AS seller_name, seller.email AS seller_email, seller.phone AS seller_phone,
        p.mpesa_receipt, p.confirmed_at AS paid_at
       FROM escrows e
       JOIN listings l ON l.id = e.listing_id
       JOIN users buyer ON buyer.id = e.buyer_id
       JOIN users seller ON seller.id = e.seller_id
       JOIN payments p ON p.id = e.payment_id
       ORDER BY e.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/escrows/:id/release ───────────────────────────────────────
// Admin force-releases escrow funds
router.post("/escrows/:id/release", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND status IN ('holding', 'disputed')`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });

    const escrow = rows[0];

    await query(
      `UPDATE escrows SET status = 'released', released_at = NOW(), released_by = $1, notes = $2 WHERE id = $3`,
      [req.user.id, notes || "Admin force release", id]
    );

    await query(`UPDATE listings SET status = 'sold' WHERE id = $1`, [escrow.listing_id]);

    // Notify seller
    await query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'escrow_released', '💰 Funds Released', 'An admin has released your escrow funds. They should reflect in your M-Pesa shortly.')`,
      [escrow.seller_id]
    );

    res.json({ message: "Escrow released successfully" });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/disputes ───────────────────────────────────────────────────
router.get("/disputes", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, e.item_amount, e.total_amount, e.listing_id,
        l.title AS listing_title,
        u.name AS raised_by_name, u.email AS raised_by_email
       FROM disputes d
       JOIN escrows e ON e.id = d.escrow_id
       JOIN listings l ON l.id = e.listing_id
       JOIN users u ON u.id = d.raised_by
       ORDER BY d.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/disputes/:id/resolve ─────────────────────────────────────
router.post("/disputes/:id/resolve", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { resolution, release_to } = req.body; // release_to: "seller" | "buyer"

    const { rows } = await query(`SELECT * FROM disputes WHERE id = $1 AND status = 'open'`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Dispute not found or already resolved" });

    const dispute = rows[0];
    const { rows: escrowRows } = await query(`SELECT * FROM escrows WHERE id = $1`, [dispute.escrow_id]);
    const escrow = escrowRows[0];

    await query(
      `UPDATE disputes SET status = 'resolved', resolved_by = $1, resolution = $2 WHERE id = $3`,
      [req.user.id, resolution, id]
    );

    const escrowStatus = release_to === "seller" ? "released" : "refunded";
    await query(
      `UPDATE escrows SET status = $1, released_at = NOW(), released_by = $2 WHERE id = $3`,
      [escrowStatus, req.user.id, dispute.escrow_id]
    );

    // Notify both parties
    const notifyUserId = release_to === "seller" ? escrow.seller_id : escrow.buyer_id;
    await query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'dispute_resolved', '⚖️ Dispute Resolved', $2)`,
      [notifyUserId, `Your dispute has been resolved in your favour. Resolution: ${resolution}`]
    );

    res.json({ message: "Dispute resolved" });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get("/users", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, anon_tag, phone, is_verified, is_suspended, violation_count, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/users/:id/suspend ────────────────────────────────────────
router.post("/users/:id/suspend", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { suspend } = req.body; // true or false
    await query(`UPDATE users SET is_suspended = $1 WHERE id = $2`, [!!suspend, id]);
    res.json({ message: `User ${suspend ? "suspended" : "unsuspended"}` });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/payments ───────────────────────────────────────────────────
router.get("/payments", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, u.name AS payer_name, u.email AS payer_email, l.title AS listing_title
       FROM payments p
       JOIN users u ON u.id = p.payer_id
       JOIN listings l ON l.id = p.listing_id
       ORDER BY p.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
