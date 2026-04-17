// src/routes/listings.js
const ANON_ADJ = ["Swift","Bold","Sharp","Bright","Cool","Keen","Wise","Calm","Fierce","Sleek","Prime","Epic","Fresh","Solid","Grand","Noble","Elite","Savvy","Agile","Civic"];
const ANON_NOUN = ["Falcon","Cheetah","Baobab","Serval","Mara","Mamba","Eagle","Kiboko","Tembo","Duma","Simba","Faru","Punda","Tawi","Nguvu","Imara","Jasiri","Hodari","Makini","Shujaa"];
function genListingTag() { return ANON_ADJ[Math.floor(Math.random()*ANON_ADJ.length)] + ANON_NOUN[Math.floor(Math.random()*ANON_NOUN.length)] + Math.floor(10+Math.random()*90); }

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
const multer = require("multer");
const { query, withTransaction } = require("../db/pool");
const { requireAuth, optionalAuth, requireSeller } = require("../middleware/auth");
const { scanListingForContact } = require("../services/moderation.service");
const { uploadBuffer } = require("../services/cloudinary.service");
const { safeListingUpdate, withLockInTransaction, ConcurrencyError } = require("../services/concurrency.service");
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024, files: 8 } });

// ── GET /api/listings/counties ────────────────────────────────────────────────
router.get("/counties", (req, res) => res.json(KENYA_COUNTIES));

// ── GET /api/listings ─────────────────────────────────────────────────────────
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { category, subcat, search, minPrice, maxPrice, county, location, page=1, limit=20, sort="newest" } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    const conditions = ["l.status='active'", "l.expires_at > NOW()"];
    if (category) { params.push(category); conditions.push(`l.category=$${params.length}`); }
    if (subcat) { params.push(subcat); conditions.push(`l.subcat ILIKE $${params.length}`); }
    if (county) { params.push(county); conditions.push(`l.county ILIKE $${params.length}`); }
    if (minPrice) { params.push(parseFloat(minPrice)); conditions.push(`l.price>=$${params.length}`); }
    if (maxPrice) { params.push(parseFloat(maxPrice)); conditions.push(`l.price<=$${params.length}`); }
    let searchClause = "";
    if (search) {
      params.push(search);
      searchClause = `, ts_rank(l.search_vector, plainto_tsquery('english',$${params.length})) AS rank`;
      conditions.push(`(l.search_vector @@ plainto_tsquery('english',$${params.length}) OR l.location ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }
    if (location && !search) { params.push(`%${location}%`); conditions.push(`(l.location ILIKE $${params.length} OR l.county ILIKE $${params.length})`); }
    const sortMap = { newest:"l.created_at DESC", oldest:"l.created_at ASC", price_asc:"l.price ASC", price_desc:"l.price DESC", popular:"l.view_count DESC", expiring:"l.expires_at ASC" };
    const orderBy = search ? "rank DESC, l.created_at DESC" : (sortMap[sort]||"l.created_at DESC");
    const where = "WHERE " + conditions.join(" AND ");
    params.push(parseInt(limit), offset);
    const sql = `
      SELECT l.id, l.title, l.description, l.reason_for_sale, l.category, l.subcat, l.price, l.location, l.county, l.status,
             l.seller_id, l.is_unlocked, l.is_contact_public, l.linked_request_id, l.view_count, l.interest_count,
             l.created_at, l.expires_at, l.locked_buyer_id,
             l.listing_anon_tag AS seller_anon,
             CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
             CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
             CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
             CASE WHEN l.is_unlocked THEN l.precise_location ELSE NULL END AS precise_location,
             u.response_rate, u.avg_response_hours,
             u.avg_rating AS seller_avg_rating, u.review_count AS seller_review_count,
             COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
             ${searchClause}
      FROM listings l JOIN users u ON u.id=l.seller_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length-1} OFFSET $${params.length}`;
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
      `SELECT l.*, COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l WHERE l.seller_id=$1 AND l.status!='deleted' ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/listings/buyer/interests ─────────────────────────────────────────
router.get("/buyer/interests", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, l.listing_anon_tag AS seller_anon,
              CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
              CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
              CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l JOIN users u ON u.id=l.seller_id
       WHERE l.locked_buyer_id=$1 AND l.status!='deleted' ORDER BY l.locked_at DESC NULLS LAST`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/listings/seller/sold ─────────────────────────────────────────────
// IMPORTANT: Must be before /:id to avoid Express matching "sold" as an id param
router.get("/seller/sold", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.location, l.county, l.status,
              l.view_count, l.interest_count, l.created_at, l.updated_at,
              l.listing_anon_tag AS seller_anon, l.is_unlocked, l.locked_buyer_id,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos,
              u2.anon_tag AS buyer_anon
       FROM listings l LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       WHERE l.seller_id=$1 AND l.status='sold' ORDER BY l.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/listings/sold ────────────────────────────────────────────────────
// IMPORTANT: Must be before /:id
router.get("/sold", optionalAuth, async (req, res, next) => {
  try {
    const { category, page=1, limit=20 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    const conditions = ["l.status='sold'"];
    if (category) { params.push(category); conditions.push(`l.category=$${params.length}`); }
    const where = "WHERE " + conditions.join(" AND ");
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.location, l.county, l.status,
              l.view_count, l.interest_count, l.created_at, l.updated_at,
              COALESCE(l.sold_at, l.updated_at) AS sold_at,
              l.sold_channel,
              l.listing_anon_tag AS seller_anon,
              u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email,
              u2.name AS buyer_name, u2.phone AS buyer_phone, u2.email AS buyer_email,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos,
              (SELECT ROUND(AVG(r.rating)::numeric,1) FROM reviews r WHERE r.listing_id=l.id) AS avg_rating,
              (SELECT COUNT(*) FROM reviews r WHERE r.listing_id=l.id) AS review_count
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       ${where} ORDER BY COALESCE(l.sold_at, l.updated_at) DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings l ${where}`, params.slice(0,-2));
    res.json({ listings: rows, total: parseInt(cnt[0].count), page: parseInt(page), pages: Math.ceil(parseInt(cnt[0].count)/parseInt(limit)) });
  } catch (err) { next(err); }
});

