// src/routes/listings.js
const ANON_ADJ  = ["Swift","Bold","Sharp","Bright","Cool","Keen","Wise","Calm","Fierce","Sleek","Prime","Epic","Fresh","Solid","Grand","Noble","Elite","Savvy","Agile","Civic"];
const ANON_NOUN = ["Falcon","Cheetah","Baobab","Serval","Mara","Mamba","Eagle","Kiboko","Tembo","Duma","Simba","Faru","Punda","Tawi","Nguvu","Imara","Jasiri","Hodari","Makini","Shujaa"];
function genListingTag() {
  return ANON_ADJ[Math.floor(Math.random()*ANON_ADJ.length)] +
         ANON_NOUN[Math.floor(Math.random()*ANON_NOUN.length)] +
         Math.floor(10+Math.random()*90);
}

// Kenya counties list (47 counties)
const KENYA_COUNTIES = [
  "Nairobi","Mombasa","Kisumu","Nakuru","Eldoret","Thika","Malindi","Kitale",
  "Garissa","Mumias","Meru","Naivasha","Kericho","Nyeri","Machakos","Embu",
  "Isiolo","Kisii","Homabay","Migori","Siaya","Vihiga","Busia","Bungoma",
  "Kakamega","Trans Nzoia","Uasin Gishu","Elgeyo Marakwet","Nandi","Baringo",
  "Laikipia","Samburu","West Pokot","Turkana","Marsabit","Mandera","Wajir",
  "Tana River","Lamu","Taita Taveta","Kilifi","Kwale","Kajiado","Makueni",
  "Kitui","Mwingi","Nyandarua","Murang'a","Kiambu","Kirinyaga"
];
exports.KENYA_COUNTIES = KENYA_COUNTIES;

const express = require("express");
const multer  = require("multer");
const { query, withTransaction } = require("../db/pool");
const { requireAuth, optionalAuth, requireSeller } = require("../middleware/auth");
const { scanListingForContact } = require("../services/moderation.service");
const { uploadBuffer } = require("../services/cloudinary.service");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024, files: 8 } });

// ── GET /api/listings/counties ────────────────────────────────────────────────
router.get("/counties", (req, res) => res.json(KENYA_COUNTIES));

// ── GET /api/listings ─────────────────────────────────────────────────────────
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const {
      category, search, minPrice, maxPrice,
      county, location,
      page=1, limit=20, sort="newest"
    } = req.query;

    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    const conditions = ["l.status='active'", "l.expires_at > NOW()"];

    if (category)  { params.push(category);          conditions.push(`l.category=$${params.length}`); }
    if (county)    { params.push(county);             conditions.push(`l.county ILIKE $${params.length}`); }
    if (minPrice)  { params.push(parseFloat(minPrice)); conditions.push(`l.price>=$${params.length}`); }
    if (maxPrice)  { params.push(parseFloat(maxPrice)); conditions.push(`l.price<=$${params.length}`); }

    let searchClause = "";
    if (search) {
      params.push(search);
      searchClause = `, ts_rank(l.search_vector, plainto_tsquery('english',$${params.length})) AS rank`;
      conditions.push(`(l.search_vector @@ plainto_tsquery('english',$${params.length}) OR l.location ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }

    // Location text filter (if no full-text search)
    if (location && !search) {
      params.push(`%${location}%`);
      conditions.push(`(l.location ILIKE $${params.length} OR l.county ILIKE $${params.length})`);
    }

    const sortMap = {
      newest: "l.created_at DESC",
      oldest: "l.created_at ASC",
      price_asc: "l.price ASC",
      price_desc: "l.price DESC",
      popular: "l.view_count DESC",
      expiring: "l.expires_at ASC",
    };
    const orderBy = search ? "rank DESC, l.created_at DESC" : (sortMap[sort]||"l.created_at DESC");
    const where = "WHERE " + conditions.join(" AND ");

    params.push(parseInt(limit), offset);
    const sql = `
      SELECT
        l.id, l.title, l.category, l.price, l.location, l.county, l.status,
        l.is_unlocked, l.view_count, l.interest_count, l.created_at, l.expires_at,
        l.locked_buyer_id, l.listing_anon_tag AS seller_anon,
        CASE WHEN l.is_unlocked THEN u.name  ELSE NULL END AS seller_name,
        CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
        CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
        u.response_rate, u.avg_response_hours,
        COALESCE(
          (SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),
          '[]'::json
        ) AS photos
        ${searchClause}
      FROM listings l
      JOIN users u ON u.id=l.seller_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length-1} OFFSET $${params.length}
    `;
    const { rows } = await query(sql, params);
    const countParams = params.slice(0,-2);
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings l ${where}`, countParams);
    res.json({ listings: rows, total: parseInt(cnt[0].count), page: parseInt(page), pages: Math.ceil(parseInt(cnt[0].count)/parseInt(limit)) });
  } catch (err) { next(err); }
});

