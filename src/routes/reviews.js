// src/routes/reviews.js — Weka Soko Reviews
// Reviews are available after a listing is sold (status='sold') or escrow released.
// Each party (buyer & seller) can leave exactly one review per transaction.
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ── POST /api/reviews/:listingId ──────────────────────────────────────────────
// Submit a review for a completed transaction
router.post("/:listingId", requireAuth, async (req, res, next) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1–5" });

    // Verify listing is sold/completed
    const { rows: ls } = await query(
      `SELECT id, seller_id, locked_buyer_id, status FROM listings WHERE id=$1`,
      [req.params.listingId]
    );
    if (!ls.length) return res.status(404).json({ error: "Listing not found" });
    const listing = ls[0];

    const isSeller = listing.seller_id === req.user.id;
    const isBuyer  = listing.locked_buyer_id === req.user.id;

    if (!isSeller && !isBuyer) {
      return res.status(403).json({ error: "You were not a party in this transaction" });
    }
    if (!["sold","locked"].includes(listing.status)) {
      return res.status(400).json({ error: "Reviews are only available after a sale is completed" });
    }
    if (!listing.locked_buyer_id) {
      return res.status(400).json({ error: "No buyer associated with this listing" });
    }

    const reviewerRole = isSeller ? "seller" : "buyer";
    const revieweeId = isSeller ? listing.locked_buyer_id : listing.seller_id;

    // Upsert — one review per listing per reviewer
    const { rows } = await query(
      `INSERT INTO reviews (listing_id, reviewer_id, reviewee_id, reviewer_role, rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (listing_id, reviewer_id) DO UPDATE SET rating=$5, comment=$6, created_at=NOW()
       RETURNING *`,
      [req.params.listingId, req.user.id, revieweeId, reviewerRole, Math.round(rating), comment?.trim() || null]
    );

    // Notify the reviewee
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'new_review', 'You received a review', $2, $3)`,
      [
        revieweeId,
        `You received a ${rating}-star review for "${listing.title || "your listing"}".${comment ? ` "${comment.slice(0, 80)}"` : ""}`,
        JSON.stringify({ listing_id: req.params.listingId, rating })
      ]
    ).catch(() => {});

    res.status(201).json({ ok: true, review: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /api/reviews/user/:userId ─────────────────────────────────────────────
// Public: get all reviews for a user (as reviewee)
router.get("/user/:userId", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.comment, r.reviewer_role, r.created_at,
              l.title AS listing_title, l.id AS listing_id,
              u.anon_tag AS reviewer_anon
       FROM reviews r
       JOIN listings l ON l.id=r.listing_id
       JOIN users u ON u.id=r.reviewer_id
       WHERE r.reviewee_id=$1
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.userId]
    );
    const avg = rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(1) : null;
    res.json({ reviews: rows, average_rating: avg ? parseFloat(avg) : null, total: rows.length });
  } catch (err) { next(err); }
});

// ── GET /api/reviews/listing/:listingId ───────────────────────────────────────
// Get reviews for a specific listing (both buyer→seller and seller→buyer)
router.get("/listing/:listingId", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.comment, r.reviewer_role, r.reviewer_id, r.reviewee_id, r.created_at
       FROM reviews r WHERE r.listing_id=$1 ORDER BY r.created_at DESC`,
      [req.params.listingId]
    );
    // Also tell the requester if they've already reviewed
    const myReview = rows.find(r => r.reviewer_id === req.user.id) || null;
    res.json({ reviews: rows, myReview });
  } catch (err) { next(err); }
});

// ── GET /api/reviews/me ───────────────────────────────────────────────────────
// Reviews written BY the logged-in user
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, l.title AS listing_title FROM reviews r
       JOIN listings l ON l.id=r.listing_id
       WHERE r.reviewer_id=$1 ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/reviews/pending ──────────────────────────────────────────────────
// Listings where user was involved & can still leave a review
router.get("/pending", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.seller_id, l.locked_buyer_id, l.status,
              COALESCE(
                (SELECT json_agg(p.url ORDER BY p.sort_order) FROM listing_photos p WHERE p.listing_id=l.id),
                '[]'::json
              ) AS photos,
              (SELECT id FROM reviews WHERE listing_id=l.id AND reviewer_id=$1 LIMIT 1) AS already_reviewed
       FROM listings l
       WHERE (l.seller_id=$1 OR l.locked_buyer_id=$1)
         AND l.status IN ('sold','locked')
         AND l.locked_buyer_id IS NOT NULL
       ORDER BY l.updated_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json(rows.filter(l => !l.already_reviewed));
  } catch (err) { next(err); }
});

module.exports = router;