// ── GET /api/listings/sold/all ────────────────────────────────────────────────
// IMPORTANT: Must be before /:id
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
       FROM listings l WHERE ${conditions.join(" AND ")}
       ORDER BY l.updated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listings l WHERE ${conditions.join(" AND ")}`, params.slice(0,-2));
    res.json({ listings: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── GET /api/listings/admin/sold ──────────────────────────────────────────────
// Admin only: Get all sold listings with seller and buyer info
router.get("/admin/sold", requireAuth, async (req, res, next) => {
  try {
    const { q, page=1, limit=50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const params = [];
    let where = "WHERE l.status='sold'";
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (l.title ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1)`;
    }
    params.push(parseInt(limit), offset);
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.location, l.county, l.status,
              l.view_count, l.interest_count, l.created_at,
              COALESCE(l.sold_at, l.updated_at) AS sold_at,
              l.sold_channel,
              u.name AS seller_name, u.email AS seller_email,
              u2.name AS buyer_name, u2.email AS buyer_email,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order LIMIT 1) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       LEFT JOIN users u2 ON u2.id=l.locked_buyer_id
       ${where}
       ORDER BY COALESCE(l.sold_at, l.updated_at) DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await query(
      `SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id LEFT JOIN users u2 ON u2.id=l.locked_buyer_id ${where}`,
      params.slice(0,-2)
    );
    res.json({ listings: rows, total: parseInt(cnt[0].count) });
  } catch (err) { next(err); }
});