// ── GET /api/listings/seller/mine ─────────────────────────────────────────────
router.get("/seller/mine", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
        COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l WHERE l.seller_id=$1 AND l.status!='deleted' ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/listings/counties ── (already above) ────────────────────────────

// ── GET /api/listings/:id ─────────────────────────────────────────────────────
router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, l.listing_anon_tag AS seller_anon,
        CASE WHEN l.is_unlocked THEN u.name  ELSE NULL END AS seller_name,
        CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
        CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
        u.response_rate, u.avg_response_hours,
        (SELECT COUNT(*) FROM listing_reports r WHERE r.listing_id=l.id AND r.status='pending') AS pending_reports,
        COALESCE(
          (SELECT json_agg(json_build_object('url',p.url,'sort_order',p.sort_order) ORDER BY p.sort_order)
           FROM listing_photos p WHERE p.listing_id=l.id),
          '[]'::json
        ) AS photos
       FROM listings l JOIN users u ON u.id=l.seller_id
       WHERE l.id=$1 AND l.status!='deleted'`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = rows[0];

    if (!req.user || req.user.id !== listing.seller_id) {
      await query(`UPDATE listings SET view_count=view_count+1 WHERE id=$1`, [req.params.id]);
      listing.view_count += 1;
    }
    if (req.user && req.user.id === listing.seller_id) {
      const { rows: sr } = await query(`SELECT name,phone,email FROM users WHERE id=$1`, [req.user.id]);
      listing.seller_name = sr[0].name;
      listing.seller_phone = sr[0].phone;
      listing.seller_email = sr[0].email;
    }
    res.json(listing);
  } catch (err) { next(err); }
});

// ── POST /api/listings ────────────────────────────────────────────────────────
router.post("/", requireAuth, requireSeller, upload.array("photos", 8), async (req, res, next) => {
  try {
    const { title, description, reason_for_sale, category, price, location, county } = req.body;
    if (!title || !description || !price) return res.status(400).json({ error: "title, description, and price are required" });

    // Scan for contact info in listing fields
    const violations = scanListingForContact({ title, description, reason_for_sale, location });
    if (violations.length > 0) {
      return res.status(422).json({
        error: "Your listing contains contact information, which is not allowed. Please remove it and try again.",
        violations,
      });
    }

    // Derive county from location if not provided
    const resolvedCounty = county ||
      KENYA_COUNTIES.find(c => location && location.toLowerCase().includes(c.toLowerCase())) ||
      null;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO listings (seller_id,title,description,reason_for_sale,category,price,location,county,listing_anon_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.user.id, title, description, reason_for_sale, category, parseFloat(price), location, resolvedCounty, genListingTag()]
      );
      const listing = rows[0];
      if (req.files?.length) {
        const uploads = await Promise.all(
          req.files.map((f,i) => uploadBuffer(f.buffer, { folder: `weka-soko/listings/${listing.id}` }).then(r => ({ ...r, sort_order: i })))
        );
        await Promise.all(uploads.map(({ url, public_id, sort_order }) =>
          client.query(`INSERT INTO listing_photos (listing_id,url,public_id,sort_order) VALUES ($1,$2,$3,$4)`, [listing.id, url, public_id, sort_order])
        ));
        listing.photos = uploads.map(p => p.url);
      } else { listing.photos = []; }
      return listing;
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── PATCH /api/listings/:id ───────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, reason_for_sale, category, price, location, county } = req.body;
    const { rows: ex } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [id]);
    if (!ex.length) return res.status(404).json({ error: "Listing not found" });
    if (ex[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });

    const resolvedCounty = county ||
      (location ? KENYA_COUNTIES.find(c => location.toLowerCase().includes(c.toLowerCase())) : undefined);

    // Scan edited fields for contact info
    const violations = scanListingForContact({ title, description, reason_for_sale, location });
    if (violations.length > 0) {
      return res.status(422).json({
        error: "Your listing contains contact information, which is not allowed. Please remove it and try again.",
        violations,
      });
    }

    const { rows } = await query(
      `UPDATE listings SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        reason_for_sale=COALESCE($3,reason_for_sale), category=COALESCE($4,category),
        price=COALESCE($5,price), location=COALESCE($6,location),
        county=COALESCE($7,county), updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [title, description, reason_for_sale, category, price?parseFloat(price):null, location, resolvedCounty||null, id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/listings/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    if (rows[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });
    await query(`UPDATE listings SET status='deleted' WHERE id=$1`, [req.params.id]);
    res.json({ message: "Listing deleted" });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/lock-in ───────────────────────────────────────────
router.post("/:id/lock-in", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM listings WHERE id=$1 AND status='active'`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Listing not found or no longer active" });
    const listing = rows[0];
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: "Cannot lock in on your own listing" });
    if (listing.locked_buyer_id) return res.status(409).json({ error: "Another buyer has already locked in" });

    await query(
      `UPDATE listings SET locked_buyer_id=$1,locked_at=NOW(),status='locked',interest_count=interest_count+1 WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'buyer_locked_in','🔥 A buyer has locked in!',$2,$3)`,
      [listing.seller_id, `A serious buyer locked in on "${listing.title}". Pay KSh 250 to reveal their contact.`, JSON.stringify({ listing_id: req.params.id })]
    );
    res.json({ message: "Locked in. Seller has been notified." });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/report ─────────────────────────────────────────────
router.post("/:id/report", requireAuth, async (req, res, next) => {
  try {
    const { reason, details } = req.body;
    const validReasons = ["scam","fake_item","wrong_price","offensive","spam","wrong_category","already_sold","other"];
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({ error: "Valid reason required", validReasons });
    }

    // Check listing exists
    const { rows: ls } = await query(`SELECT id,seller_id,title FROM listings WHERE id=$1 AND status!='deleted'`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id === req.user.id) return res.status(400).json({ error: "Cannot report your own listing" });

    // Upsert — one report per user per listing
    await query(
      `INSERT INTO listing_reports (listing_id,reporter_id,reason,details)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (listing_id,reporter_id) DO UPDATE SET reason=$3,details=$4,created_at=NOW()`,
      [req.params.id, req.user.id, reason, details||null]
    );

    // Auto-flag listing after 5 reports
    const { rows: cnt } = await query(
      `SELECT COUNT(*) FROM listing_reports WHERE listing_id=$1 AND status='pending'`,
      [req.params.id]
    );
    if (parseInt(cnt[0].count) >= 5) {
      await query(`UPDATE listings SET status='flagged' WHERE id=$1 AND status='active'`, [req.params.id]);
    }

    // Notify admins
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data)
       SELECT id,'listing_report','🚩 Listing Reported',$1,$2
       FROM users WHERE role='admin'`,
      [
        `"${ls[0].title}" was reported for: ${reason}`,
        JSON.stringify({ listing_id: req.params.id, reason, report_count: parseInt(cnt[0].count)+1 })
      ]
    ).catch(()=>{});

    res.json({ ok: true, message: "Report submitted. Our team will review it shortly." });
  } catch (err) { next(err); }
});

