// src/index.js — Weka Soko Backend Entry Point
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const xss = require("xss-clean");
const hpp = require("hpp");
const slowDown = require("express-slow-down");

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

// ── Socket.io Setup ─────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      const isVercel = /^https:\/\/weka-soko[^.]*\.vercel\.app$/.test(origin);
      const allowed = [process.env.FRONTEND_URL, process.env.ADMIN_URL, "http://localhost:3000"].filter(Boolean);
      if (isVercel || allowed.includes(origin)) callback(null, true);
      else callback(null, true);
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});
const jwt = require("jsonwebtoken");
const { detectContactInfo, getSeverity } = require("./services/moderation.service");

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

const onlineUsers = new Map();

io.on("connection", (socket) => {
  socket.join(`user:${socket.user.id}`);
  onlineUsers.set(socket.user.id, socket.id);
  query(`UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = $1`, [socket.user.id]).catch(()=>{});
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
      socket.listingAnonTag = isSeller
        ? (listing.listing_anon_tag || socket.user.anon_tag || "Unknown")
        : (socket.user.anon_tag     || "Unknown");
      socket.join(`listing:${listingId}`);
      socket.emit("joined", { listingId, isSeller, anonTag: socket.listingAnonTag });
      if (!isSeller) {
        const buyerTag = socket.user.anon_tag || "A buyer";
        const { rows: prevMsg } = await query(
          `SELECT 1 FROM chat_messages WHERE listing_id=$1 AND sender_id=$2 LIMIT 1`,
          [listingId, socket.user.id]
        );
        if (!prevMsg.length) {
          await query(
            `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'chat_opened','💬 Someone is interested!',$2,$3)`,
            [listing.seller_id, `${buyerTag} opened a chat on your listing.`, JSON.stringify({ listing_id: listingId })]
          ).catch(()=>{});
          io.to(`user:${listing.seller_id}`).emit("notification", {
            type: "chat_opened", title: "💬 Someone is interested!",
            body: `${buyerTag} opened a chat on your listing.`,
            data: { listing_id: listingId }
          });
        }
      }
    } catch (err) { socket.emit("error", "Failed to join chat"); }
  });

  // Per-socket message rate limiting
  const msgTimestamps = [];
  socket.on("send_message", async ({ listingId, body }) => {
    try {
      if (!body?.trim() || body.length > 2000) return;
      const now = Date.now();
      while (msgTimestamps.length && msgTimestamps[0] < now - 60000) msgTimestamps.shift();
      if (msgTimestamps.length >= 20) { socket.emit("error", "You are sending messages too fast."); return; }
      msgTimestamps.push(now);

      const { rows: listingRows } = await query(
        `SELECT seller_id, locked_buyer_id, is_unlocked FROM listings WHERE id = $1`, [listingId]
      );
      if (!listingRows.length) return;
      const listing = listingRows[0];

      if (!listing.is_unlocked) {
        const violation = detectContactInfo(body);
        if (violation.blocked) {
          const { rows: updated } = await query(
            `UPDATE users SET violation_count = violation_count + 1 WHERE id = $1 RETURNING violation_count`,
            [socket.user.id]
          );
          const count = updated[0].violation_count;
          const severity = getSeverity(count);
          if (severity === "suspended") await query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [socket.user.id]);
          const { rows: savedMsg } = await query(
            `INSERT INTO chat_messages (listing_id, sender_id, receiver_id, body, is_blocked, block_reason) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`,
            [listingId, socket.user.id, listing.seller_id === socket.user.id ? listing.locked_buyer_id : listing.seller_id, body, violation.reason]
          );
          await query(`INSERT INTO chat_violations (user_id,listing_id,message_id,reason,severity) VALUES ($1,$2,$3,$4,$5)`,
            [socket.user.id, listingId, savedMsg[0].id, violation.reason, severity]);
          const systemBody = severity === "suspended"
            ? `🚫 ACCOUNT SUSPENDED: Your message was blocked for sharing contact info ("${violation.reason}"). Contact support@wekasoko.co.ke to appeal.`
            : `⚠️ WARNING (${count}/3): Message blocked — contained contact info ("${violation.reason}"). Contact info can only be shared after the KSh 250 unlock.`;
          socket.emit("system_warning", { id: "sys-" + savedMsg[0].id, body: systemBody, severity, reason: violation.reason, violationCount: count, created_at: new Date().toISOString() });
          socket.emit("message_blocked", { reason: violation.reason, severity, violationCount: count });
          io.to("admin").emit("violation_alert", { user: socket.user.anon_tag, listingId, reason: violation.reason, severity, count });
          return;
        }
      }

      const isSenderSeller = listing.seller_id === socket.user.id;
      let receiverId;
      if (isSenderSeller) {
        receiverId = listing.locked_buyer_id;
        if (!receiverId) {
          const { rows: buyerRows } = await query(
            `SELECT sender_id FROM chat_messages WHERE listing_id=$1 AND sender_id!=$2 ORDER BY created_at ASC LIMIT 1`,
            [listingId, socket.user.id]
          );
          if (buyerRows.length) receiverId = buyerRows[0].sender_id;
        }
      } else { receiverId = listing.seller_id; }
      if (!receiverId) { socket.emit("error", "Cannot determine message recipient."); return; }

      const { rows: saved } = await query(
        `INSERT INTO chat_messages (listing_id,sender_id,receiver_id,body) VALUES ($1,$2,$3,$4) RETURNING id,created_at`,
        [listingId, socket.user.id, receiverId, body.trim()]
      );
      const msgPayload = { id: saved[0].id, listing_id: listingId, sender_id: socket.user.id, senderAnon: socket.listingAnonTag || socket.user.anon_tag || "Anonymous", body: body.trim(), created_at: saved[0].created_at, direction: "them", blocked: false };
      io.to(`user:${receiverId}`).emit("new_message", { ...msgPayload, direction: "them" });
      io.to(`user:${receiverId}`).emit("new_message_inbox", { ...msgPayload, listing_id: listingId });
      socket.emit("message_sent", { tempId: body.trim(), ...msgPayload, direction: "me" });
      await query(`INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'new_message','💬 New Message',$2,$3)`,
        [receiverId, `${socket.listingAnonTag || socket.user.anon_tag || "Someone"}: ${body.trim().slice(0,80)}`, JSON.stringify({ listing_id: listingId, sender_id: socket.user.id })]).catch(()=>{});
      io.to(`user:${receiverId}`).emit("notification", { type: "new_message", title: "💬 New Message", body: `${socket.listingAnonTag || socket.user.anon_tag || "Someone"}: ${body.trim().slice(0,60)}`, data: { listing_id: listingId } });
    } catch (err) { console.error("send_message error:", err.message); }
  });

  socket.on("typing", (listingId) => { socket.to(`listing:${listingId}`).emit("user_typing", { user: socket.user.anon_tag }); });
  socket.on("stop_typing", (listingId) => { socket.to(`listing:${listingId}`).emit("user_stop_typing"); });
  socket.on("disconnect", () => {
    onlineUsers.delete(socket.user.id);
    query(`UPDATE users SET is_online=FALSE,last_seen=NOW() WHERE id=$1`,[socket.user.id]).catch(()=>{});
    socket.broadcast.emit("user_offline",{userId:socket.user.id,lastSeen:new Date().toISOString()});
  });
  if (socket.user.role === "admin") socket.join("admin");
});