// ── POST /api/listings ────────────────────────────────────────────────────────
router.post("/", requireAuth, upload.array("photos", 8), async (req, res, next) => {
  try {
    const { title, description, reason_for_sale, category, subcat, price, location, county, precise_location } = req.body;
    if (!title || !description || !price) return res.status(400).json({ error: "title, description, and price are required" });
    const resolvedCounty = county || KENYA_COUNTIES.find(c => location && location.toLowerCase().includes(c.toLowerCase())) || null;
    // Upload photos to Cloudinary BEFORE opening the DB transaction.
    // This keeps the transaction fast and avoids holding a DB connection
    // open while waiting for external HTTP calls to Cloudinary.
    const tempId = require("crypto").randomUUID(); // temp folder until we have the real listing id
    let preUploads = [];
    if (req.files?.length) {
      try {
        preUploads = await Promise.all(
          req.files.map((f, i) =>
            uploadBuffer(f.buffer, { folder: `weka-soko/listings/tmp-${tempId}` })
              .then(r => ({ ...r, sort_order: i }))
          )
        );
      } catch (uploadErr) {
        console.error("[Cloudinary] Upload failed:", uploadErr.message, uploadErr.http_code);
        return res.status(502).json({ error: "Photo upload failed. Please try again or use smaller images." });
      }
    }

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO listings (seller_id,title,description,reason_for_sale,category,subcat,price,location,county,listing_anon_tag,status,linked_request_id,is_contact_public,precise_location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_review',$11,$12,$13) RETURNING *`,
        [req.user.id, title, description, reason_for_sale, category, subcat||null, parseFloat(price), location, resolvedCounty, genListingTag(),
         req.body.linked_request_id||null,
         req.body.is_contact_public==='true',
         precise_location||null]
      );
      const listing = rows[0];
      if (preUploads.length) {
        await Promise.all(preUploads.map(({ url, public_id, sort_order }) =>
          client.query(
            `INSERT INTO listing_photos (listing_id,url,public_id,sort_order) VALUES ($1,$2,$3,$4)`,
            [listing.id, url, public_id, sort_order]
          )
        ));
        listing.photos = preUploads.map(p => p.url);
      } else { listing.photos = []; }
      return listing;
    });
    const io = req.app?.get("io");
    if (io) io.to("admin").emit("new_listing_review", { listing_id: result.id, title: result.title });
    res.status(201).json(result);
    // Async: notify matching buyer requests
    (async () => {
      try {
        const { rows: matches } = await query(
          `SELECT DISTINCT r.user_id, r.title, r.id AS request_id FROM buyer_requests r
           WHERE r.status='active' AND r.user_id!=$1
             AND ($2 ILIKE '%'||r.title||'%' OR r.title ILIKE '%'||$2||'%'
                  OR r.description ILIKE '%'||$2||'%'
                  OR ($3::varchar IS NOT NULL AND r.county ILIKE $3))`,
          [req.user.id, result.title, result.county||null]
        );
        const io = req.app?.get("io") || global._io;
        for (const match of matches) {
          await query(
            `INSERT INTO notifications (user_id,type,title,body,data)
             VALUES ($1,'request_match','A listing matches your request!',$2,$3)`,
            [match.user_id,
             `"${result.title}" was just listed — it may match your request: "${match.title}"`,
             JSON.stringify({ listing_id: result.id, request_id: match.request_id })]
          ).catch(() => {});
          // Real-time push to buyer
          if (io) {
            io.to(`user:${match.user_id}`).emit("notification", {
              type: "request_match",
              title: "A listing matches your request!",
              body: `"${result.title}" was just listed — may match your request: "${match.title}"`,
              data: { listing_id: result.id, request_id: match.request_id }
            });
          }
        }
      } catch(e) { /* non-critical */ }
    })();
  } catch (err) { next(err); }
});

