// src/routes/admin.js
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { auditLog } = require("../services/audit.service");
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: `violation_${action}`, targetType: "user", targetId: v.user_id, details: { violation_id: id, listing_id: v.listing_id }, ip: req.ip });
    const MAX_WARNINGS = 5;
    if (action === "suspend") {
      await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [v.user_id]);
      const notif = { type: "suspension", title: "Account Suspended", body: "Your account has been suspended for violating our chat policies. Contact support@wekasoko.co.ke to appeal." };
      await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [v.user_id, notif.type, notif.title, notif.body]);
      pushNotification(v.user_id, notif);
      const { rows: uRows } = await query(`SELECT name, email FROM users WHERE id = $1`, [v.user_id]);
      if (uRows.length) sendEmail(uRows[0].email, uRows[0].name, notif.title, notif.body).catch(() => {});
    } else if (action === "warn") {
      const { rows: uRows } = await query(
        `UPDATE users SET violation_count = violation_count + 1 WHERE id = $1 RETURNING violation_count, name, email`,
        [v.user_id]
      );
      if (!uRows.length) return res.status(404).json({ error: "User not found" });
      const user = uRows[0];
      if (user.violation_count >= MAX_WARNINGS) {
        await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [v.user_id]);
        const notif = {
          type: "suspension", title: "Account Suspended",
          body: `Your account has been suspended after receiving ${MAX_WARNINGS} warnings for violating our community guidelines. Contact support@wekasoko.co.ke to appeal.`
        };
        await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [v.user_id, notif.type, notif.title, notif.body]);
        pushNotification(v.user_id, notif);
        sendEmail(user.email, user.name, notif.title, notif.body).catch(() => {});
      } else {
        const strikesLeft = MAX_WARNINGS - user.violation_count;
        const notif = {
          type: "warning",
          title: `Account Warning — Strike ${user.violation_count} of ${MAX_WARNINGS}`,
          body: `You received a warning for violating our community guidelines. You have ${strikesLeft} strike${strikesLeft === 1 ? "" : "s"} remaining before your account is suspended.\n\nPlease review our community guidelines. Contact support@wekasoko.co.ke if you believe this was issued in error.`
        };
        await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [v.user_id, notif.type, notif.title, notif.body]);
        pushNotification(v.user_id, notif);
        sendEmail(user.email, user.name, notif.title, notif.body).catch(() => {});
      }
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
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'escrow_released', ' Funds Released', 'An admin has released your escrow funds. They should reflect in your M-Pesa shortly.')`, [escrow.seller_id]);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "escrow_release", targetType: "escrow", targetId: id, details: { listing_id: escrow.listing_id, seller_id: escrow.seller_id, notes }, ip: req.ip });
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
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'dispute_resolved', 'Dispute Resolved', $2)`, [notifyUserId, `Your dispute has been resolved in your favour. Resolution: ${resolution}`]);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "dispute_resolve", targetType: "dispute", targetId: id, details: { resolution, release_to, escrow_id: dispute.escrow_id }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: suspend ? "user_suspend" : "user_unsuspend", targetType: "user", targetId: id, ip: req.ip });
    res.json({ message: `User ${suspend ? "suspended" : "unsuspended"}` });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/warn ───────────────────────────────────────────
router.post("/users/:id/warn", async (req, res, next) => {
  try {
    const { reason = "Violation of community guidelines" } = req.body;
    const { rows: uRows } = await query(
      `UPDATE users SET violation_count = violation_count + 1 WHERE id = $1 AND is_suspended = FALSE
       RETURNING id, name, email, violation_count`,
      [req.params.id]
    );
    if (!uRows.length) {
      const { rows: check } = await query(`SELECT is_suspended FROM users WHERE id=$1`, [req.params.id]);
      if (!check.length) return res.status(404).json({ error: "User not found" });
      if (check[0].is_suspended) return res.status(409).json({ error: "User is already suspended" });
    }
    const user = uRows[0];
    const MAX_WARNINGS = 5;
    if (user.violation_count >= MAX_WARNINGS) {
      await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [user.id]);
      const notif = {
        type: "suspension", title: "Account Suspended",
        body: `Your account has been suspended after receiving ${MAX_WARNINGS} warnings for violating our community guidelines. Contact support@wekasoko.co.ke to appeal.`
      };
      await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [user.id, notif.type, notif.title, notif.body]);
      pushNotification(user.id, notif);
      sendEmail(user.email, user.name, notif.title, notif.body).catch(() => {});
      return res.json({ message: `User suspended after ${MAX_WARNINGS} warnings`, violation_count: user.violation_count, suspended: true });
    }
    const strikesLeft = MAX_WARNINGS - user.violation_count;
    const notif = {
      type: "warning",
      title: `Account Warning — Strike ${user.violation_count} of ${MAX_WARNINGS}`,
      body: `You received a warning: ${reason}. You have ${strikesLeft} strike${strikesLeft === 1 ? "" : "s"} remaining before your account is suspended.\n\nContact support@wekasoko.co.ke if you believe this warning was issued in error.`
    };
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`, [user.id, notif.type, notif.title, notif.body]);
    pushNotification(user.id, notif);
    sendEmail(user.email, user.name, notif.title, notif.body).catch(() => {});
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "user_warn", targetType: "user", targetId: req.params.id, details: { reason, violation_count: user.violation_count, strikes_left: strikesLeft }, ip: req.ip });
    res.json({ message: `Warning issued (strike ${user.violation_count} of ${MAX_WARNINGS})`, violation_count: user.violation_count, strikes_left: strikesLeft });
  } catch (err) { next(err); }
});

// ── GET /api/admin/payments ───────────────────────────────────────────────────
router.get("/payments", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, u.name AS payer_name, u.email AS payer_email, l.title AS listing_title
       FROM payments p JOIN users u ON u.id = p.payer_id LEFT JOIN listings l ON l.id = p.listing_id
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "user_role_change", targetType: "user", targetId: req.params.id, details: { new_role: role }, ip: req.ip });
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
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'admin_edit', 'Your listing was edited by admin', $2, $3)`,
        [rows[0].seller_id, `An admin edited your listing "${rows[0].title}". Fields changed: ${changed}. If you have questions, contact support@wekasoko.co.ke`, JSON.stringify({ listing_id: req.params.id, changed_fields: Object.keys(req.body) })]
      ).catch(() => {});
    }
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_edit", targetType: "listing", targetId: req.params.id, details: { changed_fields: Object.keys(req.body), title: rows[0].title }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_delete", targetType: "listing", targetId: id, ip: req.ip });
    res.json({ message: "Listing permanently deleted" });
  } catch (err) { console.error("[Admin delete listing]", err.message); next(err); }
});

