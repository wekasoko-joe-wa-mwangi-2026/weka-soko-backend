// src/routes/admin.js
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const router = express.Router();

let _io = null;
router.setIO = (io) => { _io = io; };
let _sendPushToUser = null;
function setPushSender(fn) { _sendPushToUser = fn; }
router.setPushSender = setPushSender;

function pushNotification(userId, notification) {
  if (_io) _io.to(`user:${userId}`).emit("notification", notification);
  // Also send web push to device
  if (_sendPushToUser) {
    _sendPushToUser(userId, {
      title: notification.title,
      body: notification.body,
      tag: notification.type || "admin",
      url: "/"
    }).catch(()=>{});
  }
}

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const [listings, users, payments, violations, escrows, disputes, soldChannels, requests] = await Promise.all([
      query(`SELECT COUNT(*) FILTER (WHERE status = 'active') AS active, COUNT(*) FILTER (WHERE status = 'sold') AS sold, COUNT(*) FILTER (WHERE status = 'locked') AS locked, COUNT(*) AS total FROM listings`),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE role = 'seller') AS sellers, COUNT(*) FILTER (WHERE role = 'buyer') AS buyers, COUNT(*) FILTER (WHERE is_suspended = TRUE) AS suspended FROM users WHERE role != 'admin'`),
      query(`SELECT COUNT(*) FILTER (WHERE type = 'unlock' AND status = 'confirmed') AS unlock_count, SUM(amount_kes) FILTER (WHERE type = 'unlock' AND status = 'confirmed') AS unlock_revenue, SUM(amount_kes) FILTER (WHERE type = 'escrow' AND status = 'confirmed') AS escrow_volume, COUNT(*) FILTER (WHERE type = 'escrow' AND status = 'confirmed') AS escrow_count FROM payments`),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE severity = 'warning') AS warnings, COUNT(*) FILTER (WHERE severity = 'flagged') AS flagged, COUNT(*) FILTER (WHERE severity = 'suspended') AS suspended, COUNT(*) FILTER (WHERE reviewed = FALSE) AS unreviewed FROM chat_violations`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'holding') AS active FROM escrows`).catch(() => ({ rows: [{ active: 0 }] })),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'open') AS open FROM disputes`).catch(() => ({ rows: [{ open: 0 }] })),
      query(`SELECT
        COUNT(*) FILTER (WHERE status='sold') AS total_sold,
        COUNT(*) FILTER (WHERE status='sold' AND sold_channel='platform') AS sold_on_platform,
        COUNT(*) FILTER (WHERE status='sold' AND sold_channel='outside') AS sold_outside,
        COUNT(*) FILTER (WHERE status='sold' AND sold_channel IS NULL) AS sold_channel_unknown
        FROM listings`).catch(() => ({ rows: [{ total_sold:0, sold_on_platform:0, sold_outside:0, sold_channel_unknown:0 }] })),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='active') AS active FROM buyer_requests`).catch(() => ({ rows: [{ total: 0, active: 0 }] })),
    ]);
    res.json({
      listings: listings.rows[0],
      users: users.rows[0],
      payments: payments.rows[0],
      violations: violations.rows[0],
      escrows: escrows.rows[0],
      disputes: disputes.rows[0],
      soldChannels: soldChannels.rows[0],
      requests: requests.rows[0],
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/violations ─────────────────────────────────────────────────
router.get("/violations", async (req, res, next) => {
  try {
    const { reviewed, severity } = req.query;
    const conditions = [];
    const params = [];
    if (reviewed !== undefined) { params.push(reviewed === "true"); conditions.push(`cv.reviewed = $${params.length}`); }
    if (severity) { params.push(severity); conditions.push(`cv.severity = $${params.length}`); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await query(
      `SELECT cv.*, u.name AS user_name, u.email AS user_email, u.anon_tag, u.violation_count, l.title AS listing_title
       FROM chat_violations cv JOIN users u ON u.id = cv.user_id LEFT JOIN listings l ON l.id = cv.listing_id
       ${where} ORDER BY cv.created_at DESC LIMIT 100`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/violations/:id/review ────────────────────────────────────
router.post("/violations/:id/review", async (req, res, next) => {
  try {
    const { action } = req.body;
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
    }
    res.json({ message: `Violation ${action}d` });
  } catch (err) { next(err); }
});

// ── GET /api/admin/escrows ────────────────────────────────────────────────────
router.get("/escrows", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, l.title AS listing_title,
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
  } catch (err) { next(err); }
});

// ── POST /api/admin/escrows/:id/release ──────────────────────────────────────
router.post("/escrows/:id/release", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const { rows } = await query(`SELECT * FROM escrows WHERE id = $1 AND status IN ('holding', 'disputed')`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });
    const escrow = rows[0];
    await query(`UPDATE escrows SET status = 'released', released_at = NOW(), released_by = $1, notes = $2 WHERE id = $3`, [req.user.id, notes || "Admin force release", id]);
    await query(`UPDATE listings SET status = 'sold' WHERE id = $1`, [escrow.listing_id]);
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'escrow_released', '💰 Funds Released', 'An admin has released your escrow funds. They should reflect in your M-Pesa shortly.')`, [escrow.seller_id]);
    res.json({ message: "Escrow released successfully" });
  } catch (err) { next(err); }
});