// ── GET /api/listings/buyer/saved ─────────────────────────────────────────────
router.get("/buyer/saved", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, l.listing_anon_tag AS seller_anon,
              CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
              CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
              CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
              COALESCE((SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos
       FROM saved_listings s JOIN listings l ON l.id=s.listing_id JOIN users u ON u.id=l.seller_id
       WHERE s.user_id=$1 AND l.status!='deleted' ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/listings/buyer/saved/ids ─────────────────────────────────────────
router.get("/buyer/saved/ids", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT listing_id FROM saved_listings WHERE user_id=$1`,
      [req.user.id]
    );
    res.json(rows.map(r => r.listing_id));
  } catch (err) { next(err); }
});

// ── GET /api/listings/:id ─────────────────────────────────────────────────────
router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.description, l.reason_for_sale, l.category, l.subcat,
              l.price, l.location, l.county, l.status,
              l.seller_id, l.is_unlocked, l.is_contact_public, l.linked_request_id,
              l.view_count, l.interest_count, l.created_at, l.expires_at, l.locked_buyer_id,
              l.listing_anon_tag AS seller_anon,
              l.moderation_note,
              CASE WHEN l.is_unlocked THEN u.name ELSE NULL END AS seller_name,
              CASE WHEN l.is_unlocked THEN u.phone ELSE NULL END AS seller_phone,
              CASE WHEN l.is_unlocked THEN u.email ELSE NULL END AS seller_email,
              u.anon_tag AS seller_user_anon,
              COALESCE(
                (SELECT json_agg(p.url ORDER BY p.sort_order)
                 FROM listing_photos p WHERE p.listing_id=l.id), '[]'
              ) AS photos,
              COALESCE(AVG(rv.rating),0) AS seller_avg_rating,
              COUNT(rv.id) AS seller_review_count
       FROM listings l
       JOIN users u ON u.id=l.seller_id
       LEFT JOIN reviews rv ON rv.reviewee_id=l.seller_id
       WHERE l.id=$1
       GROUP BY l.id,u.name,u.phone,u.email,u.anon_tag`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = rows[0];
    // Increment view count
    query(`UPDATE listings SET view_count=view_count+1 WHERE id=$1`, [req.params.id]).catch(()=>{});
    res.json(listing);
  } catch (err) { next(err); }
});


// ── PATCH /api/listings/:id ───────────────────────────────────────────────────
// Uses optimistic locking to prevent lost updates
router.patch("/:id", requireAuth, upload.array("photos", 8), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, reason_for_sale, category, subcat, price, location, county, precise_location, version } = req.body;

    const { rows: ex } = await query(`SELECT seller_id, version FROM listings WHERE id=$1`, [id]);
    if (!ex.length) return res.status(404).json({ error: "Listing not found" });
    if (ex[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });

    if (version !== undefined && version !== ex[0].version) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: ex[0].version
      });
    }

    const resolvedCounty = county || (location ? KENYA_COUNTIES.find(c => location.toLowerCase().includes(c.toLowerCase())) : undefined);

    let patchUploads = [];
    if (req.files?.length) {
      patchUploads = await Promise.all(
        req.files.map((f, i) =>
          uploadBuffer(f.buffer, { folder: `weka-soko/listings/${id}` })
          .then(r => ({ ...r, sort_order: i + 100 }))
        )
      );
    }

    const { rows: preEdit } = await query(`SELECT status FROM listings WHERE id=$1`, [id]);
    const prevStatus = preEdit[0]?.status;
    const newStatus = prevStatus === "pending_review" ? undefined : "pending_review";

    const { rows } = await query(
      `UPDATE listings SET title=COALESCE($1,title), description=COALESCE($2,description),
      reason_for_sale=COALESCE($3,reason_for_sale), category=COALESCE($4,category),
      subcat=COALESCE($5,subcat),
      price=COALESCE($6,price), location=COALESCE($7,location), county=COALESCE($8,county),
      status=COALESCE($10,status),
      moderation_note=CASE WHEN $10='pending_review' THEN NULL ELSE moderation_note END,
      precise_location=COALESCE($11,precise_location),
      version=version+1,
      updated_at=NOW() WHERE id=$9 AND version=$12 RETURNING *`,
      [title, description, reason_for_sale, category, subcat||null, price?parseFloat(price):null, location, resolvedCounty||null, id, newStatus||null, precise_location||null, ex[0].version]
    );

    if (!rows.length) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED"
      });
    }

    if (patchUploads.length) {
      await Promise.all(patchUploads.map(({ url, public_id, sort_order }) =>
        query(`INSERT INTO listing_photos (listing_id,url,public_id,sort_order) VALUES ($1,$2,$3,$4)`, [id, url, public_id, sort_order])
      ));
    }
    const { rows: fresh } = await query(
      `SELECT l.*, COALESCE((SELECT json_agg(json_build_object('id',p.id,'url',p.url) ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),'[]'::json) AS photos FROM listings l WHERE l.id=$1`,
      [id]
    );
    res.json(fresh[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/listings/:id ──────────────────────────────────────────────────
// Uses optimistic locking to prevent concurrent deletions
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { version } = req.body;
    const { rows } = await query(`SELECT seller_id, version FROM listings WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    if (rows[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });

    if (version !== undefined && version !== rows[0].version) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: rows[0].version
      });
    }

    const result = await query(`UPDATE listings SET status='deleted', version=version+1 WHERE id=$1 AND version=$2 RETURNING id`, [req.params.id, rows[0].version]);
    if (!result.rowCount) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED"
      });
    }

    const io=req.app.get("io");
    if(io)io.emit("listing_removed",{id:req.params.id});
    res.json({ message: "Listing deleted" });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/mark-sold ─────────────────────────────────────────
// Seller marks their own listing as sold, recording whether it sold on platform or outside
// Uses optimistic locking to prevent race conditions
router.post("/:id/mark-sold", requireAuth, async (req, res, next) => {
  try {
    const { channel, version } = req.body;
    if (!["platform", "outside"].includes(channel)) {
      return res.status(400).json({ error: "channel must be 'platform' or 'outside'" });
    }
    const { rows } = await query(
      `SELECT id, seller_id, status, title, version FROM listings WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = rows[0];
    if (listing.seller_id !== req.user.id) return res.status(403).json({ error: "Not your listing" });
    if (listing.status === "sold") return res.status(400).json({ error: "Already marked as sold" });
    if (["deleted", "archived"].includes(listing.status)) {
      return res.status(400).json({ error: "Cannot mark deleted/archived listing as sold" });
    }

    if (version !== undefined && version !== listing.version) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: listing.version
      });
    }

    const result = await query(
      `UPDATE listings SET status='sold', sold_channel=$1, sold_at=NOW(), updated_at=NOW(), version=version+1 WHERE id=$2 AND version=$3 RETURNING id`,
      [channel, listing.id, listing.version]
    );

    if (!result.rowCount) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED"
      });
    }

    const io=req.app.get("io");
    if(io)io.emit("listing_removed",{id:listing.id});

    // Notify admin
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, body, data)
        SELECT id, 'admin_edit', 'Listing Marked Sold',
        $1, $2::jsonb FROM users WHERE role='admin' LIMIT 5`,
        [
          `"${listing.title}" marked as sold ${channel === "platform" ? "via Weka Soko" : "outside platform"}`,
          JSON.stringify({ listing_id: listing.id, channel })
        ]
      );
    } catch (_) {}

    res.json({ success: true, channel, listing_id: listing.id });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/save — toggle save/unsave ─────────────────────────
// Uses transaction with conflict detection for race condition protection
router.post("/:id/save", requireAuth, async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM saved_listings WHERE user_id=$1 AND listing_id=$2 FOR UPDATE`,
        [req.user.id, req.params.id]
      );

      if (rows.length) {
        await client.query(`DELETE FROM saved_listings WHERE user_id=$1 AND listing_id=$2`, [req.user.id, req.params.id]);
        return { saved: false };
      }

      await client.query(
        `INSERT INTO saved_listings (user_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id]
      );
      return { saved: true };
    });

    res.json(result);

    // Async: notify seller that a buyer saved their listing
    (async () => {
      try {
        const { rows: ls } = await query(
          `SELECT l.title, l.seller_id FROM listings l WHERE l.id=$1`,
          [req.params.id]
        );
        if (!ls.length || ls[0].seller_id === req.user.id) return;
        const { title, seller_id } = ls[0];
        const notif = {
          type: "buyer_saved",
          title: "Someone saved your listing!",
          body: `A buyer saved "${title}". Start a conversation to close the deal.`,
        };
        await query(
          `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
          [seller_id, notif.type, notif.title, notif.body, JSON.stringify({ listing_id: req.params.id, action: "open_chat" })]
        );
        const io = req.app?.get("io");
        if (io) io.to(`user:${seller_id}`).emit("notification", notif);
        const { sendPushToUser: push } = require("./push");
        if (push) push(seller_id, {
          title: notif.title,
          body: notif.body,
          tag: "buyer_saved",
          url: `/dashboard?tab=chats&listing=${req.params.id}`
        }).catch(() => {});
      } catch (e) { console.error("[save-notify]", e.message); }
    })();
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/lock-in ────────────────────────────────────────────
// Uses SELECT FOR UPDATE to prevent race conditions when multiple buyers try to lock in
router.post("/:id/lock-in", requireAuth, async (req, res, next) => {
  try {
    if (req.user.id === req.params.id) return res.status(400).json({ error: "Cannot lock in on your own listing" });

    const result = await withLockInTransaction(req.params.id, async (listing, client) => {
      if (listing.seller_id === req.user.id) {
        throw new ConcurrencyError("Cannot lock in on your own listing", "OWN_LISTING");
      }
      if (listing.locked_buyer_id) {
        throw new ConcurrencyError("Another buyer has already locked in", "ALREADY_LOCKED");
      }

      await client.query(
        `UPDATE listings SET locked_buyer_id=$1,locked_at=NOW(),status='locked',interest_count=interest_count+1,version=version+1 WHERE id=$2`,
        [req.user.id, req.params.id]
      );

      await client.query(
        `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'buyer_locked_in','A buyer has locked in!',$2,$3)`,
        [listing.seller_id, `A serious buyer locked in on "${listing.title}". Pay KSh 250 to reveal their contact.`, JSON.stringify({ listing_id: req.params.id })]
      );

      return listing;
    });

    const { sendEmail } = require("../services/email.service");
    sendEmail(
      result.seller_email,
      result.seller_name,
      `A serious buyer wants your "${result.title}"`,
      `Good news! A serious buyer just locked in on your listing "<strong>${result.title}</strong>".<br><br>Pay <strong>KSh 250</strong> to reveal their contact details and close the deal.<br><br><a href="https://weka-soko-nextjs.vercel.app/dashboard">Go to your dashboard →</a>`
    ).catch(() => {});

    res.json({ message: "Locked in. Seller has been notified." });
  } catch (err) {
    if (err.code === "ALREADY_LOCKED") return res.status(409).json({ error: err.message });
    if (err.code === "OWN_LISTING") return res.status(400).json({ error: err.message });
    if (err.code === "NOT_FOUND") return res.status(404).json({ error: err.message });
    next(err);
  }
});

