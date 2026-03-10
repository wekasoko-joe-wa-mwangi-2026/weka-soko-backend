// src/routes/admin.js
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
let _io = null;
router.setIO = (io) => { _io = io; };

function pushNotification(userId, notification) {
  if (_io) _io.to(`user:${userId}`).emit("notification", notification);
}

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
      const notif = { type: "suspension", title: "🚫 Account Suspended", body: "Your account has been suspended for violating our chat policies. Contact support@wekasoko.co.ke to appeal." };
      await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [v.user_id, notif.type, notif.title, notif.body]);
      pushNotification(v.user_id, notif);
    } else if (action === "warn") {
      const notif = { type: "warning", title: "⚠️ Account Warning", body: "You received a warning for attempting to share contact information in chat. Further violations may result in suspension." };
      await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [v.user_id, notif.type, notif.title, notif.body]);
      pushNotification(v.user_id, notif);
    } else if (action === "dismiss") {
      // No action needed
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
      `SELECT u.id, u.name, u.email, u.role, u.anon_tag, u.phone, u.is_verified,
              u.is_suspended, u.violation_count, u.created_at,
              (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id) AS listing_count,
              (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.is_unlocked = TRUE) AS paid_unlocks,
              (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') AS active_listings,
              (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'sold') AS sold_listings
       FROM users u
       WHERE u.account_status IS DISTINCT FROM 'deleted'
       ORDER BY u.created_at DESC LIMIT 500`
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

// (duplicate DELETE /users/:id removed — canonical version is at end of file)

// (duplicate POST /listings/:id/free-unlock removed)

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

// ── PATCH /api/admin/users/:id/role ─────────────────────────────────────────
router.patch("/users/:id/role", async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["buyer","seller"].includes(role)) return res.status(400).json({ error: "Role must be buyer or seller" });
    const { rows } = await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role`,
      [role, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/users/:id/listings ────────────────────────────────────────
// All listings posted by a specific seller — for per-user management
router.get("/users/:id/listings", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, 
              (SELECT COUNT(*) FROM chat_messages c WHERE c.listing_id = l.id) AS message_count,
              (SELECT COUNT(*) FROM payments p WHERE p.listing_id = l.id AND p.status='confirmed') AS payment_count
       FROM listings l WHERE l.seller_id = $1 ORDER BY l.created_at DESC`,
      [req.params.id]
    );
    res.json({ listings: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/users/:id/role ──────────────────────────────────────────
// Admin changes a user's role
router.patch("/users/:id/role", async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["buyer","seller","admin"].includes(role))
      return res.status(400).json({ error: "Invalid role" });
    const { rows } = await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role`,
      [role, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;

// ── GET /api/admin/listings ───────────────────────────────────────────────────
router.get("/listings", async (req, res, next) => {
  try {
    const { status, search, seller_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = []; const params = [];
    if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(l.title ILIKE $${params.length} OR u.name ILIKE $${params.length})`); }
    if (seller_id) { params.push(seller_id); conditions.push(`l.seller_id = $${params.length}`); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
              (SELECT COUNT(*) FROM payments p WHERE p.listing_id = l.id AND p.status='confirmed') AS payment_count,
              (SELECT COUNT(*) FROM listing_reports r WHERE r.listing_id = l.id AND r.status='pending') AS pending_reports,
              COALESCE(
                (SELECT json_agg(json_build_object('url',p.url,'public_id',p.public_id,'sort_order',p.sort_order) ORDER BY p.sort_order)
                 FROM listing_photos p WHERE p.listing_id = l.id),
                '[]'::json
              ) AS photos
       FROM listings l JOIN users u ON u.id = l.seller_id
       ${where} ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const { rows: countRows } = await query(`SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`, params.slice(0, -2));
    res.json({ listings: rows, total: parseInt(countRows[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/admin/listings/:id/detail ────────────────────────────────────────
// Full listing view for admin including all fields + photos + reports
router.get("/listings/:id/detail", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
        u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
        u2.name AS buyer_name, u2.email AS buyer_email, u2.phone AS buyer_phone,
        (SELECT COUNT(*) FROM listing_reports r WHERE r.listing_id=l.id AND r.status='pending') AS pending_reports,
        COALESCE(
          (SELECT json_agg(json_build_object('url',p.url,'public_id',p.public_id,'sort_order',p.sort_order,'id',p.id) ORDER BY p.sort_order)
           FROM listing_photos p WHERE p.listing_id=l.id),
          '[]'::json
        ) AS photos
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/listings/:id ─────────────────────────────────────────────
// Admin can edit any listing field. Seller is notified of changes.
router.patch("/listings/:id", async (req, res, next) => {
  try {
    const { status, free_unlock, title, description, reason_for_sale, category, price, location, county } = req.body;
    const updates = []; const params = [];
    if (status)              { params.push(status);         updates.push(`status = $${params.length}`); }
    if (free_unlock !== undefined) { params.push(!!free_unlock); updates.push(`is_unlocked = $${params.length}`); }
    if (title)               { params.push(title);          updates.push(`title = $${params.length}`); }
    if (description)         { params.push(description);    updates.push(`description = $${params.length}`); }
    if (reason_for_sale)     { params.push(reason_for_sale); updates.push(`reason_for_sale = $${params.length}`); }
    if (category)            { params.push(category);       updates.push(`category = $${params.length}`); }
    if (price)               { params.push(parseFloat(price)); updates.push(`price = $${params.length}`); }
    if (location)            { params.push(location);       updates.push(`location = $${params.length}`); }
    if (county)              { params.push(county);         updates.push(`county = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE listings SET ${updates.join(", ")}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });

    // Notify seller of admin edit
    const changed = Object.keys(req.body).filter(k => k !== "free_unlock").join(", ");
    if (changed) {
      await query(
        `INSERT INTO notifications (user_id, type, title, body, data)
         VALUES ($1, 'admin_edit', '✏️ Your listing was edited by admin', $2, $3)`,
        [
          rows[0].seller_id,
          `An admin edited your listing "${rows[0].title}". Fields changed: ${changed}. If you have questions, contact support@wekasoko.co.ke`,
          JSON.stringify({ listing_id: req.params.id, changed_fields: Object.keys(req.body) })
        ]
      ).catch(() => {});
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/listings/:id ────────────────────────────────────────────
router.delete("/listings/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    // Clear FK references before deleting
    await query(`UPDATE escrows SET listing_id=NULL WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM payments WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM listing_reports WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM listing_photos WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM chat_messages WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM chat_violations WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM notifications WHERE data::text LIKE $1`, [`%${id}%`]).catch(()=>{});
    await query(`DELETE FROM reviews WHERE listing_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM listings WHERE id=$1`, [id]);
    res.json({ message: "Listing permanently deleted" });
  } catch (err) { console.error("[Admin delete listing]", err.message); next(err); }
});

// ── POST /api/admin/users/:id/free-unlock ─────────────────────────────────────
// DEPRECATED: Free unlocks are per-listing, not per-user. See /listings/:id/free-unlock
// Kept for backward compatibility — does nothing meaningful
router.post("/users/:id/free-unlock", async (req, res, next) => {
  res.status(410).json({ error: "Free unlock is per-listing, not per-user. Use POST /api/admin/listings/:id/free-unlock instead." });
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
router.delete("/users/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    // Clear FK refs that block deletion
    await query(`UPDATE payments  SET payer_id    = NULL WHERE payer_id    = $1`, [id]).catch(()=>{});
    await query(`UPDATE escrows   SET approved_by = NULL WHERE approved_by = $1`, [id]).catch(()=>{});
    await query(`UPDATE escrows   SET released_by = NULL WHERE released_by = $1`, [id]).catch(()=>{});
    await query(`UPDATE disputes  SET resolved_by = NULL WHERE resolved_by = $1`, [id]).catch(()=>{});
    await query(`UPDATE listings  SET locked_buyer_id = NULL WHERE locked_buyer_id = $1`, [id]).catch(()=>{});
    // Delete their data
    await query(`DELETE FROM chat_messages   WHERE sender_id = $1 OR receiver_id = $1`, [id]).catch(()=>{});
    await query(`DELETE FROM chat_violations WHERE user_id = $1`, [id]).catch(()=>{});
    await query(`DELETE FROM notifications   WHERE user_id = $1`, [id]).catch(()=>{});
    await query(`DELETE FROM listings        WHERE seller_id = $1`, [id]);
    await query(`DELETE FROM users           WHERE id = $1`, [id]);
    res.json({ message: "User and all data permanently deleted" });
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

// ── GET /api/admin/sold ──────────────────────────────────────────────────────
// Sold listings overview for admin
router.get("/sold", async (req, res, next) => {
  try {
    const { page=1, limit=30 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.status, l.updated_at AS sold_at,
              u.name AS seller_name, u.email AS seller_email,
              u2.name AS buyer_name, u2.email AS buyer_email
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.status='sold'
       ORDER BY l.updated_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings WHERE status='sold'`);
    res.json({ listings: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reports ────────────────────────────────────────────────────
// All listing reports with listing + reporter info
router.get("/reports", async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const { rows } = await query(
      `SELECT r.id, r.reason, r.details, r.status, r.created_at,
              l.id AS listing_id, l.title AS listing_title, l.status AS listing_status,
              u.name AS reporter_name, u.email AS reporter_email
       FROM listing_reports r
       JOIN listings l ON l.id=r.listing_id
       JOIN users u ON u.id=r.reporter_id
       WHERE r.status=$1
       ORDER BY r.created_at DESC LIMIT 200`,
      [status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/reports/:id ──────────────────────────────────────────────
// Resolve or dismiss a report
router.patch("/reports/:id", async (req, res, next) => {
  try {
    const { action } = req.body; // 'resolve' | 'dismiss'
    if (!["resolve","dismiss"].includes(action)) return res.status(400).json({ error: "action must be resolve or dismiss" });
    await query(
      `UPDATE listing_reports SET status=$1, resolved_by=$2, resolved_at=NOW() WHERE id=$3`,
      [action === "resolve" ? "resolved" : "dismissed", req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/restore ─────────────────────────────────────
// Restore an archived/flagged listing to active
router.post("/listings/:id/restore", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE listings SET status='active', expires_at=NOW()+INTERVAL '75 days', expiry_warned=FALSE, updated_at=NOW()
       WHERE id=$1 RETURNING id,title,status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json({ ok: true, listing: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reviews ────────────────────────────────────────────────────
router.get("/reviews", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.comment, r.reviewer_role, r.created_at,
              l.title AS listing_title, l.id AS listing_id,
              reviewer.name AS reviewer_name, reviewee.name AS reviewee_name
       FROM reviews r
       JOIN listings l ON l.id=r.listing_id
       JOIN users reviewer ON reviewer.id=r.reviewer_id
       JOIN users reviewee ON reviewee.id=r.reviewee_id
       ORDER BY r.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/reviews/:id ─────────────────────────────────────────────
router.delete("/reviews/:id", async (req, res, next) => {
  try {
    await query(`DELETE FROM reviews WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Admin Invite System ────────────────────────────────────────────────────────
router.get("/admins", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, admin_level, created_at, last_login
       FROM users WHERE role='admin' ORDER BY created_at DESC`,
      []
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/invite", async (req, res, next) => {
  try {
    const { email, name, admin_level = "viewer" } = req.body;
    if (!email || !name) return res.status(400).json({ error: "Email and name required" });
    const VALID_LEVELS = ["viewer", "moderator", "manager", "super"];
    if (!VALID_LEVELS.includes(admin_level)) return res.status(400).json({ error: "Invalid admin level" });

    const existing = await query(`SELECT id, role FROM users WHERE email=$1`, [email.toLowerCase().trim()]);
    const crypto = require("crypto");
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const tempPassword = crypto.randomBytes(8).toString("hex");
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(tempPassword, 12);
    const ANON_ADJ=["Swift","Bold","Sharp"];const ANON_NOUN=["Falcon","Eagle","Simba"];
    const anonTag=ANON_ADJ[Math.floor(Math.random()*3)]+ANON_NOUN[Math.floor(Math.random()*3)]+Math.floor(10+Math.random()*90);
    const FRONTEND = process.env.ADMIN_URL || "https://weka-soko-admin.vercel.app";

    let userId;
    if (existing.rows.length) {
      const u = existing.rows[0];
      await query(`UPDATE users SET role='admin', admin_level=$1, name=COALESCE(NULLIF(name,''),$2), is_verified=TRUE WHERE id=$3`, [admin_level, name, u.id]);
      userId = u.id;
    } else {
      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role, admin_level, is_verified, anon_tag)
         VALUES ($1,$2,$3,'admin',$4,TRUE,$5) RETURNING id`,
        [name, email.toLowerCase().trim(), hash, admin_level, anonTag]
      );
      userId = rows[0].id;
    }

    const { sendEmail } = require("../services/email.service");
    await sendEmail(
      email, name,
      "🔐 You've been invited to Weka Soko Admin",
      `Hi ${name},\n\nYou have been invited to manage the Weka Soko admin panel with ${admin_level} access.\n\nLogin at: ${FRONTEND}\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nPlease change your password after first login.\n\nAccess level: ${admin_level}\n— Weka Soko`
    );

    res.json({ ok: true, message: `Admin invite sent to ${email} with ${admin_level} access.`, userId });
  } catch (err) { console.error("[Admin invite]", err.message); next(err); }
});

router.patch("/admins/:id/level", async (req, res, next) => {
  try {
    const { admin_level } = req.body;
    const VALID_LEVELS = ["viewer", "moderator", "manager", "super"];
    if (!VALID_LEVELS.includes(admin_level)) return res.status(400).json({ error: "Invalid level" });
    await query(`UPDATE users SET admin_level=$1 WHERE id=$2 AND role='admin'`, [admin_level, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete("/admins/:id", async (req, res, next) => {
  try {
    // Downgrade to buyer rather than deleting
    await query(`UPDATE users SET role='buyer', admin_level=NULL WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, message: "Admin access revoked" });
  } catch (err) { next(err); }
});
