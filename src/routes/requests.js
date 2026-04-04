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
// Create a new buyer request + notify matching sellers
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title, description, budget, county, category, subcat, keywords, min_price, max_price } = req.body;
    if (!title || !description) return res.status(400).json({ error: "Title and description are required" });
    if (title.length > 120) return res.status(400).json({ error: "Title too long (max 120 chars)" });

    const { rows } = await query(
      `INSERT INTO buyer_requests
         (user_id, title, description, budget, county, category, subcat, keywords, min_price, max_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, title.trim(), description.trim(),
       budget ? parseFloat(budget) : null, county || null,
       category || null, subcat || null, keywords || null,
       min_price ? parseFloat(min_price) : null,
       max_price ? parseFloat(max_price) : null]
    );
    const request = rows[0];
    res.status(201).json(request);

    // Async: find active sellers whose listings match this new request — notify them
    (async () => {
      try {
        const priceFilter = [];
        const priceParams = [req.user.id, title.trim()];
        if (budget) { priceParams.push(parseFloat(budget)); priceFilter.push(`l.price <= $${priceParams.length}`); }
        if (category) { priceParams.push(category); priceFilter.push(`l.category ILIKE $${priceParams.length}`); }

        const { rows: matches } = await query(
          `SELECT DISTINCT l.seller_id, l.id AS listing_id, l.title AS listing_title, u.anon_tag
           FROM listings l JOIN users u ON u.id = l.seller_id
           WHERE l.status = 'active'
             AND l.seller_id != $1
             AND (l.title ILIKE '%'||$2||'%' OR l.description ILIKE '%'||$2||'%'
                  OR $2 ILIKE '%'||l.title||'%')
             ${priceFilter.length ? 'AND ' + priceFilter.join(' AND ') : ''}
           LIMIT 20`,
          priceParams
        );

        const io = global._io;
        for (const m of matches) {
          await query(
            `INSERT INTO notifications (user_id,type,title,body,data)
             VALUES ($1,'listing_match','A buyer wants what you have!',$2,$3)
             ON CONFLICT DO NOTHING`,
            [m.seller_id,
             `A buyer is looking for "${title.trim()}"${budget ? ` — budget KSh ${parseFloat(budget).toLocaleString()}` : ""}. You may have what they need!`,
             JSON.stringify({ request_id: request.id, listing_id: m.listing_id })]
          ).catch(() => {});
          if (io) {
            io.to(`user:${m.seller_id}`).emit("notification", {
              type: "listing_match",
              title: "A buyer wants what you have!",
              body: `Someone is looking for "${title.trim()}"${budget ? ` — budget KSh ${parseFloat(budget).toLocaleString()}` : ""}`,
              data: { request_id: request.id }
            });
          }
        }
      } catch (e) { /* non-critical */ }
    })();
  } catch (err) { next(err); }
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
