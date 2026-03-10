// src/index.js — Weka Soko Backend Entry Point
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { pool } = require("./db/pool");
const { query } = require("./db/pool");
const { startCronJobs } = require("./services/cron.service");

const authRoutes = require("./routes/auth");
const listingRoutes = require("./routes/listings");
const paymentRoutes = require("./routes/payments");
const chatRoutes = require("./routes/chat");
const adminRoutes = require("./routes/admin");
const notificationRoutes = require("./routes/notifications");
const { sendEmail } = require("./services/email.service");
const statsRoutes = require("./routes/stats");
const voucherRoutes = require("./routes/vouchers");

const app = express();
const server = http.createServer(app);

// ── Socket.io Setup ───────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      const isVercel = /^https:\/\/weka-soko[^.]*\.vercel\.app$/.test(origin);
      const allowed = [process.env.FRONTEND_URL, process.env.ADMIN_URL, "http://localhost:3000"].filter(Boolean);
      if (isVercel || allowed.includes(origin)) callback(null, true);
      else callback(null, true); // allow all for now
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});
// Socket.io is handled directly below
const jwt = require("jsonwebtoken");
const { detectContactInfo, getSeverity } = require("./services/moderation.service");

// Socket auth + handler
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token provided"));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
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

// Track online users in memory: userId -> socketId
const onlineUsers = new Map();

