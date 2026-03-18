// src/routes/chat.js
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// ── GET /api/chat/threads/mine ────────────────────────────────────────────────
router.get("/threads/mine", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (l.id)
         l.id AS listing_id, l.title, l.price, l.status,
         l.seller_id, l.is_contact_public, l.locked_buyer_id,
         -- Never show blocked message body in thread preview
         CASE WHEN m.is_blocked THEN '🚫 Message removed' ELSE m.body END AS last_message,
         m.created_at AS last_message_at,
         (SELECT COUNT(*) FROM chat_messages c
          WHERE c.listing_id = l.id AND c.sender_id != $1 AND c.is_read = FALSE) AS unread_count,
         other_u.id AS other_user_id,
         COALESCE(other_u.anon_tag, 'Unknown') AS other_party_anon,
         other_u.is_online, other_u.last_seen
       FROM listings l
       JOIN chat_messages m ON m.listing_id = l.id
       LEFT JOIN users other_u ON other_u.id = CASE
         WHEN l.seller_id = $1 THEN m.sender_id
         ELSE l.seller_id
       END
       WHERE (m.sender_id = $1 OR m.receiver_id = $1)
         AND other_u.id IS NOT NULL AND other_u.id != $1
       ORDER BY l.id, m.created_at DESC`,
      [req.user.id]
    );
    rows.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/chat/presence ────────────────────────────────────────────────────
router.get("/presence", requireAuth, async (req, res, next) => {
  try {
    const ids = (req.query.ids || "").split(",").filter(Boolean).slice(0, 50);
    if (!ids.length) return res.json({});
    const { rows } = await query(
      `SELECT id, is_online, last_seen FROM users WHERE id = ANY($1::uuid[])`, [ids]
    );
    const map = {};
    rows.forEach(r => { map[r.id] = { is_online: r.is_online, last_seen: r.last_seen }; });
    res.json(map);
  } catch (err) { next(err); }
});

// ── GET /api/chat/presence/:userId ───────────────────────────────────────────
router.get("/presence/:userId", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT is_online, last_seen FROM users WHERE id = $1`, [req.params.userId]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/chat/:listingId ──────────────────────────────────────────────────
router.get("/:listingId", requireAuth, async (req, res, next) => {
  try {
    const { listingId } = req.params;
    const { rows: listingRows } = await query(
      `SELECT seller_id, locked_buyer_id, is_contact_public FROM listings WHERE id = $1`, [listingId]
    );
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const l = listingRows[0];
    const isSeller = l.seller_id === req.user.id;

    const { rows: hasMsg } = await query(
      `SELECT 1 FROM chat_messages WHERE listing_id = $1 AND (sender_id = $2 OR receiver_id = $2) LIMIT 1`,
      [listingId, req.user.id]
    );

    if (!isSeller && !hasMsg.length && req.user.role !== "admin") {
      return res.json([]);
    }

    const { rows } = await query(
      `SELECT
         m.id, m.sender_id, m.is_blocked, m.block_reason, m.is_read, m.created_at,
         -- KEY FIX: never send blocked message body to client
         CASE WHEN m.is_blocked THEN NULL ELSE m.body END AS body,
         CASE WHEN m.sender_id = l.seller_id
              THEN COALESCE(l.listing_anon_tag, 'Unknown')
              ELSE COALESCE(u.anon_tag, 'Unknown')
         END AS sender_anon,
         CASE WHEN m.sender_id = $1 THEN 'me' ELSE 'them' END AS direction
       FROM chat_messages m
       JOIN users u ON u.id = m.sender_id
       JOIN listings l ON l.id = m.listing_id
       WHERE m.listing_id = $2
       ORDER BY m.created_at ASC`,
      [req.user.id, listingId]
    );

    // Mark messages as read
    await query(
      `UPDATE chat_messages SET is_read = TRUE
       WHERE listing_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [listingId, req.user.id]
    );

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
