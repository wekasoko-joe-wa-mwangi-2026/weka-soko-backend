// src/routes/stats.js — Public platform statistics endpoint
const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");

// GET /api/stats — Public live stats for homepage counters
router.get("/", async (req, res) => {
  try {
    const [users, listings, sold, revenue] = await Promise.all([
      query("SELECT COUNT(*) as count FROM users WHERE is_suspended = false"),
      query("SELECT COUNT(*) as count FROM listings WHERE status = 'active'"),
      query("SELECT COUNT(*) as count FROM listings WHERE status = 'sold'"),
      query("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'confirmed'"),
    ]);

    res.json({
      users: parseInt(users.rows[0].count),
      activeAds: parseInt(listings.rows[0].count),
      sold: parseInt(sold.rows[0].count),
      revenue: parseInt(revenue.rows[0].total),
    });
  } catch (err) {
    console.error("Stats error:", err.message);
    // Return fallback stats so frontend never breaks
    res.json({ users: 0, activeAds: 0, sold: 0, revenue: 0 });
  }
});

module.exports = router;