// ── POST /api/admin/listings/:id/free-unlock ─────────────────────────────────
router.post("/listings/:id/free-unlock", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(`UPDATE listings SET is_unlocked = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'admin_unlock', 'Admin Unlocked', 'An admin has unlocked this listing for free. You can now see the buyer contact details.')`, [rows[0].seller_id]);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_free_unlock", targetType: "listing", targetId: id, details: { title: rows[0].title }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_restore", targetType: "listing", targetId: req.params.id, details: { title: rows[0].title }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "escrow_approve", targetType: "escrow", targetId: req.params.id, ip: req.ip });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/escrows/:id/refund ───────────────────────────────────────
router.post("/escrows/:id/refund", async (req, res, next) => {
  try {
    const { rows } = await query(`UPDATE escrows SET status='refunded', released_at=NOW(), released_by=$1, notes='Admin refund' WHERE id=$2 RETURNING *`, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "escrow_refund", targetType: "escrow", targetId: req.params.id, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "voucher_create", targetType: "voucher", targetId: rows[0].id, details: { code: finalCode, discount_percent: rows[0].discount_percent }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: rows[0].active ? "voucher_enable" : "voucher_disable", targetType: "voucher", targetId: req.params.id, details: { code: rows[0].code }, ip: req.ip });
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
       COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order LIMIT 1) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.status='sold' ORDER BY COALESCE(l.sold_at, l.updated_at) DESC LIMIT $1 OFFSET $2`, [parseInt(limit), offset]
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
    const channelLabel = sold_channel === "platform" ? "via Weka Soko " : "outside the platform ";
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,'listing_sold','Marked as Sold',$2,$3)`,
      [listing.seller_id,
       `Your listing "${listing.title}" has been marked as sold ${channelLabel} by an admin.`,
       JSON.stringify({ listing_id: id, sold_channel })]
    ).catch(()=>{});

    pushNotification(listing.seller_id, {
      type: "listing_sold",
      title: "Listing Marked Sold",
      body: `"${listing.title}" has been marked as sold ${channelLabel}.`,
    });

    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_mark_sold", targetType: "listing", targetId: id, details: { title: listing.title, sold_channel }, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: `report_${action}`, targetType: "report", targetId: req.params.id, ip: req.ip });
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
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "review_delete", targetType: "review", targetId: req.params.id, ip: req.ip });
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
    const { rows: uInfo } = await query(`SELECT name, email FROM users WHERE id=$1`, [id]).catch(()=>({rows:[]}));
    await purgeUser(id);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "user_delete", targetType: "user", targetId: id, details: { name: uInfo[0]?.name, email: uInfo[0]?.email }, ip: req.ip });
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
    await sendEmail(email, name, "You have been invited to Weka Soko Admin",
      `Hi ${name},\n\nYou have been invited to manage the Weka Soko admin panel with ${admin_level} access.\n\nLogin at: ${ADMIN_URL}\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nPlease change your password after first login.\n\nAccess level: ${admin_level}\n— Weka Soko`
    );
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "admin_invite", targetType: "user", targetId: userId, details: { email, name, admin_level }, ip: req.ip });
    res.json({ ok: true, message: `Admin invite sent to ${email} with ${admin_level} access.`, userId });
  } catch (err) { console.error("[Admin invite]", err.message); next(err); }
});

