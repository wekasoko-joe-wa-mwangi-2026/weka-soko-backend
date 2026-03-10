// src/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { sendWelcomeMessage } = require("../services/notification.service");

const router = express.Router();

// ── Anonymous identity generator ─────────────────────────────────────────────
const ANON_ADJ  = ["Swift","Bold","Sharp","Bright","Keen","Wise","Calm","Fierce","Sleek","Prime","Epic","Fresh","Solid","Grand","Noble","Elite","Savvy","Agile","Brave","Deft"];
const ANON_NOUN = ["Falcon","Cheetah","Baobab","Serval","Mamba","Eagle","Kiboko","Tembo","Duma","Simba","Faru","Tawi","Nguvu","Imara","Jasiri","Hodari","Makini","Shujaa","Moran","Paka"];
function generateAnonTag() {
  const adj  = ANON_ADJ [Math.floor(Math.random() * ANON_ADJ.length)];
  const noun = ANON_NOUN[Math.floor(Math.random() * ANON_NOUN.length)];
  const num  = Math.floor(10 + Math.random() * 90);
  return `${adj}${noun}${num}`;
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("role").isIn(["buyer", "seller"]).withMessage("Role must be buyer or seller"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, email, password, role, phone } = req.body;

      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length) return res.status(409).json({ error: "Email already registered" });

      const hash = await bcrypt.hash(password, 12);
      const anonTag = generateAnonTag(); // everyone gets one — needed when role switches

      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role, phone, anon_tag)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, role, anon_tag, created_at`,
        [name, email, hash, role, phone || null, anonTag]
      );

      const user = rows[0];
      const token = signToken(user);

      sendWelcomeMessage({ userId: user.id, name: user.name, email: user.email, phone: user.phone })
        .catch(err => console.error("[Auth] Welcome email failed:", err.message));

      res.status(201).json({ user, token });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;
      const { rows } = await query(
        `SELECT id, name, email, password_hash, role, anon_tag, is_suspended, account_status FROM users WHERE email = $1`,
        [email]
      );

      if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

      const user = rows[0];
      if (user.account_status === "deleted") return res.status(401).json({ error: "Invalid credentials" });
      if (user.is_suspended) return res.status(403).json({ error: "Account suspended. Contact support." });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      delete user.password_hash;
      delete user.account_status;
      const token = signToken(user);
      res.json({ user, token });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, anon_tag, phone, avatar_url, is_verified, account_status, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: "User not found" });
    if (rows[0].account_status === "deleted") return res.status(401).json({ error: "Account deleted" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/auth/profile ───────────────────────────────────────────────────
router.patch("/profile", requireAuth, async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    const { rows } = await query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), updated_at = NOW()
       WHERE id = $3 RETURNING id, name, email, role, anon_tag, phone`,
      [name || null, phone || null, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: "New password must be at least 8 characters" });

    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    // Allow blank currentPassword for Google OAuth users who never had one
    if (rows[0].password_hash && !rows[0].password_hash.startsWith("GOOGLE_")) {
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: "Current password incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, req.user.id]);
    res.json({ message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/auth/role ──────────────────────────────────────────────────────
// Any user can switch between buyer and seller
router.patch("/role", requireAuth, async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["buyer", "seller"].includes(role))
      return res.status(400).json({ error: "Role must be buyer or seller" });

    // Ensure they already have an anon_tag (generated at registration now for everyone)
    const { rows: cur } = await query(`SELECT anon_tag FROM users WHERE id = $1`, [req.user.id]);
    const anonTag = cur[0]?.anon_tag || generateAnonTag();

    const { rows } = await query(
      `UPDATE users SET role = $1, anon_tag = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, name, email, role, anon_tag, phone, is_verified`,
      [role, anonTag, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ user: rows[0], message: `Switched to ${role}` });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/auth/account ──────────────────────────────────────────────────
// No password required — just confirmation in the UI
router.delete("/account", requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;

    await withTransaction(async (client) => {
      // 1. Clear FK references that block deletion
      await client.query(`UPDATE payments     SET payer_id    = NULL WHERE payer_id    = $1`, [uid]).catch(()=>{});
      await client.query(`UPDATE escrows      SET approved_by = NULL WHERE approved_by = $1`, [uid]).catch(()=>{});
      await client.query(`UPDATE escrows      SET released_by = NULL WHERE released_by = $1`, [uid]).catch(()=>{});
      await client.query(`UPDATE disputes     SET resolved_by = NULL WHERE resolved_by = $1`, [uid]).catch(()=>{});
      await client.query(`UPDATE listings     SET locked_buyer_id = NULL WHERE locked_buyer_id = $1`, [uid]).catch(()=>{});

      // 2. Delete chat messages
      await client.query(`DELETE FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1`, [uid]);

      // 3. Delete their listings (cascade removes listing_photos, payments etc)
      await client.query(`DELETE FROM listings WHERE seller_id = $1`, [uid]);

      // 4. Delete related records
      await client.query(`DELETE FROM chat_violations WHERE user_id = $1`, [uid]).catch(()=>{});
      await client.query(`DELETE FROM notifications   WHERE user_id = $1`, [uid]).catch(()=>{});

      // 5. Hard-delete user
      await client.query(`DELETE FROM users WHERE id = $1`, [uid]);
    });

    res.json({ ok: true, message: "Account permanently deleted." });
  } catch (err) {
    console.error("[Delete account]", err.message);
    next(err);
  }
});

// ── Google OAuth ─────────────────────────────────────────────────────────────
router.get("/google", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: `${process.env.BACKEND_URL || ""}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get("/google/callback", async (req, res) => {
  const { code, error } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";

  if (error || !code) return res.redirect(`${FRONTEND}?auth_error=google_denied`);

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error("No access token from Google");

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!googleUser.email) throw new Error("No email from Google");

    // Upsert: create or update; always ensure anon_tag exists
    const anonTag = generateAnonTag();
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role, is_verified, google_id, anon_tag)
       VALUES ($1, $2, $3, 'buyer', TRUE, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         name        = COALESCE(NULLIF(users.name,''), $1),
         google_id   = COALESCE(users.google_id, $4),
         anon_tag    = COALESCE(users.anon_tag, $5),
         is_verified = TRUE,
         updated_at  = NOW()
       RETURNING id, name, email, role, anon_tag, is_verified, account_status`,
      [googleUser.name, googleUser.email, "GOOGLE_OAUTH_" + googleUser.id, googleUser.id, anonTag]
    );

    const user = rows[0];
    if (user.account_status === "deleted") throw new Error("This account has been deleted.");

    const t = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });
    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, anon_tag: user.anon_tag, is_verified: user.is_verified };

    res.redirect(`${FRONTEND}?auth_token=${t}&auth_user=${encodeURIComponent(JSON.stringify(safeUser))}`);
  } catch (err) {
    console.error("[Google OAuth]", err.message);
    res.redirect(`${FRONTEND}?auth_error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
// Sends a reset link to the user's email
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { rows } = await query(
      `SELECT id, name, email, account_status FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent email enumeration
    if (!rows.length || rows[0].account_status === "deleted") {
      return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
    }

    const user = rows[0];
    const crypto = require("crypto");
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate old tokens
    await query(`UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE`, [user.id]);

    // Store new token
    await query(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";
    const resetLink = `${FRONTEND}?reset_token=${token}`;
    const { sendEmail } = require("../services/email.service");

    await sendEmail(
      user.email,
      user.name,
      "🔐 Reset your Weka Soko password",
      `Hi ${user.name},\n\nYou requested a password reset.\n\nClick this link to set a new password (valid for 1 hour):\n${resetLink}\n\nIf you didn't request this, ignore this email.\n\n— Weka Soko`
    ).catch(err => console.error("[Reset email]", err.message));

    res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
// Validates token and sets new password
router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const { rows } = await query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used
       FROM password_resets pr
       WHERE pr.token = $1`,
      [token]
    );

    if (!rows.length) return res.status(400).json({ error: "Invalid or expired reset link" });
    const reset = rows[0];
    if (reset.used) return res.status(400).json({ error: "This reset link has already been used" });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: "Reset link has expired. Please request a new one." });

    const hash = await bcrypt.hash(password, 12);
    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, reset.user_id]);
    await query(`UPDATE password_resets SET used = TRUE WHERE id = $1`, [reset.id]);

    res.json({ ok: true, message: "Password updated successfully. You can now sign in." });
  } catch (err) {
    next(err);
  }
});
