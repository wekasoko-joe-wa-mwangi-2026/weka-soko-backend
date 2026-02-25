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

const app = express();
const server = http.createServer(app);

// ── Socket.io Setup ───────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
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

io.on("connection", (socket) => {
  socket.on("join_listing", async (listingId) => {
    try {
      const { rows } = await query(
        `SELECT seller_id, locked_buyer_id, is_unlocked FROM listings WHERE id = $1`,
        [listingId]
      );
      if (!rows.length) return socket.emit("error", "Listing not found");
      const listing = rows[0];
      socket.listingId = listingId;
      socket.isSeller = listing.seller_id === socket.user.id;
      socket.canChat = listing.seller_id === socket.user.id || socket.user.role === "admin" || true; // buyers can always chat
      socket.join(`listing:${listingId}`);
      socket.emit("joined", { listingId, canChat: socket.canChat });
    } catch {
      socket.emit("error", "Failed to join");
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
            `INSERT INTO messages (listing_id, sender_id, receiver_id, body, is_blocked, block_reason)
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

      const receiverId = listing.seller_id === socket.user.id ? listing.locked_buyer_id : listing.seller_id;
      if (!receiverId && listing.seller_id !== socket.user.id) {
        // New interested buyer — allow chat but no specific receiver yet
      }

      const { rows: saved } = await query(
        `INSERT INTO messages (listing_id, sender_id, receiver_id, body)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [listingId, socket.user.id, receiverId || listing.seller_id, body.trim()]
      );

      io.to(`listing:${listingId}`).emit("new_message", {
        id: saved[0].id,
        senderId: socket.user.id,
        senderAnon: socket.user.anon_tag || socket.user.name,
        body: body.trim(),
        createdAt: saved[0].created_at,
        blocked: false,
      });
    } catch (err) {
      console.error("send_message error:", err.message);
    }
  });

  socket.on("typing", (listingId) => {
    socket.to(`listing:${listingId}`).emit("user_typing", { user: socket.user.anon_tag });
  });
  socket.on("stop_typing", (listingId) => {
    socket.to(`listing:${listingId}`).emit("user_stop_typing");
  });

  if (socket.user.role === "admin") socket.join("admin");
});

// ── Express Middleware ─────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
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

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       🛍  WEKA SOKO API RUNNING          ║
║   Port: ${PORT}  |  Env: ${process.env.NODE_ENV || "development"}        ║
╚══════════════════════════════════════════╝
  `);
  startCronJobs();
});

module.exports = { app, server };