router.patch("/admins/:id/level", async (req, res, next) => {
  try {
    const { admin_level } = req.body;
    if (!["viewer","moderator","manager","super"].includes(admin_level)) return res.status(400).json({ error: "Invalid level" });
    await query(`UPDATE users SET admin_level=$1 WHERE id=$2 AND role='admin'`, [admin_level, req.params.id]);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "admin_level_change", targetType: "user", targetId: req.params.id, details: { new_level: admin_level }, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete("/admins/:id", async (req, res, next) => {
  try {
    await query(`UPDATE users SET role='buyer', admin_level=NULL WHERE id=$1`, [req.params.id]);
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "admin_revoke", targetType: "user", targetId: req.params.id, ip: req.ip });
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
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_approved', 'Ad Approved!', $2, $3)`,
      [listing.seller_id, `Great news! Your listing "${listing.title}" has been approved and is now live on Weka Soko.`, JSON.stringify({ listing_id: id })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) {
      // Notify the seller their ad is live
      io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_approved", title: "🎉 Ad Approved!", body: `Your listing "${listing.title}" is now live!`, data: { listing_id: id } });
      // Global feed refresh — sends the full listing object to all connected users
      query(
        `SELECT l.id, l.title, l.description, l.category, l.subcat, l.price, l.location, l.county,
                l.seller_id, l.view_count, l.interest_count, l.created_at, l.expires_at,
                l.listing_anon_tag AS seller_anon,
                u.avg_rating AS seller_avg_rating, u.review_count AS seller_review_count,
                COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
         FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1`, [id]
      ).then(({ rows: lRows }) => {
        if (lRows.length) io.emit("new_listing", lRows[0]);
      }).catch(() => {});
    }
    sendEmail(listing.email, listing.name, "Your ad is live on Weka Soko!",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" has been approved and is now live.\n\n${FRONTEND}\n\nGood luck with your sale!\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation approve email]", e.message));
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_approve", targetType: "listing", targetId: id, details: { title: listing.title }, ip: req.ip });
    res.json({ ok: true, message: "Listing approved and live" });

    // Async: notify buyers whose requests match this newly approved listing
    (async () => {
      try {
        const { rows: fullListing } = await query(`SELECT title, category, county, description FROM listings WHERE id=$1`, [id]);
        if (!fullListing.length) return;
        const l = fullListing[0];
        const { rows: matches } = await query(
          `SELECT DISTINCT r.user_id, r.title AS req_title, r.id AS request_id
           FROM buyer_requests r
           WHERE r.status='active' AND r.user_id!=$1
             AND ($2 ILIKE '%'||r.title||'%' OR r.title ILIKE '%'||$2||'%'
                  OR r.description ILIKE '%'||$2||'%'
                  OR ($3::varchar IS NOT NULL AND r.county ILIKE $3))`,
          [listing.seller_id, l.title, l.county || null]
        );
        for (const m of matches) {
          await query(
            `INSERT INTO notifications (user_id,type,title,body,data)
             VALUES ($1,'request_match','A listing matching your request is now live!',$2,$3)`,
            [m.user_id,
             `"${l.title}" just went live — may match your request: "${m.req_title}". Check it out!`,
             JSON.stringify({ listing_id: id, request_id: m.request_id })]
          ).catch(() => {});
          if (io) {
            io.to(`user:${m.user_id}`).emit("notification", {
              type: "request_match",
              title: "A listing matching your request is now live!",
              body: `"${l.title}" just went live — may match "${m.req_title}"`,
              data: { listing_id: id, request_id: m.request_id }
            });
          }
        }
      } catch (e) { /* non-critical */ }
    })();
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
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_rejected', 'Ad Not Approved', $2, $3)`,
      [listing.seller_id, `Your listing "${listing.title}" was not approved. Reason: ${reason.trim()}`, JSON.stringify({ listing_id: id, reason: reason.trim() })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_rejected", title: "Ad Not Approved", body: `"${listing.title}" — ${reason.trim().slice(0, 80)}`, data: { listing_id: id } });
    sendEmail(listing.email, listing.name, "Your Weka Soko ad was not approved",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" was not approved.\n\nReason: ${reason.trim()}\n\nYou can edit and resubmit at:\n${FRONTEND}\n\nQuestions? Contact support@wekasoko.co.ke\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation reject email]", e.message));
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_reject", targetType: "listing", targetId: id, details: { title: listing.title, reason: reason.trim() }, ip: req.ip });
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
    await query(`UPDATE listings SET status='rejected', moderation_note=$1, reviewed_at=NOW(), updated_at=NOW() WHERE id=$2`, [note.trim(), id]);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, 'listing_changes_requested', 'Changes Needed on Your Ad', $2, $3)`,
      [listing.seller_id, `Your listing "${listing.title}" needs changes before it can go live. Note: ${note.trim()}`, JSON.stringify({ listing_id: id, note: note.trim() })]
    ).catch(() => {});
    const io = req.app?.get("io");
    if (io) io.to(`user:${listing.seller_id}`).emit("notification", { type: "listing_changes_requested", title: "Changes Needed", body: `"${listing.title}" — ${note.trim().slice(0, 80)}`, data: { listing_id: id } });
    sendEmail(listing.email, listing.name, "Changes needed on your Weka Soko ad",
      `Hi ${listing.name},\n\nYour listing "${listing.title}" needs changes before going live.\n\nNote: ${note.trim()}\n\nEdit it at:\n${FRONTEND}\n\nOnce updated it will be re-reviewed automatically.\n\n— Weka Soko`
    ).catch(e => console.error("[Moderation changes email]", e.message));
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "listing_request_changes", targetType: "listing", targetId: id, details: { title: listing.title, note: note.trim() }, ip: req.ip });
    res.json({ ok: true, message: "Change request sent to seller" });
  } catch (err) { next(err); }
});


// ── POST /api/admin/seed-test-data ────────────────────────────────────────────
// One-time endpoint to seed 20 listings + 20 requests for testing.
// Protected by admin auth. Safe to call multiple times (uses ON CONFLICT DO NOTHING).
router.post("/seed-test-data", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const bcrypt = require("bcryptjs");

    const PHOTOS = {
      Electronics: ["https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1461151304267-38535e780c79?w=800&h=600&fit=crop"],
      Vehicles: ["https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1502877338535-766e1452684a?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1542362567-b07e54358753?w=800&h=600&fit=crop"],
      Property: ["https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&h=600&fit=crop"],
      Fashion: ["https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800&h=600&fit=crop"],
      Furniture: ["https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1493663284031-b7e3aaa4cab7?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&h=600&fit=crop"],
      "Home & Garden": ["https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1585320806297-9794b3e4aaae?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1501523460185-2aa5d2a0f981?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1600585154526-990dced4db3d?w=800&h=600&fit=crop"],
      Sports: ["https://images.unsplash.com/photo-1517649763962-0c623066013b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1584464491033-06628f3a6b7b?w=800&h=600&fit=crop"],
      "Baby & Kids": ["https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1555252333-9f8e92e65df9?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1484820540034-c2a4bca8567e?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1596461404969-9ae70f2830c1?w=800&h=600&fit=crop","https://images.unsplash.com/photo-1631377509942-0bddab5ae5d5?w=800&h=600&fit=crop"],
    };

    const LISTINGS = [
      { title:"Samsung Galaxy S23 Ultra – Excellent Condition", category:"Electronics", subcat:"Phones & Tablets", price:85000, county:"Nairobi", location:"Westlands, Nairobi", description:"Samsung Galaxy S23 Ultra with 256GB storage and 12GB RAM. Used for 8 months, no scratches on screen (always had a screen protector). Comes with original box, charger, and two cases. Battery health at 96%. Unlocked and works with all networks. Selling because I upgraded to S24. Serious buyers only — can meet at Westlands for inspection." },
      { title:"MacBook Pro M2 14-inch – 2023 Model", category:"Electronics", subcat:"Computers & Laptops", price:175000, county:"Nairobi", location:"Kilimani, Nairobi", description:"Apple MacBook Pro 14-inch with M2 Pro chip, 16GB RAM, 512GB SSD. Purchased in January 2023 from iStore. Minor wear on the bottom, screen is perfect with no dead pixels. Comes with charger and original box. Battery cycle count is 187. Great for developers, designers, and video editors. Willing to negotiate slightly for serious buyers." },
      { title:"Toyota Premio 2008 – Full Option, Clean", category:"Vehicles", subcat:"Cars", price:1250000, county:"Nairobi", location:"South B, Nairobi", description:"Toyota Premio 2008 model, 2000cc engine, automatic transmission. Full option with leather seats, sunroof, reverse camera, and factory AC. First owner in Kenya, NTSA logbook ready. Mileage 98,000km on original engine. Colour: Silver. No accidents, just regular service at Toyota Kenya. Selling due to relocation. Serious inquiries only — test drive available." },
      { title:"3-Bedroom Apartment for Sale – Kilimani", category:"Property", subcat:"Apartments", price:8500000, county:"Nairobi", location:"Kilimani, Nairobi", description:"Spacious 3-bedroom apartment on the 4th floor of a secure gated complex in Kilimani. Each bedroom is ensuite with fitted wardrobes. Open-plan living and dining area, modern kitchen with granite countertops. 24hr security, backup generator, borehole water, and 2 parking slots. Close to Valley Arcade and Yaya Centre. Title deed available. Selling for KSh 8.5M negotiable." },
      { title:"Sofa Set – L-Shaped 7-Seater, Dark Grey", category:"Furniture", subcat:"Sofas & Couches", price:45000, county:"Nairobi", location:"Ngong Road, Nairobi", description:"High-quality L-shaped 7-seater sofa in dark grey fabric with hardwood frame. Bought from Kings Furniture 18 months ago for KSh 75,000. In great condition — no tears, firm cushions. Selling because we're redecorating. Measurements: 3.2m x 2.1m. Must arrange own transport. Located near Prestige Plaza, Ngong Road." },
      { title:"iPhone 14 Pro Max 256GB – Deep Purple", category:"Electronics", subcat:"Phones & Tablets", price:95000, county:"Mombasa", location:"Nyali, Mombasa", description:"iPhone 14 Pro Max, 256GB, Deep Purple. Purchased from Safaricom Shop Mombasa. Used for 10 months, always in a case with tempered glass. Face ID works perfectly, all cameras in perfect condition. Battery health 91%. iCloud account removed, ready to use. Comes with original Apple cable and documentation. No exchange, strictly cash payment." },
      { title:"Riding Lawn Mower – Honda HRX217", category:"Sports", subcat:"Outdoor & Fitness", price:38000, county:"Kiambu", location:"Ruaka, Kiambu", description:"Honda HRX217 riding lawn mower, barely used — only 3 seasons. Self-propelled with variable speed, 21-inch cutting width, and bag attachment. Engine starts first pull every time. Cuts up to 1/3 acre per tank. Selling because we landscaped to paving. Original manual included. Can demonstrate before purchase." },
      { title:"Kitenge Wrap Dress – New, Size M", category:"Fashion", subcat:"Women's Clothing", price:2800, county:"Nairobi", location:"Eastleigh, Nairobi", description:"Brand new Kitenge wrap dress, vibrant orange and yellow African print, size M (fits UK 10-12). Never worn — bought for an event that was cancelled. Fully lined, V-neckline, adjustable tie waist. Machine washable. Perfect for weddings, graduations, or office wear. Can post via G4S for KSh 350 or meet in Eastleigh, Nairobi." },
      { title:"Baby Cot with Mattress – Like New", category:"Baby & Kids", subcat:"Baby Gear", price:8500, county:"Nairobi", location:"Karen, Nairobi", description:"Beautiful white wooden cot with adjustable base height and matching mattress. Used for 14 months only. No chipped paint, wheels lock securely. Cot converts to toddler bed by removing one side. Mattress is waterproof-covered and in excellent condition. Comes with fitted sheet. Child is now in big bed so selling. Located in Karen." },
      { title:"Zanzibar Dining Table Set – 6 Seater", category:"Furniture", subcat:"Tables & Dining", price:32000, county:"Mombasa", location:"Bamburi, Mombasa", description:"Solid mahogany 6-seater dining table with padded chairs in cream fabric. Made by a local carpenter to custom spec, purchased 2 years ago. Table measures 180cm x 90cm. Two chairs have minor fabric staining. Legs are solid, no wobble. Selling due to house move. Can arrange delivery within Mombasa for KSh 2,000 extra." },
      { title:"Nikon D7500 Camera + 18-140mm Lens", category:"Electronics", subcat:"Cameras & Photography", price:62000, county:"Nairobi", location:"Upperhill, Nairobi", description:"Nikon D7500 DSLR body (shutter count: 12,400) with 18-140mm VR kit lens. Includes 64GB SD card, UV filter, 2 batteries, and original charger. All autofocus points working, sensor clean. Original box and manual included. Perfect for events, wildlife, and travel photography. Selling because I switched to mirrorless." },
      { title:"Mitsubishi Outlander 2015 – 7-Seater, 4WD", category:"Vehicles", subcat:"Cars", price:2800000, county:"Nairobi", location:"Lavington, Nairobi", description:"Mitsubishi Outlander 2015, 2400cc 4WD, 7-seater SUV. Sunroof, leather interior, factory navigation, dual-zone AC. Driven 72,000km. Full service history with dealer, last service November 2025. Brand new tyres December 2025. No accident history. NTSA inspection valid. Can transfer ownership immediately." },
      { title:"Standing Desk – Electric Height Adjustable", category:"Furniture", subcat:"Office Furniture", price:28000, county:"Nairobi", location:"Westlands, Nairobi", description:"Flexispot E2 electric standing desk, 140cm x 70cm white surface. Memory settings for 3 heights, smooth motor, max 125kg load. Only 6 months old — bought for home office setup that I'm moving out of. Height range 71–121cm. Comes with cable tray and assembly tools." },
      { title:"Fully Furnished Studio – Short Let Available", category:"Property", subcat:"Houses & Villas", price:25000, county:"Nairobi", location:"Parklands, Nairobi", description:"Modern studio apartment available for short or long-term letting in Parklands. Fully furnished with queen bed, wardrobe, TV, fast WiFi, and fully-equipped kitchen. Monthly rate KSh 25,000 all-inclusive (water, electricity, WiFi). Secure compound. Walking distance to City Park and Aga Khan Hospital. Minimum 3-month stay." },
      { title:"Mountain Bike – Trek Marlin 7, 2022", category:"Sports", subcat:"Bikes & Cycling", price:52000, county:"Nairobi", location:"Lavington, Nairobi", description:"Trek Marlin 7, 2022 edition, size M (fits riders 170–178cm). Hardtail mountain bike with SR Suntour fork, Shimano Deore drivetrain, hydraulic disc brakes. Ridden about 1,500km, well-maintained. New brake pads fitted last month. Original Trek receipt available. Ideal for Karura Forest or Ngong Hills riding." },
      { title:"LG 55-inch OLED TV – Perfect Picture", category:"Electronics", subcat:"TVs & Home Cinema", price:78000, county:"Nairobi", location:"Kileleshwa, Nairobi", description:"LG C2 55-inch OLED TV (2022 model). Perfect blacks, incredible colour accuracy — no burn-in. Used mainly for streaming and gaming. Comes with original remote, stand, HDMI cables, and original box. WebOS smart TV with built-in Netflix, YouTube, and Prime Video. Selling due to upgrade to 77-inch." },
      { title:"Kenyan Handmade Jewellery Set – Gold Beaded", category:"Fashion", subcat:"Accessories", price:3500, county:"Nairobi", location:"Maasai Market, Nairobi", description:"Hand-crafted Kenyan Maasai beaded jewellery set: necklace, bracelet, and earrings in gold, red, and blue. Made by an artisan from Kajiado County. Never worn — gift that doesn't suit my style. Makes a beautiful cultural statement or a perfect gift. Can ship within Kenya." },
      { title:"Gas Cooker – Nunix 4-Burner Stainless Steel", category:"Home & Garden", subcat:"Kitchen Appliances", price:9500, county:"Kisumu", location:"Milimani, Kisumu", description:"Nunix 4-burner gas cooker with auto-ignition, stainless steel surface. 18 months old, works perfectly. All 4 burners light on first press, no leaks. Includes original grill rack and pan supports. Selling because I upgraded to a built-in hob during kitchen renovation." },
      { title:"Toddler Bike with Training Wheels – Age 2–5", category:"Baby & Kids", subcat:"Toys & Games", price:3200, county:"Nairobi", location:"Runda, Nairobi", description:"Bright red children's balance and pedal bike with removable training wheels, suitable for kids aged 2–5. Used for one season. Tyres have good tread, brakes work well. Adjustable seat height. No rust. Training wheels can be removed once balance is mastered. Collection only from Runda." },
      { title:"Professional Kitchen Mixer – KitchenAid 5Qt", category:"Home & Garden", subcat:"Kitchen Appliances", price:32000, county:"Nairobi", location:"Hurlingham, Nairobi", description:"KitchenAid Artisan 5Qt stand mixer in Empire Red. All 10 speeds working perfectly. Includes flat beater, dough hook, and wire whisk. Bowl has minor scratch on the base (doesn't affect use). Purchased from Carrefour for KSh 49,000. Perfect for bakers — handles bread dough with ease." },
    ];

    const REQUESTS = [
      { title:"Looking for a Good Condition Toyota Axio or Premio", category:"Vehicles", county:"Nairobi", budget:900000, description:"Looking for a Toyota Axio or Premio, 2010–2015 model. Budget is KSh 850K–900K. Must have full logbook ready for transfer. Prefer auto transmission, original paint. Mileage should be under 120,000km. I'm in South B and can meet for inspection in Nairobi CBD or South C. No accidents, no flood damage." },
      { title:"Need a Reliable Laptop for University Use", category:"Electronics", county:"Nairobi", budget:45000, description:"Looking for a laptop for university assignments, Zoom lectures, and light coding. Budget KSh 35K–45K. Must have minimum 8GB RAM and SSD storage. Brands preferred: Dell, HP, or Lenovo. Windows 10/11 is fine. Must have at least 4 hours battery life. Screen size 14–15 inches preferred." },
      { title:"Wanted: L-Shaped Sofa for Living Room", category:"Furniture", county:"Mombasa", budget:35000, description:"Looking for a clean, good-condition L-shaped sofa for a 3-bedroom house in Mombasa. Budget up to KSh 35,000. Prefer grey or beige colour. Fabric or faux leather is fine. Must be in Mombasa or Kilifi. No torn cushions, no strong odors. Prefer modern design." },
      { title:"iPhone 13 or 14 in Good Condition", category:"Electronics", county:"Nairobi", budget:65000, description:"Looking for an iPhone 13 or 14 (not Pro), 128GB or 256GB. Budget KSh 55K–65K. Must have battery health above 85%, Face ID working, no cracks on screen or back glass. Must be iCloud unlocked. Prefer to meet in person for inspection. No phones with IMEI issues." },
      { title:"Wanted: 2–3 Bedroom House to Rent in Kilimani", category:"Property", county:"Nairobi", budget:60000, description:"Looking for a 2 or 3-bedroom apartment or townhouse to rent in Kilimani, Lavington, or Kileleshwa. Budget KSh 50K–60K per month. Must have 24hr security, parking, backup water, and reliable electricity. Family with 2 kids, no pets. Need to move in by end of month." },
      { title:"Looking for a Sewing Machine – Home Use", category:"Electronics", county:"Nairobi", budget:12000, description:"Looking for a good quality home sewing machine, manual or electric. Budget up to KSh 12,000. Brands like Singer, Brother, or Janome preferred. Must have basic straight stitch and zigzag functions. Located in Eastleigh, can collect from Nairobi CBD or Eastleigh area." },
      { title:"Need a Baby Cot or Crib – Newborn", category:"Baby & Kids", county:"Nairobi", budget:9000, description:"Expecting first baby in 3 months and looking for a cot or crib for a newborn. Budget up to KSh 9,000 including mattress. Must be in very clean condition — no broken bars, all bolts present. Prefer white or natural wood colour. Happy to collect from Westlands, Ruaka, or Limuru area." },
      { title:"Wanted: DSLR Camera for Photography Starter", category:"Electronics", county:"Nairobi", budget:40000, description:"Starting out in photography and looking for a beginner DSLR camera. Nikon D3500, D5600, or Canon EOS 200D preferred. Budget KSh 30K–40K. Must come with at least 18-55mm kit lens. Shutter count should be under 30,000. Must have working autofocus and live view." },
      { title:"Looking for Office Chair – Ergonomic", category:"Furniture", county:"Nairobi", budget:15000, description:"Working from home and need a good ergonomic office chair. Budget up to KSh 15,000. Must have lumbar support and adjustable armrests. Mesh back preferred. Should be in good condition — no torn fabric, all adjustment mechanisms working. Located in Westlands." },
      { title:"Wanted: Mountain Bike for Weekend Rides", category:"Sports", county:"Nairobi", budget:35000, description:"Looking for a mountain bike for recreational weekend riding in Karura Forest and Ngong Hills. Budget KSh 25K–35K. Brands: Trek, Giant, Specialized, or Merida. Size: M or L (rider height 178cm). Must have disc brakes and 21+ speeds." },
      { title:"Looking for a 4K TV – 50 to 55 inches", category:"Electronics", county:"Nairobi", budget:55000, description:"Looking for a 50 or 55-inch 4K smart TV. Budget up to KSh 55,000. Brands: Samsung, LG, or Sony preferred. Must have at least 2 HDMI ports, built-in WiFi, and smart TV functions. No burn-in or dead pixels. Remote must be included." },
      { title:"Need Dining Table Set for 4–6 People", category:"Furniture", county:"Mombasa", budget:25000, description:"Looking for a dining table that seats 4–6 people for a house in Nyali, Mombasa. Budget up to KSh 25,000. Glass top or wooden top, both fine. Chairs must be included and in good condition. Must be in Mombasa or Kilifi." },
      { title:"Wanted: Women's Business Suits – Size 14–16", category:"Fashion", county:"Nairobi", budget:8000, description:"Looking for 2–3 women's business suits (jacket + trousers or skirt) in size UK 14–16. Budget KSh 4,000–8,000 per set. Neutral colours: black, navy, grey, or charcoal. Must be in excellent condition — no pilling, no fading, no missing buttons." },
      { title:"Looking for a Gas Cooker – 2 or 4 Burner", category:"Home & Garden", county:"Kisumu", budget:8000, description:"Looking for a gas cooker in Kisumu. 2 or 4 burner, any brand that's reliable. Budget up to KSh 8,000. Must have auto-ignition. All burners must work. Based in Kisumu Milimani." },
      { title:"Wanted: PlayStation 4 or PS5 Console", category:"Electronics", county:"Nairobi", budget:30000, description:"Looking for a PS4 Pro or PS5 console for gaming. Budget KSh 20K–30K. Must come with at least one working controller. HDMI port must work, disc drive must work. No banned accounts. I'm in Nairobi South C area." },
      { title:"Looking for Kids' Bicycle Age 6–10", category:"Baby & Kids", county:"Nairobi", budget:6000, description:"My son is turning 8 and loves cycling. Looking for a proper children's bike, 20-inch wheels. Budget KSh 4,500–6,000. Must have working brakes. Training wheels not needed. Any colour — my son loves blue or red. Can collect from most Nairobi areas." },
      { title:"Need a Stand Mixer for Home Baking", category:"Home & Garden", county:"Nairobi", budget:20000, description:"I bake cakes and bread every weekend and my hand mixer is dying. Looking for a stand mixer, minimum 3.5Qt bowl. Budget KSh 15K–20K. Brands: KitchenAid, Kenwood, Tefal, or similar. Must have dough hook, flat beater, and whisk attachments." },
      { title:"Wanted: Plot in Rongai or Kiserian Area", category:"Property", county:"Kajiado", budget:600000, description:"Looking for a residential plot in Rongai, Kiserian, or Ngong area. Budget KSh 500K–600K. Minimum 50x100ft (1/8 acre). Must have title deed or be in the process of titling. Road access is a must. Serious sellers only." },
      { title:"Looking for a Treadmill for Home Gym", category:"Sports", county:"Nairobi", budget:25000, description:"Setting up a home gym and looking for a treadmill. Budget KSh 18K–25K. Motorised preferred. Must handle runners up to 95kg. Speed range 1–14 km/h. Incline feature is a bonus. Located in Westlands." },
      { title:"Wanted: Second-Hand Refrigerator – 200–300 Litre", category:"Home & Garden", county:"Nairobi", budget:18000, description:"Moving to a new house and need a fridge. Looking for a 200–300 litre refrigerator in good working condition. Budget KSh 12K–18K. Must cool properly. No strong odors inside. Compressor must be working. Located in Embakasi." },
    ];

    // Upsert test seller
    const sellerHash = await bcrypt.hash("TestSeller@2024!", 10);
    const sellerRes = await query(
      `INSERT INTO users (name, email, password_hash, role, anon_tag, is_verified, account_status)
       VALUES ('Test Seller Kenya', 'testseller@wekasoko.test', $1, 'seller', 'TestSellerKenya01', true, 'active')
       ON CONFLICT (email) DO UPDATE SET password_hash=$1, role='seller', is_verified=true
       RETURNING id`,
      [sellerHash]
    );
    const sellerId = sellerRes.rows[0].id;

    // Upsert test buyer
    const buyerHash = await bcrypt.hash("TestBuyer@2024!", 10);
    const buyerRes = await query(
      `INSERT INTO users (name, email, password_hash, role, anon_tag, is_verified, account_status)
       VALUES ('Test Buyer Kenya', 'testbuyer@wekasoko.test', $1, 'buyer', 'TestBuyerKenya01', true, 'active')
       ON CONFLICT (email) DO UPDATE SET password_hash=$1, role='buyer', is_verified=true
       RETURNING id`,
      [buyerHash]
    );
    const buyerId = buyerRes.rows[0].id;

    let listingsCreated = 0;
    let requestsCreated = 0;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < LISTINGS.length; i++) {
      const l = LISTINGS[i];
      const photosArr = PHOTOS[l.category] || PHOTOS.Electronics;
      const r = await query(
        `INSERT INTO listings (seller_id,title,description,price,category,subcat,location,county,status,expires_at,view_count,interest_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11)
         RETURNING id`,
        [sellerId, l.title, l.description, l.price, l.category, l.subcat||null, l.location, l.county,
         expiresAt, Math.floor(Math.random()*120)+5, Math.floor(Math.random()*8)]
      );
      if (r.rows.length) {
        const listingId = r.rows[0].id;
        for (let j = 0; j < photosArr.length; j++) {
          await query(
            `INSERT INTO listing_photos (listing_id, url, public_id, sort_order) VALUES ($1,$2,$3,$4)`,
            [listingId, photosArr[j], `seed_${i}_${j}`, j]
          );
        }
        listingsCreated++;
      }
    }

    for (let i = 0; i < REQUESTS.length; i++) {
      const r = REQUESTS[i];
      const res2 = await query(
        `INSERT INTO buyer_requests (user_id,title,description,budget,category,county,status)
         VALUES ($1,$2,$3,$4,$5,$6,'active')
         RETURNING id`,
        [buyerId, r.title, r.description, r.budget, r.category, r.county]
      );
      if (res2.rows.length) requestsCreated++;
    }

    res.json({
      ok: true,
      listingsCreated,
      requestsCreated,
      sellerId,
      buyerId,
      testAccounts: {
        seller: { email: "testseller@wekasoko.test", password: "TestSeller@2024!" },
        buyer:  { email: "testbuyer@wekasoko.test",  password: "TestBuyer@2024!" },
      }
    });
  } catch (err) { next(err); }
});

// ── RISK 10: ADMIN AUDIT LOG ──────────────────────────────────────────────────

router.get("/audit-log", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await query(
      `SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await query(`SELECT COUNT(*) FROM admin_audit_log`);
    res.json({ log: rows, total: parseInt(countRows[0].count) });
  } catch (err) { next(err); }
});

