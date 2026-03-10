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
const reviewRoutes = require("./routes/reviews");

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

      // Notify seller when a buyer opens the chat for the first time
      if (!isSeller) {
        const buyerTag = socket.user.anon_tag || "A buyer";
        // Only notify if buyer has NOT previously messaged this listing
        const { rows: prevMsg } = await query(
          `SELECT 1 FROM chat_messages WHERE listing_id=$1 AND sender_id=$2 LIMIT 1`,
          [listingId, socket.user.id]
        );
        if (!prevMsg.length) {
          // In-app notification to seller
          await query(
            `INSERT INTO notifications (user_id,type,title,body,data)
             VALUES ($1,'chat_opened','💬 Someone is interested!',$2,$3)`,
            [
              listing.seller_id,
              `${buyerTag} opened a chat on your listing. They haven't messaged yet — they may be typing!`,
              JSON.stringify({ listing_id: listingId })
            ]
          ).catch(()=>{});
          // Real-time push to seller's socket room
          io.to(`user:${listing.seller_id}`).emit("notification", {
            type: "chat_opened",
            title: "💬 Someone is interested!",
            body: `${buyerTag} opened a chat on your listing.`,
            data: { listing_id: listingId }
          });
        }
      }
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

          // ── Send violation notification IN CHAT (appears as system message) ──
          const systemBody = severity === "suspended"
            ? `🚫 ACCOUNT SUSPENDED: Your message was blocked and your account has been suspended for sharing contact information ("${violation.reason}"). You have received ${count} violation(s). Contact support@wekasoko.co.ke to appeal.`
            : severity === "flagged"
            ? `⚠️ WARNING (${count}/3): Your message was blocked — it contained contact information ("${violation.reason}"). One more violation will result in account suspension. Contact info can only be shared after the KSh 250 unlock is paid.`
            : `⚠️ WARNING (${count}/3): Your message was blocked — it appeared to contain contact information ("${violation.reason}"). Contact info must stay hidden until the KSh 250 unlock is paid.`;

          // Insert as a system notification message visible only to the violator
          await query(
            `INSERT INTO notifications (user_id, type, title, body, data)
             VALUES ($1, 'violation_warning', $2, $3, $4)`,
            [
              socket.user.id,
              severity === "suspended" ? "🚫 Account Suspended" : "⚠️ Message Blocked",
              systemBody,
              JSON.stringify({ listing_id: listingId, severity, violation_count: count }),
            ]
          ).catch(() => {});

          // Real-time push to the violating user's own socket room
          // ── System message rendered IN the chat inbox ────────────────
          socket.emit("system_warning", {
            id: "sys-" + savedMsg[0].id,
            body: systemBody,
            severity,
            reason: violation.reason,
            violationCount: count,
            created_at: new Date().toISOString(),
          });
          socket.emit("message_blocked", {
            reason: violation.reason,
            severity,
            violationCount: count,
            systemMessage: systemBody,
          });

          // If suspended, send an email too
          if (severity === "suspended") {
            query(`SELECT name, email FROM users WHERE id=$1`, [socket.user.id]).then(r => {
              if (r.rows.length) {
                const u = r.rows[0];
                sendEmail(
                  u.email, u.name,
                  "🚫 Your Weka Soko account has been suspended",
                  `Hi ${u.name},

Your account has been suspended for repeatedly sharing contact information in chat before completing an unlock payment.

Violation: "${violation.reason}"
Total violations: ${count}

If you believe this is a mistake, please contact us at support@wekasoko.co.ke with your account email and a brief explanation.

Contact information must stay private until the KSh 250 unlock fee is paid. This protects both buyers and sellers.

— Weka Soko`
                ).catch(() => {});
              }
            }).catch(() => {});
          } else {
            // For warnings/flagged — send email reminder too
            query(`SELECT name, email FROM users WHERE id=$1`, [socket.user.id]).then(r => {
              if (r.rows.length) {
                const u = r.rows[0];
                sendEmail(
                  u.email, u.name,
                  severity === "flagged" ? "⚠️ Final warning — Weka Soko" : "⚠️ Message blocked — Weka Soko",
                  `Hi ${u.name},

Your message in a Weka Soko chat was blocked because it appeared to contain contact information ("${violation.reason}").

Violation count: ${count}/3
${severity === "flagged" ? "⛔ One more violation will suspend your account." : ""}

Contact information (phone numbers, emails, social handles) must stay hidden until the KSh 250 unlock fee is paid.

If you think this was a mistake, contact support@wekasoko.co.ke.

— Weka Soko`
                ).catch(() => {});
              }
            }).catch(() => {});
          }

          io.to("admin").emit("violation_alert", { user: socket.user.anon_tag, listingId, reason: violation.reason, severity, count });
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
      // Send to receiver only (NOT broadcast to whole room — that causes duplicates for sender)
      io.to(`user:${receiverId}`).emit("new_message", { ...msgPayload, direction: "them" });
      // Also notify receiver's inbox if chat modal is closed
      io.to(`user:${receiverId}`).emit("new_message_inbox", { ...msgPayload, listing_id: listingId });
      // Confirm back to sender with the real DB id so optimistic message can be replaced
      socket.emit("message_sent", { tempId: body.trim(), ...msgPayload, direction: "me" });

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
// Enhanced security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "https://weka-soko-backend-production.up.railway.app"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
// Prevent parameter pollution
app.use((req, _res, next) => {
  // Strip any duplicate query params that could cause HPP
  if (req.query) {
    for (const key of Object.keys(req.query)) {
      if (Array.isArray(req.query[key])) req.query[key] = req.query[key][0];
    }
  }
  next();
});
// Basic XSS sanitization on text body fields
app.use((req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    const sanitize = (val) => {
      if (typeof val !== "string") return val;
      return val.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
    };
    const sanitizeObj = (obj) => {
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === "string") obj[k] = sanitize(obj[k]);
        else if (typeof obj[k] === "object" && obj[k] !== null) sanitizeObj(obj[k]);
      }
    };
    sanitizeObj(req.body);
  }
  next();
});
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
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
  skip: (req) => req.path === "/health", // don't rate-limit health checks
});
// Slow down repeated auth failures
const authSlowDown = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many failed attempts. Please slow down." },
  skipSuccessfulRequests: true,
});
app.use(globalLimiter);

// Stricter limiter for auth (login/register)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts." },
});

// Extra-strict limiter for password reset — 5 per IP per hour
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many password reset requests. Please wait 1 hour." },
  skipSuccessfulRequests: false,
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth/forgot-password", forgotLimiter);
app.use("/api/auth/login", authSlowDown);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/chat", chatRoutes);
adminRoutes.setIO(io);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/reviews", reviewRoutes);

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
