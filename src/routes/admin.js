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
      query(`SELECT COUNT(*) FILTER (WHERE status = 'holding') AS active FROM escrows`).catch(() => ({ rows: [{ active: 0 }] })),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'open') AS open FROM disputes`).catch(() => ({ rows: [{ open: 0 }] })),
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

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete("/users/:id", async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    await query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    res.json({ message: "User deleted" });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/free-unlock ──────────────────────────────────
router.post("/listings/:id/free-unlock", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *, 
       (SELECT name FROM users WHERE id = seller_id) AS seller_name`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json({ message: "Listing unlocked for free", listing: rows[0] });
  } catch (err) { next(err); }
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

// ── GET /api/admin/listings ───────────────────────────────────────────────────
router.get("/listings", async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = []; const params = [];
    if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(l.title ILIKE $${params.length} OR u.name ILIKE $${params.length})`); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
              (SELECT COUNT(*) FROM payments p WHERE p.listing_id = l.id AND p.status='confirmed') AS payment_count
       FROM listings l JOIN users u ON u.id = l.seller_id
       ${where} ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const { rows: countRows } = await query(`SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`, params.slice(0, -2));
    res.json({ listings: rows, total: parseInt(countRows[0].count) });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/listings/:id ─────────────────────────────────────────────
router.patch("/listings/:id", async (req, res, next) => {
  try {
    const { status, free_unlock } = req.body;
    const updates = []; const params = [];
    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (free_unlock !== undefined) { params.push(!!free_unlock); updates.push(`is_unlocked = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(req.params.id);
    const { rows } = await query(`UPDATE listings SET ${updates.join(", ")}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/listings/:id ────────────────────────────────────────────
router.delete("/listings/:id", async (req, res, next) => {
  try {
    await query(`DELETE FROM listings WHERE id = $1`, [req.params.id]);
    res.json({ message: "Listing deleted" });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/free-unlock ─────────────────────────────────────
router.post("/users/:id/free-unlock", async (req, res, next) => {
  try {
    await query(`UPDATE users SET free_unlock_approved=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ message: "Free unlock granted" });
  } catch (err) { next(err); }
});

// ── POST /api/admin/escrows/:id/approve ───────────────────────────────────────
router.post("/escrows/:id/approve", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE escrows SET admin_approved=TRUE, approved_by=$1, approved_at=NOW() WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/escrows/:id/refund ────────────────────────────────────────
router.post("/escrows/:id/refund", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE escrows SET status='refunded', released_at=NOW(), released_by=$1, notes='Admin refund' WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/vouchers ───────────────────────────────────────────────────
router.get("/vouchers", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT v.*, u.name AS created_by_name FROM vouchers v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.created_at DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/vouchers ──────────────────────────────────────────────────
router.post("/vouchers", async (req, res, next) => {
  try {
    const { code, type, discount_percent, description, max_uses, expires_at } = req.body;
    const finalCode = code || ("WS-" + Math.random().toString(36).slice(2, 8).toUpperCase());
    const { rows } = await query(
      `INSERT INTO vouchers (code, type, discount_percent, description, max_uses, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [finalCode, type || "unlock", discount_percent || 100, description, max_uses || 50, expires_at || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Code already exists" });
    next(err);
  }
});

// ── PATCH /api/admin/vouchers/:id/toggle ──────────────────────────────────────
router.patch("/vouchers/:id/toggle", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE vouchers SET active=NOT active WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/free-unlock ──────────────────────────────────
// Admin grants free unlock (reveals buyer contact without seller paying)
router.post("/listings/:id/free-unlock", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    // Notify seller
    await query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'admin_unlock', '🔓 Admin Unlocked', 'An admin has unlocked this listing for free. You can now see the buyer contact details.')`,
      [rows[0].seller_id]
    );
    res.json({ message: "Listing unlocked for free", listing: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
// Admin permanently deletes a user account
router.delete("/users/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    // Prevent deleting own admin account
    if (id === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    await query(`DELETE FROM users WHERE id = $1`, [id]);
    res.json({ message: "User account deleted permanently" });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/unlock ───────────────────────────────────────
router.post("/listings/:id/unlock", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});
