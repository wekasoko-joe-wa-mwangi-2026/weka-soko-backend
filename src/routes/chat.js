// src/routes/chat.js  — REST endpoints for chat history
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ── GET /api/chat/:listingId ──────────────────────────────────────────────────
// Get message history for a listing (buyer or seller of that listing)
router.get("/:listingId", requireAuth, async (req, res, next) => {
  try {
    const { listingId } = req.params;

    // Verify user is buyer or seller for this listing
    const { rows: listing } = await query(
      `SELECT seller_id, locked_buyer_id FROM listings WHERE id = $1`,
      [listingId]
    );
    if (!listing.length) return res.status(404).json({ error: "Listing not found" });

    const l = listing[0];
    const isSeller = l.seller_id === req.user.id;
    const isBuyer = l.locked_buyer_id === req.user.id;

    // Admin can also view
    if (!isSeller && !isBuyer && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    const { rows } = await query(
      `SELECT m.id, m.sender_id, m.body, m.is_blocked, m.block_reason, m.is_read, m.created_at,
              u.anon_tag AS sender_anon,
              CASE WHEN m.sender_id = $1 THEN 'me' ELSE 'them' END AS direction
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.listing_id = $2
       ORDER BY m.created_at ASC`,
      [req.user.id, listingId]
    );

    // Mark messages from the other party as read
    await query(
      `UPDATE messages SET is_read = TRUE WHERE listing_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [listingId, req.user.id]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/chat/threads/mine ────────────────────────────────────────────────
// Get all chat threads for the logged-in user
router.get("/threads/mine", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (l.id)
        l.id AS listing_id, l.title, l.price, l.status,
        m.body AS last_message, m.created_at AS last_message_at,
        (SELECT COUNT(*) FROM messages WHERE listing_id = l.id AND sender_id != $1 AND is_read = FALSE) AS unread_count,
        u.anon_tag AS other_party_anon
       FROM listings l
       JOIN messages m ON m.listing_id = l.id
       JOIN users u ON u.id = CASE WHEN l.seller_id = $1 THEN l.locked_buyer_id ELSE l.seller_id END
       WHERE (l.seller_id = $1 OR l.locked_buyer_id = $1)
       ORDER BY l.id, m.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;


// ── SOCKET.IO HANDLER ─────────────────────────────────────────────────────────
// src/services/socket.service.js
const jwt = require("jsonwebtoken");
const { detectContactInfo, getSeverity } = require("../services/moderation.service");

function initSocket(io, dbQuery) {
  // Auth middleware for socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("No token"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await dbQuery(
        `SELECT id, name, role, anon_tag, is_suspended, violation_count FROM users WHERE id = $1`,
        [decoded.id]
      );
      if (!rows.length) return next(new Error("User not found"));
      if (rows[0].is_suspended) return next(new Error("Account suspended"));

      socket.user = rows[0];
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`🔌 Socket connected: ${socket.user.anon_tag || socket.user.name}`);

    // Join a listing's chat room
    socket.on("join_listing", async (listingId) => {
      try {
        const { rows } = await dbQuery(
          `SELECT seller_id, locked_buyer_id, is_unlocked FROM listings WHERE id = $1`,
          [listingId]
        );
        if (!rows.length) return socket.emit("error", "Listing not found");

        const listing = rows[0];
        const isSeller = listing.seller_id === socket.user.id;
        const isBuyer = listing.locked_buyer_id === socket.user.id;
        const isAdmin = socket.user.role === "admin";

        // Anyone can observe chat room but only seller/buyer can chat
        socket.listingId = listingId;
        socket.isSeller = isSeller;
        socket.canChat = isSeller || isBuyer || isAdmin;

        socket.join(`listing:${listingId}`);
        socket.emit("joined", { listingId, canChat: socket.canChat });
      } catch (err) {
        socket.emit("error", "Failed to join listing");
      }
    });

    // Send a message
    socket.on("send_message", async (data) => {
      try {
        const { listingId, body } = data;

        if (!socket.canChat) {
          return socket.emit("message_blocked", { reason: "You are not part of this conversation" });
        }

        if (!body || !body.trim()) return;
        if (body.length > 2000) {
          return socket.emit("error", "Message too long (max 2000 characters)");
        }

        // ── MODERATION ──────────────────────────────────────────
        const { rows: listingRows } = await dbQuery(
          `SELECT seller_id, locked_buyer_id, is_unlocked FROM listings WHERE id = $1`,
          [listingId]
        );
        const listing = listingRows[0];

        // Only moderate if contact not yet unlocked
        if (!listing.is_unlocked) {
          const violation = detectContactInfo(body);

          if (violation.blocked) {
            // Increment violation count
            const { rows: userRows } = await dbQuery(
              `UPDATE users SET violation_count = violation_count + 1 WHERE id = $1 RETURNING violation_count, is_suspended`,
              [socket.user.id]
            );
            const { violation_count, is_suspended } = userRows[0];
            const severity = getSeverity(violation_count);

            // Suspend if 3+ violations
            if (severity === "suspended") {
              await dbQuery(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [socket.user.id]);
            }

            // Log violation
            const { rows: savedMsg } = await dbQuery(
              `INSERT INTO messages (listing_id, sender_id, receiver_id, body, is_blocked, block_reason)
               VALUES ($1, $2, $3, $4, TRUE, $5)
               RETURNING id`,
              [
                listingId,
                socket.user.id,
                socket.isSeller ? listing.locked_buyer_id : listing.seller_id,
                body,
                violation.reason,
              ]
            );

            await dbQuery(
              `INSERT INTO chat_violations (user_id, listing_id, message_id, reason, severity)
               VALUES ($1, $2, $3, $4, $5)`,
              [socket.user.id, listingId, savedMsg[0].id, violation.reason, severity]
            );

            socket.emit("message_blocked", {
              reason: violation.reason,
              severity,
              violationCount: violation_count,
              warning:
                severity === "suspended"
                  ? "Your account has been suspended due to repeated violations."
                  : severity === "flagged"
                  ? "Your account has been flagged for review. Further violations will result in suspension."
                  : "Message blocked. Contact info sharing is not allowed before locking in.",
            });

            // Notify admin room
            io.to("admin").emit("violation_alert", {
              user: socket.user.anon_tag,
              listingId,
              reason: violation.reason,
              severity,
            });

            return; // Don't send the message
          }
        }
        // ── END MODERATION ──────────────────────────────────────

        // Determine receiver
        const receiverId = socket.isSeller ? listing.locked_buyer_id : listing.seller_id;
        if (!receiverId) {
          return socket.emit("error", "No receiver found for this listing");
        }

        // Save message
        const { rows: savedMsg } = await dbQuery(
          `INSERT INTO messages (listing_id, sender_id, receiver_id, body)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [listingId, socket.user.id, receiverId, body.trim()]
        );

        const message = {
          id: savedMsg[0].id,
          senderId: socket.user.id,
          senderAnon: socket.user.anon_tag || socket.user.name,
          body: body.trim(),
          createdAt: savedMsg[0].created_at,
          blocked: false,
        };

        // Broadcast to entire listing room
        io.to(`listing:${listingId}`).emit("new_message", message);

      } catch (err) {
        console.error("Socket send_message error:", err);
        socket.emit("error", "Failed to send message");
      }
    });

    // Typing indicator
    socket.on("typing", (listingId) => {
      socket.to(`listing:${listingId}`).emit("user_typing", { user: socket.user.anon_tag });
    });

    socket.on("stop_typing", (listingId) => {
      socket.to(`listing:${listingId}`).emit("user_stop_typing");
    });

    // Admin joins admin room
    if (socket.user.role === "admin") {
      socket.join("admin");
    }

    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected: ${socket.user.anon_tag || socket.user.name}`);
    });
  });
}

module.exports = { initSocket };
