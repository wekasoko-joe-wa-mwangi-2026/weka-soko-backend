// src/routes/listings.js
const express = require("express");
const multer = require("multer");
const { query, withTransaction } = require("../db/pool");
const { requireAuth, optionalAuth, requireSeller } = require("../middleware/auth");
const { uploadBuffer } = require("../services/cloudinary.service");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 8 } });

// ── GET /api/listings ─────────────────────────────────────────────────────────
// Public listing feed with search & filters
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { category, search, minPrice, maxPrice, page = 1, limit = 20, sort = "newest" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ["l.status = 'active'"];

    if (category) {
      params.push(category);
      conditions.push(`l.category = $${params.length}`);
    }

    if (minPrice) {
      params.push(parseFloat(minPrice));
      conditions.push(`l.price >= $${params.length}`);
    }

    if (maxPrice) {
      params.push(parseFloat(maxPrice));
      conditions.push(`l.price <= $${params.length}`);
    }

    let searchClause = "";
    if (search) {
      params.push(search);
      searchClause = `, ts_rank(l.search_vector, plainto_tsquery('english', $${params.length})) AS rank`;
      conditions.push(`l.search_vector @@ plainto_tsquery('english', $${params.length})`);
    }

    const sortMap = {
      newest: "l.created_at DESC",
      oldest: "l.created_at ASC",
      price_asc: "l.price ASC",
      price_desc: "l.price DESC",
      popular: "l.view_count DESC",
    };
    const orderBy = search ? "rank DESC, l.created_at DESC" : (sortMap[sort] || "l.created_at DESC");

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    params.push(parseInt(limit), offset);

    const sql = `
      SELECT
        l.id, l.title, l.category, l.price, l.location, l.status,
        l.is_unlocked, l.view_count, l.interest_count, l.created_at,
        l.locked_buyer_id,
        -- Show seller anon tag (never real name unless unlocked)
        u.anon_tag AS seller_anon,
        -- Only reveal seller details if unlocked
        CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
        CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
        CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
        -- Photos
        COALESCE(
          (SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id = l.id),
          '[]'::json
        ) AS photos
        ${searchClause}
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await query(sql, params);

    // Count total
    const countParams = params.slice(0, -2);
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM listings l ${where}`,
      countParams
    );

    res.json({
      listings: rows,
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      pages: Math.ceil(parseInt(countRows[0].count) / parseInt(limit)),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/listings/:id ─────────────────────────────────────────────────────
router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      `SELECT
        l.*,
        u.anon_tag AS seller_anon,
        CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
        CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
        CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
        COALESCE(
          (SELECT json_agg(json_build_object('url', p.url, 'sort_order', p.sort_order) ORDER BY p.sort_order)
           FROM listing_photos p WHERE p.listing_id = l.id),
          '[]'::json
        ) AS photos
       FROM listings l
       JOIN users u ON u.id = l.seller_id
       WHERE l.id = $1 AND l.status != 'deleted'`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: "Listing not found" });

    // Increment view count (skip if seller viewing own listing)
    const listing = rows[0];
    if (!req.user || req.user.id !== listing.seller_id) {
      await query(`UPDATE listings SET view_count = view_count + 1 WHERE id = $1`, [id]);
      listing.view_count += 1;
    }

    // If current user is the seller, show their own contact
    if (req.user && req.user.id === listing.seller_id) {
      const { rows: sellerRows } = await query(`SELECT name, phone, email FROM users WHERE id = $1`, [req.user.id]);
      listing.seller_name = sellerRows[0].name;
      listing.seller_phone = sellerRows[0].phone;
      listing.seller_email = sellerRows[0].email;
    }

    res.json(listing);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/listings ────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireSeller,
  upload.array("photos", 8),
  async (req, res, next) => {
    try {
      const { title, description, reason_for_sale, category, price, location } = req.body;

      if (!title || !description || !price) {
        return res.status(400).json({ error: "title, description, and price are required" });
      }

      const result = await withTransaction(async (client) => {
        // Insert listing
        const { rows } = await client.query(
          `INSERT INTO listings (seller_id, title, description, reason_for_sale, category, price, location)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [req.user.id, title, description, reason_for_sale, category, parseFloat(price), location]
        );
        const listing = rows[0];

        // Upload photos to Cloudinary
        if (req.files && req.files.length > 0) {
          const photoUploads = await Promise.all(
            req.files.map((file, i) =>
              uploadBuffer(file.buffer, { folder: `weka-soko/listings/${listing.id}` }).then((r) => ({
                ...r,
                sort_order: i,
              }))
            )
          );

          await Promise.all(
            photoUploads.map(({ url, public_id, sort_order }) =>
              client.query(
                `INSERT INTO listing_photos (listing_id, url, public_id, sort_order) VALUES ($1, $2, $3, $4)`,
                [listing.id, url, public_id, sort_order]
              )
            )
          );

          listing.photos = photoUploads.map((p) => p.url);
        } else {
          listing.photos = [];
        }

        return listing;
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/listings/:id ───────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, reason_for_sale, category, price, location } = req.body;

    // Ensure ownership
    const { rows: existing } = await query(`SELECT seller_id FROM listings WHERE id = $1`, [id]);
    if (!existing.length) return res.status(404).json({ error: "Listing not found" });
    if (existing[0].seller_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your listing" });
    }

    const { rows } = await query(
      `UPDATE listings SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        reason_for_sale = COALESCE($3, reason_for_sale),
        category = COALESCE($4, category),
        price = COALESCE($5, price),
        location = COALESCE($6, location),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [title, description, reason_for_sale, category, price ? parseFloat(price) : null, location, id]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/listings/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(`SELECT seller_id FROM listings WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    if (rows[0].seller_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your listing" });
    }
    await query(`UPDATE listings SET status = 'deleted' WHERE id = $1`, [id]);
    res.json({ message: "Listing deleted" });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/listings/seller/mine ─────────────────────────────────────────────
router.get("/seller/mine", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
        COALESCE(
          (SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id = l.id),
          '[]'::json
        ) AS photos
       FROM listings l
       WHERE l.seller_id = $1 AND l.status != 'deleted'
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/listings/:id/lock-in ───────────────────────────────────────────
// Buyer locks in to buy
router.post("/:id/lock-in", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(`SELECT * FROM listings WHERE id = $1 AND status = 'active'`, [id]);

    if (!rows.length) return res.status(404).json({ error: "Listing not found or no longer active" });
    const listing = rows[0];

    if (listing.seller_id === req.user.id) return res.status(400).json({ error: "You cannot lock in on your own listing" });
    if (listing.locked_buyer_id) return res.status(409).json({ error: "Another buyer has already locked in on this item" });

    await query(
      `UPDATE listings SET locked_buyer_id = $1, locked_at = NOW(), status = 'locked', interest_count = interest_count + 1 WHERE id = $2`,
      [req.user.id, id]
    );

    // Notify seller
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'buyer_locked_in', '🔥 A buyer has locked in!', $2, $3)`,
      [
        listing.seller_id,
        `A serious buyer has locked in on "${listing.title}". Pay KSh 250 to reveal their contact details.`,
        JSON.stringify({ listing_id: id }),
      ]
    );

    res.json({ message: "Successfully locked in. The seller has been notified." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
