// src/routes/requests.js — What Buyers Want
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, optionalAuth } = require("../middleware/auth");

const router = express.Router();

// ── GET /api/requests ──────────────────────────────────────────────────────
// List all active buyer requests (paginated)
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, county, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ["r.status = 'active'"];

    if (county) { params.push(county); conditions.push(`r.county ILIKE $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`(r.title ILIKE $${params.length} OR r.description ILIKE $${params.length})`); }

    const where = "WHERE " + conditions.join(" AND ");
    params.push(parseInt(limit), offset);

    const { rows } = await query(
      `SELECT r.*, u.anon_tag AS requester_anon,
        (SELECT COUNT(*) FROM listings l
         WHERE l.status = 'active'
         AND l.expires_at > NOW()
         AND (l.title ILIKE '%' || r.title || '%' OR l.description ILIKE '%' || r.title || '%')) AS matching_listings
       FROM buyer_requests r
       JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const { rows: cnt } = await query(
      `SELECT COUNT(*) FROM buyer_requests r ${where}`,
      params.slice(0, -2)
    );

    res.json({ requests: rows, total: parseInt(cnt[0].count), page: parseInt(page) });
  } catch (err) { next(err); }
});

// ── POST /api/requests ─────────────────────────────────────────────────────
// Create a new buyer request
router.post("/", requireAuth, async (req, res, next) => {
  try {
    console.log("[POST /api/requests] User:", req.user?.id, "Body:", req.body);
    const { title, description, budget, county } = req.body;
    if (!title || !description) return res.status(400).json({ error: "Title and description are required" });
    if (title.length > 120) return res.status(400).json({ error: "Title too long (max 120 chars)" });
    
    // Validate against contact info leakage
    const titleLower = title.trim().toLowerCase();
    const descLower = description.trim().toLowerCase();
    
    // Check for phone numbers (Kenyan format)
    if (/(?:\+?254|0)\d{7,9}/.test(titleLower) || /(?:\+?254|0)\d{7,9}/.test(descLower)) {
      return res.status(400).json({ error: "Please do not include phone numbers in your request." });
    }
    
    // Check for emails
    if (/@/.test(titleLower) || /@/.test(descLower)) {
      return res.status(400).json({ error: "Please do not include email addresses in your request." });
    }
    
    // Check for social media
    if (/(whatsapp|telegram|viber|signal|facebook|instagram|twitter|tiktok)/.test(titleLower) || /(whatsapp|telegram|viber|signal|facebook|instagram|twitter|tiktok)/.test(descLower)) {
      return res.status(400).json({ error: "Please do not include social media handles in your request." });
    }

    console.log("[POST /api/requests] Inserting request for user:", req.user.id);
    const { rows } = await query(
      `INSERT INTO buyer_requests (user_id, title, description, budget, county, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [req.user.id, title.trim(), description.trim(), budget ? parseFloat(budget) : null, county || null]
    );
    
    console.log("[POST /api/requests] Insert result:", rows);
    if (!rows || rows.length === 0) {
      return res.status(500).json({ error: "Failed to create request" });
    }
    
    console.log("[POST /api/requests] Returning request:", rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) { 
    console.error("[POST /api/requests] Error:", err);
    next(err); 
  }
});

// ── DELETE /api/requests/:id ───────────────────────────────────────────────
// Delete own request (or admin can delete any)
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT user_id FROM buyer_requests WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    if (rows[0].user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your request" });
    }
    await query(`UPDATE buyer_requests SET status = 'deleted' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/requests/mine ─────────────────────────────────────────────────
// Get current user's own requests
router.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM buyer_requests WHERE user_id = $1 AND status != 'deleted' ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