// ── GET /api/admin/disputes ───────────────────────────────────────────────────
router.get("/disputes", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, e.item_amount, e.total_amount, e.listing_id, l.title AS listing_title,
       u.name AS raised_by_name, u.email AS raised_by_email
       FROM disputes d JOIN escrows e ON e.id = d.escrow_id
       JOIN listings l ON l.id = e.listing_id JOIN users u ON u.id = d.raised_by
       ORDER BY d.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/disputes/:id/resolve ─────────────────────────────────────
router.post("/disputes/:id/resolve", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { resolution, release_to } = req.body;
    const { rows } = await query(`SELECT * FROM disputes WHERE id = $1 AND status = 'open'`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Dispute not found or already resolved" });
    const dispute = rows[0];
    const { rows: escrowRows } = await query(`SELECT * FROM escrows WHERE id = $1`, [dispute.escrow_id]);
    const escrow = escrowRows[0];
    await query(`UPDATE disputes SET status = 'resolved', resolved_by = $1, resolution = $2 WHERE id = $3`, [req.user.id, resolution, id]);
    const escrowStatus = release_to === "seller" ? "released" : "refunded";
    await query(`UPDATE escrows SET status = $1, released_at = NOW(), released_by = $2 WHERE id = $3`, [escrowStatus, req.user.id, dispute.escrow_id]);
    const notifyUserId = release_to === "seller" ? escrow.seller_id : escrow.buyer_id;
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'dispute_resolved', '⚖️ Dispute Resolved', $2)`, [notifyUserId, `Your dispute has been resolved in your favour. Resolution: ${resolution}`]);
    res.json({ message: "Dispute resolved" });
  } catch (err) { next(err); }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get("/users", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.anon_tag, u.phone, u.is_verified, u.is_suspended,
       u.violation_count, u.created_at,
       (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id) AS listing_count,
       (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.is_unlocked = TRUE) AS paid_unlocks,
       (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') AS active_listings,
       (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'sold') AS sold_listings
       FROM users u WHERE u.account_status IS DISTINCT FROM 'deleted' AND u.role != 'admin'
       ORDER BY u.created_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/suspend ────────────────────────────────────────
router.post("/users/:id/suspend", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { suspend } = req.body;
    await query(`UPDATE users SET is_suspended = $1 WHERE id = $2`, [!!suspend, id]);
    res.json({ message: `User ${suspend ? "suspended" : "unsuspended"}` });
  } catch (err) { next(err); }
});

// ── GET /api/admin/payments ───────────────────────────────────────────────────
router.get("/payments", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, u.name AS payer_name, u.email AS payer_email, l.title AS listing_title
       FROM payments p JOIN users u ON u.id = p.payer_id JOIN listings l ON l.id = p.listing_id
       ORDER BY p.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/users/:id/role ──────────────────────────────────────────
router.patch("/users/:id/role", async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["buyer","seller","admin"].includes(role)) return res.status(400).json({ error: "Invalid role" });
    const { rows } = await query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role`, [role, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/users/:id/listings ────────────────────────────────────────
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

// ── GET /api/admin/listings ───────────────────────────────────────────────────
router.get("/listings", async (req, res, next) => {
  try {
    const { status, search, seller_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(l.title ILIKE $${params.length} OR u.name ILIKE $${params.length})`); }
    if (seller_id) { params.push(seller_id); conditions.push(`l.seller_id = $${params.length}`); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
       (SELECT COUNT(*) FROM payments p WHERE p.listing_id = l.id AND p.status='confirmed') AS payment_count,
       (SELECT COUNT(*) FROM listing_reports r WHERE r.listing_id = l.id AND r.status='pending') AS pending_reports,
       COALESCE((SELECT json_agg(json_build_object('url',p.url,'public_id',p.public_id,'sort_order',p.sort_order) ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id = l.id),'[]'::json) AS photos
       FROM listings l JOIN users u ON u.id = l.seller_id ${where}
       ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const { rows: countRows } = await query(`SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`, params.slice(0, -2));
    res.json({ listings: rows, total: parseInt(countRows[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/admin/listings/:id/detail ───────────────────────────────────────
router.get("/listings/:id/detail", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
       u2.name AS buyer_name, u2.email AS buyer_email, u2.phone AS buyer_phone,
       (SELECT COUNT(*) FROM listing_reports r WHERE r.listing_id=l.id AND r.status='pending') AS pending_reports,
       COALESCE((SELECT json_agg(json_build_object('url',p.url,'public_id',p.public_id,'sort_order',p.sort_order,'id',p.id) ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/listings/:id ────────────────────────────────────────────
router.patch("/listings/:id", async (req, res, next) => {
  try {
    const { status, free_unlock, title, description, reason_for_sale, category, price, location, county } = req.body;
    const updates = [];
    const params = [];
    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (free_unlock !== undefined) { params.push(!!free_unlock); updates.push(`is_unlocked = $${params.length}`); }
    if (title) { params.push(title); updates.push(`title = $${params.length}`); }
    if (description) { params.push(description); updates.push(`description = $${params.length}`); }
    if (reason_for_sale) { params.push(reason_for_sale); updates.push(`reason_for_sale = $${params.length}`); }
    if (category) { params.push(category); updates.push(`category = $${params.length}`); }
    if (price) { params.push(parseFloat(price)); updates.push(`price = $${params.length}`); }
    if (location) { params.push(location); updates.push(`location = $${params.length}`); }
    if (county) { params.push(county); updates.push(`county = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(req.params.id);
    const { rows } = await query(`UPDATE listings SET ${updates.join(", ")}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const changed = Object.keys(req.body).filter(k => k !== "free_unlock").join(", ");
    if (changed) {
      await query(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'admin_edit', '✏️ Your listing was edited by admin', $2, $3)`,
        [rows[0].seller_id, `An admin edited your listing "${rows[0].title}". Fields changed: ${changed}. If you have questions, contact support@wekasoko.co.ke`, JSON.stringify({ listing_id: req.params.id, changed_fields: Object.keys(req.body) })]
      ).catch(() => {});
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/listings/:id ───────────────────────────────────────────
router.delete("/listings/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
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

// ── POST /api/admin/listings/:id/free-unlock ─────────────────────────────────
router.post("/listings/:id/free-unlock", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(`UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'admin_unlock', '🔓 Admin Unlocked', 'An admin has unlocked this listing for free. You can now see the buyer contact details.')`, [rows[0].seller_id]);
    res.json({ message: "Listing unlocked for free", listing: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/restore ─────────────────────────────────────
router.post("/listings/:id/restore", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE listings SET status='active', expires_at=NOW()+INTERVAL '75 days', expiry_warned=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id,title,status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json({ ok: true, listing: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/unlock ──────────────────────────────────────
router.post("/listings/:id/unlock", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/free-unlock (deprecated) ───────────────────────
router.post("/users/:id/free-unlock", async (req, res) => {
  res.status(410).json({ error: "Free unlock is per-listing. Use POST /api/admin/listings/:id/free-unlock instead." });
});

// ── POST /api/admin/escrows/:id/approve ──────────────────────────────────────
router.post("/escrows/:id/approve", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE escrows SET admin_approved=TRUE, approved_by=$1, approved_at=NOW() WHERE id=$2 RETURNING *`, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/escrows/:id/refund ───────────────────────────────────────
router.post("/escrows/:id/refund", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE escrows SET status='refunded', released_at=NOW(), released_by=$1, notes='Admin refund' WHERE id=$2 RETURNING *`, [req.user.id, req.params.id]);
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

// ── PATCH /api/admin/vouchers/:id/toggle ─────────────────────────────────────
router.patch("/vouchers/:id/toggle", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE vouchers SET active=NOT active WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/requests ───────────────────────────────────────────────────
router.get("/requests", async (req, res, next) => {
  try {
    const { page=1, limit=50, status } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const conditions = status && status !== "all" ? [`r.status=$1`] : [];
    const params = status && status !== "all" ? [status, parseInt(limit), offset] : [parseInt(limit), offset];
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT r.id, r.title, r.description, r.budget, r.county, r.status, r.created_at,
              u.anon_tag AS requester_anon,
              (SELECT COUNT(*) FROM seller_pitches sp WHERE sp.request_id=r.id) AS pitch_count
       FROM buyer_requests r JOIN users u ON u.id=r.user_id
       ${where} ORDER BY r.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const { rows: cnt } = await query(
      `SELECT COUNT(*) FROM buyer_requests r ${where}`,
      params.slice(0,-2)
    );
    res.json({ requests: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/admin/requests/:id/pitches ──────────────────────────────────────
router.get("/requests/:id/pitches", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT sp.id, sp.message, sp.offered_price, sp.status, sp.created_at, sp.accepted_at,
              u.anon_tag AS seller_anon
       FROM seller_pitches sp JOIN users u ON u.id=sp.seller_id
       WHERE sp.request_id=$1 ORDER BY sp.created_at DESC`,
      [req.params.id]
    );
    res.json({ pitches: rows });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/requests/:id/status ─────────────────────────────────────
router.patch("/requests/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ["active","closed","archived","expired"];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const { rows } = await query(
      `UPDATE buyer_requests SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id,title,status`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    res.json({ ok: true, request: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/requests/:id ───────────────────────────────────────────
router.delete("/requests/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    await query(`DELETE FROM seller_pitches WHERE request_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM notifications WHERE data::text LIKE $1`, [`%${id}%`]).catch(()=>{});
    await query(`DELETE FROM buyer_requests WHERE id=$1`, [id]);
    res.json({ ok: true, message: "Request and all pitches deleted" });
  } catch (err) { next(err); }
});

// ── GET /api/admin/sold ───────────────────────────────────────────────────────
router.get("/sold", async (req, res, next) => {
  try {
    const { page=1, limit=30 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.status, l.sold_channel,
       l.created_at, COALESCE(l.sold_at, l.updated_at) AS sold_at,
       u.name AS seller_name, u.email AS seller_email,
       u2.name AS buyer_name, u2.email AS buyer_email,
       COALESCE(array_to_json(array_agg(p.url ORDER BY p.sort_order LIMIT 1)),'[]'::json) AS photos
       FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       LEFT JOIN listing_photos p ON p.listing_id=l.id
       WHERE l.status='sold' GROUP BY l.id, u.id, u2.id ORDER BY COALESCE(l.sold_at, l.updated_at) DESC LIMIT $1 OFFSET $2`, [parseInt(limit), offset]
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings WHERE status='sold'`);
    res.json({ listings: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/mark-sold ────────────────────────────────────
router.post("/listings/:id/mark-sold", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { sold_channel } = req.body; // 'platform' | 'outside'
    if (!sold_channel || !["platform","outside"].includes(sold_channel)) {
      return res.status(400).json({ error: "sold_channel must be 'platform' or 'outside'" });
    }
    const { rows } = await query(
      `SELECT l.id, l.title, l.status, l.seller_id, u.name, u.email
       FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = rows[0];
    if (listing.status === "sold") return res.status(409).json({ error: "Listing is already marked as sold" });

    await query(
      `UPDATE listings SET status='sold', sold_channel=$1, sold_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [sold_channel, id]
    );

    // Notify the seller
    const channelLabel = sold_channel === "platform" ? "via Weka Soko 🛒" : "outside the platform 🤝";
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,'listing_sold','✅ Marked as Sold',$2,$3)`,
      [listing.seller_id,
       `Your listing "${listing.title}" has been marked as sold ${channelLabel} by an admin.`,
       JSON.stringify({ listing_id: id, sold_channel })]
    ).catch(()=>{});

    pushNotification(listing.seller_id, {
      type: "listing_sold",
      title: "✅ Listing Marked Sold",
      body: `"${listing.title}" has been marked as sold ${channelLabel}.`,
    });

    res.json({ ok: true, message: `Listing marked as sold (${sold_channel})` });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reports ────────────────────────────────────────────────────
router.get("/reports", async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const { rows } = await query(
      `SELECT r.id, r.reason, r.details, r.status, r.created_at,
       l.id AS listing_id, l.title AS listing_title, l.status AS listing_status,
       u.name AS reporter_name, u.email AS reporter_email
       FROM listing_reports r JOIN listings l ON l.id=r.listing_id JOIN users u ON u.id=r.reporter_id
       WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT 200`, [status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/reports/:id ─────────────────────────────────────────────
router.patch("/reports/:id", async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!["resolve","dismiss"].includes(action)) return res.status(400).json({ error: "action must be resolve or dismiss" });
    await query(`UPDATE listing_reports SET status=$1, resolved_by=$2, resolved_at=NOW() WHERE id=$3`, [action === "resolve" ? "resolved" : "dismissed", req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reviews ────────────────────────────────────────────────────
router.get("/reviews", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.comment, r.reviewer_role, r.created_at, l.title AS listing_title, l.id AS listing_id,
       reviewer.name AS reviewer_name, reviewee.name AS reviewee_name
       FROM reviews r JOIN listings l ON l.id=r.listing_id
       JOIN users reviewer ON reviewer.id=r.reviewer_id JOIN users reviewee ON reviewee.id=r.reviewee_id
       ORDER BY r.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/reviews/:id ────────────────────────────────────────────
router.delete("/reviews/:id", async (req, res, next) => {
  try {
    await query(`DELETE FROM reviews WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────────────────────
router.delete("/users/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    // Safety check — never delete another admin account via this route
    const { rows: target } = await query(`SELECT role FROM users WHERE id=$1`, [id]);
    if (!target.length) return res.status(404).json({ error: "User not found" });
    if (target[0].role === "admin") return res.status(403).json({ error: "Admin accounts cannot be deleted here. Use the Team Management section." });
    await purgeUser(id);
    res.json({ message: "User and all data permanently deleted" });
  } catch (err) { console.error("[Admin delete user FATAL]", err.message); next(err); }
});

// ── Shared nuclear delete — handles any schema version ────────────────────────
async function purgeUser(uid) {
  // Step 1: collect Cloudinary IDs before any rows vanish
  const { rows: photoRows } = await query(
    `SELECT lp.public_id FROM listing_photos lp
     JOIN listings l ON l.id = lp.listing_id
     WHERE l.seller_id=$1 AND lp.public_id IS NOT NULL`, [uid]
  ).catch(() => ({ rows: [] }));

  // Step 2: dynamically nullify EVERY FK in the entire DB pointing at users(id)
  // This handles any schema version including old columns like moderation_reviewed_by
  const { rows: fkRefs } = await query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
      AND tc.table_schema = rc.constraint_schema
    JOIN information_schema.key_column_usage ccu
      ON rc.unique_constraint_name = ccu.constraint_name
      AND rc.unique_constraint_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users'
      AND ccu.column_name = 'id'
      AND tc.table_name != 'users'
  `).catch(() => ({ rows: [] }));

  for (const { table_name, column_name } of fkRefs) {
    await query(
      `UPDATE ${table_name} SET ${column_name}=NULL WHERE ${column_name}=$1`,
      [uid]
    ).catch(e => console.warn(`[purgeUser] nullify ${table_name}.${column_name}:`, e.message));
  }

  // Step 3: delete child rows in FK-safe order
  const steps = [
    `DELETE FROM payments WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
    `DELETE FROM disputes WHERE escrow_id IN (SELECT id FROM escrows WHERE buyer_id=$1 OR seller_id=$1)`,
    `DELETE FROM escrows WHERE buyer_id=$1 OR seller_id=$1`,
    `DELETE FROM reviews WHERE reviewer_id=$1 OR reviewee_id=$1`,
    `DELETE FROM seller_pitches WHERE seller_id=$1`,
    `DELETE FROM seller_pitches WHERE request_id IN (SELECT id FROM buyer_requests WHERE user_id=$1)`,
    `DELETE FROM buyer_requests WHERE user_id=$1`,
    `DELETE FROM listing_reports WHERE reporter_id=$1`,
    `DELETE FROM listing_reports WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
    `DELETE FROM chat_messages WHERE sender_id=$1 OR receiver_id=$1`,
    `DELETE FROM chat_violations WHERE user_id=$1`,
    `DELETE FROM listing_photos WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
    `DELETE FROM listings WHERE seller_id=$1`,
    `DELETE FROM notifications WHERE user_id=$1`,
    `DELETE FROM password_history WHERE user_id=$1`,
    `DELETE FROM password_resets WHERE user_id=$1`,
  ];
  for (const sql of steps) {
    await query(sql, [uid]).catch(e => console.warn(`[purgeUser] ${sql.slice(0,50)}:`, e.message));
  }

  // Step 4: delete the user
  await query(`DELETE FROM users WHERE id=$1`, [uid]);

  // Step 5: purge Cloudinary — outside DB, non-fatal
  if (photoRows.length > 0) {
    try {
      const { deleteByPublicId } = require("../services/cloudinary.service");
      await Promise.allSettled(photoRows.map(r => deleteByPublicId(r.public_id)));
    } catch (e) { console.warn("[purgeUser] Cloudinary:", e.message); }
  }
}

// ── Admin Invite System ───────────────────────────────────────────────────────
router.get("/admins", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, email, admin_level, created_at FROM users WHERE role='admin' ORDER BY created_at DESC`);
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
    const tempPassword = crypto.randomBytes(8).toString("hex");
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(tempPassword, 12);
    const ANON_ADJ=["Swift","Bold","Sharp"]; const ANON_NOUN=["Falcon","Eagle","Simba"];
    const anonTag = ANON_ADJ[Math.floor(Math.random()*3)] + ANON_NOUN[Math.floor(Math.random()*3)] + Math.floor(10+Math.random()*90);
    const ADMIN_URL = process.env.ADMIN_URL || "https://weka-soko-admin.vercel.app";
    let userId;
    if (existing.rows.length) {
      await query(`UPDATE users SET role='admin', admin_level=$1, name=COALESCE(NULLIF(name,''),$2), is_verified=TRUE WHERE id=$3`, [admin_level, name, existing.rows[0].id]);
      userId = existing.rows[0].id;
    } else {
      const { rows } = await query(`INSERT INTO users (name, email, password_hash, role, admin_level, is_verified, anon_tag) VALUES ($1,$2,$3,'admin',$4,TRUE,$5) RETURNING id`, [name, email.toLowerCase().trim(), hash, admin_level, anonTag]);
      userId = rows[0].id;
    }
    const { sendEmail } = require("../services/email.service");
    await sendEmail(email, name, "🔐 You've been invited to Weka Soko Admin",
      `Hi ${name},\n\nYou have been invited to manage the Weka Soko admin panel with ${admin_level} access.\n\nLogin at: ${ADMIN_URL}\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nPlease change your password after first login.\n\nAccess level: ${admin_level}\n— Weka Soko`
    );
    res.json({ ok: true, message: `Admin invite sent to ${email} with ${admin_level} access.`, userId });
  } catch (err) { console.error("[Admin invite]", err.message); next(err); }
});

router.patch("/admins/:id/level", async (req, res, next) => {
  try {
    const { admin_level } = req.body;
    if (!["viewer","moderator","manager","super"].includes(admin_level)) return res.status(400).json({ error: "Invalid level" });
    await query(`UPDATE users SET admin_level=$1 WHERE id=$2 AND role='admin'`, [admin_level, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete("/admins/:id", async (req, res, next) => {
  try {
    await query(`UPDATE users SET role='buyer', admin_level=NULL WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, message: "Admin access revoked" });
  } catch (err) { next(err); }
});

// ── Ad Moderation Queue ───────────────────────────────────────────────────────
const { sendEmail } = require("../services/email.service");
const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";

router.get("/moderation/queue", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.description, l.reason_for_sale,
         l.category, l.subcat, l.price, l.location, l.county,
         l.status, l.moderation_note, l.created_at,
         u.id AS seller_id, u.name AS seller_name, u.email AS seller_email,
         COALESCE(
           (SELECT json_agg(lp.url ORDER BY lp.sort_order)
            FROM listing_photos lp WHERE lp.listing_id = l.id),
           '[]'::json
         ) AS photos
       FROM listings l
       JOIN users u ON u.id = l.seller_id
       WHERE l.status = 'pending_review'
       ORDER BY l.created_at ASC`, []
    );
    res.json({ listings: rows, total: rows.length });
  } catch (err) { next(err); }
});

router.post("/moderation/:id/approve", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: check } = await query(
      `SELECT l.id, l.title, l.seller_id, u.name, u.email FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: "Listing not found" });
    const listing = check[0];
    await query(`UPDATE listings SET status='active', moderation_note=NULL, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`, [id]);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_approved', '✅ Ad Approved!', $2, $3)`,
      [listing.seller_id, `Great news! Your listing "${listing.title}" has been approved and is now live on Weka Soko.`, JSON.stringify({ listing_id: id })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_approved", title: "✅ Ad Approved!", body: `Your listing "${listing.title}" is now live!`, data: { listing_id: id } });
    sendEmail(listing.email, listing.name, "✅ Your ad is live on Weka Soko!",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" has been approved and is now live.\n\n${FRONTEND}\n\nGood luck with your sale!\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation approve email]", e.message));
    res.json({ ok: true, message: "Listing approved and live" });
  } catch (err) { next(err); }
});

router.post("/moderation/:id/reject", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: "Rejection reason is required" });
    const { rows: check } = await query(
      `SELECT l.id, l.title, l.seller_id, u.name, u.email FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: "Listing not found" });
    const listing = check[0];
    await query(`UPDATE listings SET status='rejected', moderation_note=$1, reviewed_at=NOW(), updated_at=NOW() WHERE id=$2`, [reason.trim(), id]);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_rejected', '❌ Ad Not Approved', $2, $3)`,
      [listing.seller_id, `Your listing "${listing.title}" was not approved. Reason: ${reason.trim()}`, JSON.stringify({ listing_id: id, reason: reason.trim() })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_rejected", title: "❌ Ad Not Approved", body: `"${listing.title}" — ${reason.trim().slice(0, 80)}`, data: { listing_id: id } });
    sendEmail(listing.email, listing.name, "❌ Your Weka Soko ad was not approved",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" was not approved.\n\nReason: ${reason.trim()}\n\nYou can edit and resubmit at:\n${FRONTEND}\n\nQuestions? Contact support@wekasoko.co.ke\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation reject email]", e.message));
    res.json({ ok: true, message: "Listing rejected, seller notified" });
  } catch (err) { next(err); }
});

router.post("/moderation/:id/request-changes", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: "Change request note is required" });
    const { rows: check } = await query(
      `SELECT l.id, l.title, l.seller_id, u.name, u.email FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: "Listing not found" });
    const listing = check[0];
    await query(`UPDATE listings SET moderation_note=$1, updated_at=NOW() WHERE id=$2`, [note.trim(), id]);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_changes_requested', '✏️ Changes Needed on Your Ad', $2, $3)`,
      [listing.seller_id, `Your listing "${listing.title}" needs changes before it can go live. Note: ${note.trim()}`, JSON.stringify({ listing_id: id, note: note.trim() })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_changes_requested", title: "✏️ Changes Needed", body: `"${listing.title}" — ${note.trim().slice(0, 80)}`, data: { listing_id: id } });
    sendEmail(listing.email, listing.name, "✏️ Changes needed on your Weka Soko ad",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" needs changes before going live.\n\nNote: ${note.trim()}\n\nEdit it at:\n${FRONTEND}\n\nOnce updated it will be re-reviewed automatically.\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation changes email]", e.message));
    res.json({ ok: true, message: "Change request sent to seller" });
  } catch (err) { next(err); }
});

module.exports = router;
