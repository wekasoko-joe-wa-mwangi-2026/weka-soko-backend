// src/routes/vouchers.js — Voucher validation and management
const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

// GET /api/vouchers/:code — Validate a voucher code (authenticated users)
router.get("/:code", authenticateToken, async (req, res) => {
  try {
    const { code } = req.params;
    const result = await query(
      `SELECT * FROM vouchers 
       WHERE code = $1 
         AND active = true 
         AND (expires_at IS NULL OR expires_at > NOW())
         AND uses < max_uses`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invalid or expired voucher code" });
    }

    const voucher = result.rows[0];
    res.json({
      code: voucher.code,
      type: voucher.type,
      discount: voucher.discount_percent,
      description: voucher.description,
    });
  } catch (err) {
    console.error("Voucher validate error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/vouchers — Create voucher (admin only)
router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, type, discount_percent, description, max_uses, expires_at } = req.body;

    const result = await query(
      `INSERT INTO vouchers (code, type, discount_percent, description, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [code, type, discount_percent, description, max_uses, expires_at || null, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Voucher code already exists" });
    console.error("Voucher create error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/vouchers/:id/toggle — Activate/deactivate (admin only)
router.patch("/:id/toggle", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await query(
      "UPDATE vouchers SET active = NOT active WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/vouchers/:code/redeem — Mark a voucher as used
router.post("/:code/redeem", authenticateToken, async (req, res) => {
  try {
    const result = await query(
      "UPDATE vouchers SET uses = uses + 1 WHERE code = $1 AND active = true RETURNING *",
      [req.params.code.toUpperCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