// ── RISK 5: MAINTENANCE MODE ──────────────────────────────────────────────────
const { getMaintenanceState, invalidateMaintenanceCache } = require("../middleware/maintenance");

router.get("/maintenance", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const state = await getMaintenanceState();
    res.json(state);
  } catch (err) { next(err); }
});

router.post("/maintenance", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { enabled, message } = req.body;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
    await query(`UPDATE platform_config SET value=$1, updated_at=NOW(), updated_by=$2 WHERE key='maintenance_mode'`, [String(enabled), req.user.id]);
    if (message) await query(`UPDATE platform_config SET value=$1, updated_at=NOW(), updated_by=$2 WHERE key='maintenance_message'`, [message, req.user.id]);
    invalidateMaintenanceCache();
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: enabled ? "maintenance_on" : "maintenance_off", details: { message }, ip: req.ip });
    res.json({ ok: true, enabled, message: message || undefined });
  } catch (err) { next(err); }
});

// ── RISK 2: ADMIN MANUAL PAYMENT CONFIRMATION ─────────────────────────────────
router.post("/payments/:id/manual-confirm", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { mpesa_receipt } = req.body;
    if (!mpesa_receipt) return res.status(400).json({ error: "mpesa_receipt required" });
    const { rows } = await query(`SELECT * FROM payments WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const payment = rows[0];
    if (payment.status === "confirmed") return res.status(400).json({ error: "Already confirmed" });
    await query(`UPDATE payments SET status='confirmed', mpesa_receipt=$1, confirmed_at=NOW() WHERE id=$2`, [mpesa_receipt.trim().toUpperCase(), payment.id]);
    if (payment.type === "unlock") {
      await query(`UPDATE listings SET is_contact_public=TRUE, unlocked_at=NOW() WHERE id=$1`, [payment.listing_id]);
    }
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "manual_payment_confirm", targetType: "payment", targetId: payment.id, details: { mpesa_receipt, type: payment.type }, ip: req.ip });
    res.json({ ok: true, message: `Payment confirmed with receipt ${mpesa_receipt.trim().toUpperCase()}` });
  } catch (err) { next(err); }
});

router.get("/payments/pending", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, u.name AS payer_name, u.email AS payer_email, l.title AS listing_title
       FROM payments p JOIN users u ON u.id=p.payer_id LEFT JOIN listings l ON l.id=p.listing_id
       WHERE p.status='pending' ORDER BY p.created_at DESC LIMIT 100`
    );
    res.json({ payments: rows });
  } catch (err) { next(err); }
});