io.on("connection", (socket) => {
  socket.join(`user:${socket.user.id}`);
  // Mark user online
  onlineUsers.set(socket.user.id, socket.id);
  query(`UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = $1`, [socket.user.id]).catch(()=>{});
  // Broadcast online status to everyone in their listing rooms (updated when they join)
  socket.broadcast.emit("user_online", { userId: socket.user.id });

  socket.on("join_listing", async (listingId) => {
    try {
      const { rows } = await query(
        `SELECT seller_id, locked_buyer_id, is_unlocked, listing_anon_tag FROM listings WHERE id = $1`,
        [listingId]
      );
      if (!rows.length) return socket.emit("error", "Listing not found");
      const listing = rows[0];
      const isSeller = listing.seller_id === socket.user.id;

      socket.listingId = listingId;
      socket.isSeller  = isSeller;

      // Seller appears as the listing's unique anonymous identity.
      // Buyer appears as their own account anon_tag.
      // Both are fully independent — knowing one reveals nothing about the other.
      socket.listingAnonTag = isSeller
        ? (listing.listing_anon_tag || socket.user.anon_tag || "Unknown")
        : (socket.user.anon_tag     || "Unknown");

      socket.join(`listing:${listingId}`);
      socket.emit("joined", { listingId, isSeller, anonTag: socket.listingAnonTag });
    } catch (err) {
      console.error("join_listing error:", err.message);
      socket.emit("error", "Failed to join chat");
    }
  });

  socket.on("send_message", async ({ listingId, body }) => {
    try {
      if (!body?.trim() || body.length > 2000) return;

      const { rows: listingRows } = await query(
        `SELECT seller_id, locked_buyer_id, is_unlocked FROM listings WHERE id = $1`,
        [listingId]
      );
      if (!listingRows.length) return;
      const listing = listingRows[0];

      // Moderation (only if not yet unlocked)
      if (!listing.is_unlocked) {
        const violation = detectContactInfo(body);
        if (violation.blocked) {
          const { rows: updated } = await query(
            `UPDATE users SET violation_count = violation_count + 1 WHERE id = $1 RETURNING violation_count`,
            [socket.user.id]
          );
          const count = updated[0].violation_count;
          const severity = getSeverity(count);

          if (severity === "suspended") {
            await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [socket.user.id]);
          }

          const { rows: savedMsg } = await query(
            `INSERT INTO chat_messages (listing_id, sender_id, receiver_id, body, is_blocked, block_reason)
             VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING id`,
            [listingId, socket.user.id, listing.seller_id === socket.user.id ? listing.locked_buyer_id : listing.seller_id, body, violation.reason]
          );

          await query(
            `INSERT INTO chat_violations (user_id, listing_id, message_id, reason, severity) VALUES ($1,$2,$3,$4,$5)`,
            [socket.user.id, listingId, savedMsg[0].id, violation.reason, severity]
          );

          socket.emit("message_blocked", {
            reason: violation.reason,
            severity,
            violationCount: count,
            warning: severity === "suspended"
              ? "Account suspended for repeated violations."
              : severity === "flagged"
              ? "Account flagged. One more violation = suspension."
              : "Contact info not allowed before locking in.",
          });

          io.to("admin").emit("violation_alert", { user: socket.user.anon_tag, listingId, reason: violation.reason, severity });
          return;
        }
      }

      const isSenderSeller = listing.seller_id === socket.user.id;

      // Determine receiver
      let receiverId;
      if (isSenderSeller) {
        // Seller replying: use locked buyer OR first person who messaged this listing
        receiverId = listing.locked_buyer_id;
        if (!receiverId) {
          const { rows: buyerRows } = await query(
            `SELECT sender_id FROM chat_messages
             WHERE listing_id = $1 AND sender_id != $2
             ORDER BY created_at ASC LIMIT 1`,
            [listingId, socket.user.id]
          );
          if (buyerRows.length) receiverId = buyerRows[0].sender_id;
        }
      } else {
        // Buyer messaging: always goes to seller
        receiverId = listing.seller_id;
      }

      if (!receiverId) {
        socket.emit("error", "Cannot determine message recipient.");
        return;
      }

      const { rows: saved } = await query(
        `INSERT INTO chat_messages (listing_id, sender_id, receiver_id, body)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [listingId, socket.user.id, receiverId, body.trim()]
      );

      const msgPayload = {
        id: saved[0].id,
        listing_id: listingId,
        sender_id: socket.user.id,
        senderAnon: socket.listingAnonTag || socket.user.anon_tag || "Anonymous",
        body: body.trim(),
        created_at: saved[0].created_at,
        direction: "them",
        blocked: false,
      };
      // Emit to listing room (for users with chat modal open)
      io.to(`listing:${listingId}`).emit("new_message", msgPayload);
      // ALSO emit to receiver's personal room (so they get it even if chat modal is closed)
      io.to(`user:${receiverId}`).emit("new_message_inbox", { ...msgPayload, listing_id: listingId });

      // Notify the receiver
      const actualNotifyId = receiverId;
      if (actualNotifyId) {
        await query(
          `INSERT INTO notifications (user_id, type, title, body, data)
           VALUES ($1, 'new_message', '💬 New Message', $2, $3)`,
          [
            actualNotifyId,
            `${socket.listingAnonTag || socket.user.anon_tag || "Someone"}: ${body.trim().slice(0, 80)}${body.length > 80 ? "..." : ""}`,
            JSON.stringify({ listing_id: listingId, sender_id: socket.user.id }),
          ]
        ).catch(() => {});
        // Also push real-time notification to their socket room
        io.to(`user:${actualNotifyId}`).emit("notification", {
          type: "new_message",
          title: "💬 New Message",
          body: `${socket.listingAnonTag || socket.user.anon_tag || "Someone"}: ${body.trim().slice(0, 60)}`,
          data: { listing_id: listingId },
        });
        // Send email notification
        query(`SELECT name, email FROM users WHERE id = $1`, [actualNotifyId]).then(r => {
          if (r.rows.length) {
            const u = r.rows[0];
            sendEmail(u.email, u.name, "💬 New message on Weka Soko",
              `Hi ${u.name},\n\n${socket.listingAnonTag || socket.user.anon_tag || "Someone"} sent you a message on your listing.\n\nMessage: "${body.trim().slice(0,100)}"\n\nReply on Weka Soko: https://weka-soko.vercel.app`
            ).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.error("send_message error:", err.message);
    }
  });

  socket.on("typing", (listingId) => {
    socket.to(`listing:${listingId}`).emit("user_typing", { user: socket.user.anon_tag });
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.user.id);
    const now = new Date().toISOString();
    query(`UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = $1`, [socket.user.id]).catch(()=>{});
    socket.broadcast.emit("user_offline", { userId: socket.user.id, lastSeen: now });
    // Also notify their active listing room
    if (socket.listingId) {
      socket.to(`listing:${socket.listingId}`).emit("user_offline", { userId: socket.user.id, lastSeen: now });
    }
  });
  socket.on("stop_typing", (listingId) => {
    socket.to(`listing:${listingId}`).emit("user_stop_typing");
  });

  if (socket.user.role === "admin") socket.join("admin");
});

// ── Express Middleware ─────────────────────────────────────────────────────────
// Trust Railway's proxy (required for rate limiting to work correctly)
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      process.env.ADMIN_URL,
      "http://localhost:3000",
      "http://localhost:3001",
    ].filter(Boolean);
    // Also allow any vercel.app subdomain for this project
    const isVercel = /^https:\/\/weka-soko[^.]*\.vercel\.app$/.test(origin);
    if (allowed.includes(origin) || isVercel) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins for now — tighten after launch
    }
  },
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Stricter limiter for auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts." },
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/vouchers", voucherRoutes);

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected", version: "1.0.0", platform: "Weka Soko" });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

// ── Global Error Handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Start Server (runs migration first, then starts) ─────────────────────────
const PORT = process.env.PORT || 5000;
const { runMigration } = require("./db/migrate_all");

runMigration().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║       🛍  WEKA SOKO API RUNNING          ║
║   Port: ${PORT}  |  Env: ${process.env.NODE_ENV || "development"}        ║
╚══════════════════════════════════════════╝
  `);
    startCronJobs();
  });
}).catch(err => {
  console.error("❌ Startup failed:", err.message);
  process.exit(1);
});

module.exports = { app, server };
