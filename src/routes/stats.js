// src/routes/stats.js
const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");

// GET /api/stats — Live platform statistics
router.get("/", async (req, res) => {
  try {
    const [users, listings, sold, revenue, views, interested] = await Promise.all([
      query(`SELECT COUNT(*) AS count FROM users WHERE account_status IS DISTINCT FROM 'deleted' AND is_suspended = FALSE`),
      query(`SELECT COUNT(*) AS count FROM listings WHERE status = 'active'`),
      query(`SELECT COUNT(*) AS count FROM listings WHERE status = 'sold'`),
      query(`SELECT COALESCE(SUM(amount_kes),0) AS total FROM payments WHERE status = 'confirmed'`),
      query(`SELECT COALESCE(SUM(view_count),0) AS total FROM listings`),
      query(`SELECT COALESCE(SUM(interest_count),0) AS total FROM listings`),
    ]);

    res.json({
      users:      parseInt(users.rows[0].count),
      activeAds:  parseInt(listings.rows[0].count),
      sold:       parseInt(sold.rows[0].count),
      revenue:    parseInt(revenue.rows[0].total),
      views:      parseInt(views.rows[0].total),
      interested: parseInt(interested.rows[0].total),
    });
  } catch (err) {
    console.error("Stats error:", err.message);
    res.json({ users: 0, activeAds: 0, sold: 0, revenue: 0, views: 0, interested: 0 });
  }
});

module.exports = router;