// ── RISK 6: EMERGENCY BROADCAST ───────────────────────────────────────────────
router.post("/broadcast", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, body, type = "announcement" } = req.body;
    if (!title || !body) return res.status(400).json({ error: "title and body required" });
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       SELECT id, $1, $2, $3, $4 FROM users WHERE is_suspended=FALSE AND account_status='active'`,
      [type, title, body, JSON.stringify({ broadcast: true })]
    );
    const { rows: countRows } = await query(`SELECT COUNT(*) FROM users WHERE is_suspended=FALSE AND account_status='active'`);
    const count = parseInt(countRows[0].count);
    const io = req.app.get("io");
    if (io) io.emit("notification", { type, title, body, data: { broadcast: true } });
    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "emergency_broadcast", details: { title, body, recipients: count }, ip: req.ip });
    res.json({ ok: true, sent_to: count });
  } catch (err) { next(err); }
});

// ── POST /api/admin/listings/:id/discount ──────────────────────────────────────
// Grant a flat KSh discount on the unlock fee for a specific listing.
// discount_amount = 0-260 (250 = free unlock). Seller is notified immediately.
router.post("/listings/:id/discount", requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const discount = parseInt(req.body.discount_amount);
    const UNLOCK_FEE = parseInt(process.env.UNLOCK_FEE_KES || "260");
    if (isNaN(discount) || discount < 0 || discount > UNLOCK_FEE)
      return res.status(400).json({ error: `discount_amount must be between 0 and ${UNLOCK_FEE}` });

    const { rows } = await query(
      `SELECT l.id, l.title, l.seller_id, u.name AS seller_name, u.email AS seller_email
       FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE l.id = $1 AND l.status != 'deleted'`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = rows[0];

    await query(`UPDATE listings SET unlock_discount = $1 WHERE id = $2`, [discount, id]);

    const finalFee = Math.max(0, UNLOCK_FEE - discount);
    const notifTitle = discount >= UNLOCK_FEE
      ? "Free unlock granted for your listing!"
      : `Discount applied — only KSh ${finalFee} to unlock your listing`;
    const notifBody = discount >= UNLOCK_FEE
      ? `Good news! The admin has granted a FREE unlock for "${listing.title}". You can now reveal your buyer's contact at no cost.`
      : `The admin has applied a KSh ${discount} discount on the unlock fee for "${listing.title}". You only need to pay KSh ${finalFee} (was KSh ${UNLOCK_FEE}) to reveal your buyer's contact.`;

    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'unlock_discount', $2, $3, $4)`,
      [listing.seller_id, notifTitle, notifBody, JSON.stringify({ listing_id: id, discount, final_fee: finalFee })]
    ).catch(() => {});
    pushNotification(listing.seller_id, { type: "unlock_discount", title: notifTitle, body: notifBody });

    const { sendEmail } = require("../services/email.service");
    sendEmail(listing.seller_email, listing.seller_name, notifTitle, notifBody).catch(() => {});

    await auditLog({ adminId: req.user.id, adminEmail: req.user.email, action: "unlock_discount", targetType: "listing", targetId: id, details: { discount, final_fee: finalFee, title: listing.title }, ip: req.ip });

    res.json({ ok: true, listing_id: id, discount, final_fee: finalFee });
  } catch (err) { next(err); }
});

module.exports = router;