// ── Express Middleware ─────────────────────────────────────────────────────
app.set("trust proxy", 1);
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
app.use(xss());
app.use(hpp({
  whitelist: ["status", "category", "county", "page", "limit", "search"],
}));
app.use((req, _res, next) => {
  const injectionPatterns = [
    /;\s*(DROP|DELETE|INSERT|UPDATE|ALTER|EXEC|EXECUTE)\s/gi,
    /UNION\s+(ALL\s+)?SELECT/gi,
    /\/\*.*\*\//g,
    /--\s*$/mg,
    /'\s*(OR|AND)\s+'?\d+'\s*=\s*'\d+/gi,
    /'\s*(OR|AND)\s+'\w+'\s*=\s*'\w+/gi,
  ];
  const check = (val) => {
    if (typeof val !== "string" || val.length < 10) return false;
    return injectionPatterns.some(p => { p.lastIndex = 0; return p.test(val); });
  };
  const scanObj = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    return Object.values(obj).some(v => check(v) || (typeof v === "object" && scanObj(v)));
  };
  if (scanObj(req.body) || scanObj(req.query)) return _res.status(400).json({ error: "Invalid request content" });
  next();
});
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = [process.env.FRONTEND_URL, process.env.ADMIN_URL, "http://localhost:3000", "http://localhost:3001"].filter(Boolean);
    const isVercel = /^https:\/\/weka-soko[^.]*\.vercel\.app$/.test(origin);
    if (allowed.includes(origin) || isVercel) callback(null, true);
    else callback(null, true);
  },
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
  skip: (req) => req.path === "/health",
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"] || "unknown",
});
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, delayAfter: 50,
  delayMs: (hits) => (hits - 50) * 100,
  skip: (req) => req.path === "/health",
});
const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000, delayAfter: 5,
  delayMs: (hits) => hits * 500,
  skipSuccessfulRequests: true,
});
app.use(globalLimiter);
app.use(speedLimiter);

const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: "Too many auth attempts." } });
const forgotLimiter = rateLimit({ windowMs: 60*60*1000, max: 5, message: { error: "Too many password reset requests. Please wait 1 hour." }, skipSuccessfulRequests: false });

// ── Routes ──────────────────────────────────────────────────────────────
app.use("/api/auth/forgot-password", forgotLimiter);
app.use("/api/auth/login", authSlowDown);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/chat", chatRoutes);
adminRoutes.setIO(io);
app.set("io", io);
app.use("/api/admin", adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/reviews", reviewRoutes);

// ── Health Check ────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", db: "connected", version: "1.0.0", platform: "Weka Soko" }); }
  catch { res.status(500).json({ status: "error", db: "disconnected" }); }
});

// ── Global Error Handler ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

app.use((req, res) => { res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }); });

// ── Start Server ──────────────────────────────────────────────────────────
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