// ── POST /api/listings/:id/report ─────────────────────────────────────────────
router.post("/:id/report", requireAuth, async (req, res, next) => {
  try {
    const { reason, details } = req.body;
    const validReasons = ["scam","fake_item","wrong_price","offensive","spam","wrong_category","already_sold","other"];
    if (!reason || !validReasons.includes(reason)) return res.status(400).json({ error: "Valid reason required", validReasons });
    const { rows: ls } = await query(`SELECT id,seller_id,title FROM listings WHERE id=$1 AND status!='deleted'`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id === req.user.id) return res.status(400).json({ error: "Cannot report your own listing" });
    await query(
      `INSERT INTO listing_reports (listing_id,reporter_id,reason,details) VALUES ($1,$2,$3,$4)
       ON CONFLICT (listing_id,reporter_id) DO UPDATE SET reason=$3,details=$4,created_at=NOW()`,
      [req.params.id, req.user.id, reason, details||null]
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM listing_reports WHERE listing_id=$1 AND status='pending'`, [req.params.id]);
    if (parseInt(cnt[0].count) >= 5) await query(`UPDATE listings SET status='flagged' WHERE id=$1 AND status='active'`, [req.params.id]);
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data) SELECT id,'listing_report','Listing Reported',$1,$2 FROM users WHERE role='admin'`,
      [`"${ls[0].title}" was reported for: ${reason}`, JSON.stringify({ listing_id: req.params.id, reason, report_count: parseInt(cnt[0].count)+1 })]
    ).catch(()=>{});
    res.json({ ok: true, message: "Report submitted. Our team will review it shortly." });
  } catch (err) { next(err); }
});