// ── DELETE /api/listings/:id/photos/:photoId ─────────────────────────────────
// Seller removes a specific photo from their listing
router.delete("/:id/photos/:photoId", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { rows: ls } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });

    const { rows: ph } = await query(`SELECT public_id FROM listing_photos WHERE id=$1 AND listing_id=$2`, [req.params.photoId, req.params.id]);
    if (!ph.length) return res.status(404).json({ error: "Photo not found" });

    // Delete from Cloudinary if possible
    if (ph[0].public_id) {
      try { const { deleteByPublicId } = require("../services/cloudinary.service"); await deleteByPublicId(ph[0].public_id); } catch {}
    }
    await query(`DELETE FROM listing_photos WHERE id=$1`, [req.params.photoId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/photos ─────────────────────────────────────────────
// Seller adds new photos to an existing listing
router.post("/:id/photos", requireAuth, requireSeller, upload.array("photos", 8), async (req, res, next) => {
  try {
    const { rows: ls } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });
    if (!req.files?.length) return res.status(400).json({ error: "No photos provided" });

    // Get current max sort_order
    const { rows: maxRow } = await query(`SELECT COALESCE(MAX(sort_order),0) AS max FROM listing_photos WHERE listing_id=$1`, [req.params.id]);
    let sortStart = parseInt(maxRow[0].max) + 1;

    const uploads = await Promise.all(
      req.files.map((f, i) => uploadBuffer(f.buffer, { folder: `weka-soko/listings/${req.params.id}` }).then(r => ({ ...r, sort_order: sortStart + i })))
    );
    const inserted = await Promise.all(uploads.map(({ url, public_id, sort_order }) =>
      query(`INSERT INTO listing_photos (listing_id, url, public_id, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, url, public_id, sort_order]).then(r => r.rows[0])
    ));
    res.status(201).json(inserted);
  } catch (err) { next(err); }
});

// ── GET /api/listings/sold ────────────────────────────────────────────────────
// Public feed of sold items (showcase of successful transactions)
router.get("/sold", optionalAuth, async (req, res, next) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    const conditions = ["l.status='sold'"];
    if (category) { params.push(category); conditions.push(`l.category=$${params.length}`); }
    const where = "WHERE " + conditions.join(" AND ");
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.location, l.county, l.status,
              l.view_count, l.interest_count, l.created_at, l.updated_at,
              -- Show seller anon tag (never real identity on sold page)
              l.listing_anon_tag AS seller_anon,
              COALESCE(
                (SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),
                '[]'::json
              ) AS photos,
              -- Review stats
              (SELECT ROUND(AVG(r.rating)::numeric,1) FROM reviews r WHERE r.listing_id=l.id) AS avg_rating,
              (SELECT COUNT(*) FROM reviews r WHERE r.listing_id=l.id) AS review_count
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       ${where}
       ORDER BY l.updated_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings l ${where}`, params.slice(0,-2));
    res.json({ listings: rows, total: parseInt(cnt[0].count), page: parseInt(page), pages: Math.ceil(parseInt(cnt[0].count)/parseInt(limit)) });
  } catch (err) { next(err); }
});

module.exports = router;

// ── GET /api/listings/sold/all ────────────────────────────────────────────────
// Public sold listings feed (marketplace transparency — shows what's been traded)
router.get("/sold/all", async (req, res, next) => {
  try {
    const { page=1, limit=20, category } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    const conditions = ["l.status='sold'"];
    if (category) { params.push(category); conditions.push(`l.category=$${params.length}`); }
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.location, l.county, l.status,
              l.view_count, l.interest_count, l.updated_at AS sold_at,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order LIMIT 1) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l
       WHERE ${conditions.join(" AND ")}
       ORDER BY l.updated_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings l WHERE ${conditions.join(" AND ")}`, params.slice(0,-2));
    res.json({ listings: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/listings/seller/sold ─────────────────────────────────────────────
// Seller's own sold listings
router.get("/seller/sold", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
        COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos,
        u2.anon_tag AS buyer_anon
       FROM listings l
       LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.seller_id=$1 AND l.status='sold'
       ORDER BY l.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});