// ── DELETE /api/listings/:id/photos/:photoId ──────────────────────────────────
router.delete("/:id/photos/:photoId", requireAuth, async (req, res, next) => {
  try {
    const { rows: ls } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });
    const { rows: ph } = await query(`SELECT public_id FROM listing_photos WHERE id=$1 AND listing_id=$2`, [req.params.photoId, req.params.id]);
    if (!ph.length) return res.status(404).json({ error: "Photo not found" });
    if (ph[0].public_id) { try { const { deleteByPublicId } = require("../services/cloudinary.service"); await deleteByPublicId(ph[0].public_id); } catch {} }
    await query(`DELETE FROM listing_photos WHERE id=$1`, [req.params.photoId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/photos ─────────────────────────────────────────────
router.post("/:id/photos", requireAuth, upload.array("photos", 8), async (req, res, next) => {
  try {
    const { rows: ls } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [req.params.id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Not your listing" });
    if (!req.files?.length) return res.status(400).json({ error: "No photos provided" });
    const { rows: maxRow } = await query(`SELECT COALESCE(MAX(sort_order),0) AS max FROM listing_photos WHERE listing_id=$1`, [req.params.id]);
    let sortStart = parseInt(maxRow[0].max) + 1;
    const uploads = await Promise.all(req.files.map((f,i) => uploadBuffer(f.buffer, { folder: `weka-soko/listings/${req.params.id}` }).then(r => ({ ...r, sort_order: sortStart+i }))));
    const inserted = await Promise.all(uploads.map(({ url, public_id, sort_order }) =>
      query(`INSERT INTO listing_photos (listing_id,url,public_id,sort_order) VALUES ($1,$2,$3,$4) RETURNING *`, [req.params.id, url, public_id, sort_order]).then(r => r.rows[0])
    ));
    res.status(201).json(inserted);
  } catch (err) { next(err); }
});

// ── POST /api/listings/:id/seed-photos ───────────────────────────────────────
// Dev-only: inject photo URLs without Cloudinary upload. Requires listing ownership.
router.post("/:id/seed-photos", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { urls } = req.body;
    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: "urls array required" });
    const { rows: ls } = await query(`SELECT seller_id FROM listings WHERE id=$1`, [id]);
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    if (ls[0].seller_id !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ error: "Not your listing" });
    await query(`DELETE FROM listing_photos WHERE listing_id=$1`, [id]);
    for (let i = 0; i < urls.length; i++) {
      await query(
        `INSERT INTO listing_photos (listing_id, url, public_id, sort_order) VALUES ($1,$2,$3,$4)`,
        [id, urls[i], `seed/${id}/${i}`, i]
      );
    }
    res.json({ ok: true, inserted: urls.length });
  } catch (err) { next(err); }
});

// ── Multer error handler (file too large, wrong type, etc.) ──────────────────
router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Photo too large. Max 10MB per photo." });
  if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Too many photos. Max 8 allowed." });
  if (err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: "Unexpected file field." });
  next(err);
});

module.exports = router;
