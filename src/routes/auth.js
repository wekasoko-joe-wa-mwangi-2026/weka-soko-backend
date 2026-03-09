// src/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { sendWelcomeMessage } = require("../services/notification.service");

const router = express.Router();

function generateAnonTag() {
  return "Seller #" + Math.floor(1000 + Math.random() * 9000);
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

      // Check if email taken
      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const hash = await bcrypt.hash(password, 12);
      const anonTag = role === "seller" ? generateAnonTag() : null;

      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role, phone, anon_tag)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, role, anon_tag, created_at`,
        [name, email, hash, role, phone || null, anonTag]
      );

      const user = rows[0];
      const token = signToken(user);

      // Send welcome email (non-blocking)
      sendWelcomeMessage({ userId: user.id, name: user.name, email: user.email, phone: user.phone }).catch(err => console.error("[Auth] Welcome email failed:", err.message));

      res.status(201).json({ user, token });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;

      const { rows } = await query(
        `SELECT id, name, email, password_hash, role, anon_tag, is_suspended FROM users WHERE email = $1`,
        [email]
      );

      if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

      const user = rows[0];
      if (user.is_suspended) return res.status(403).json({ error: "Account suspended" });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      delete user.password_hash;
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
      `SELECT id, name, email, role, anon_tag, phone, avatar_url, is_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
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
      [name, phone, req.user.id]
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
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "Current password incorrect" });

    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, req.user.id]);

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/auth/account ──────────────────────────────────────────────────
// User deletes their own account
router.delete("/account", requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Please confirm your password to delete your account." });

    const { rows } = await query(`SELECT password_hash, google_id FROM users WHERE id = $1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });

    // Skip password check for Google OAuth accounts
    if (!rows[0].google_id) {
      const bcrypt = require("bcryptjs");
      const valid = await bcrypt.compare(password, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: "Incorrect password. Account not deleted." });
    }

    // Soft delete — anonymise data, keep records for integrity
    await query(
      `UPDATE users SET
        name = 'Deleted User',
        email = 'deleted_' || id || '@wekasoko.deleted',
        password_hash = '',
        phone = NULL,
        avatar_url = NULL,
        account_status = 'deleted',
        updated_at = NOW()
       WHERE id = $1`,
      [req.user.id]
    );

    res.json({ ok: true, message: "Account deleted successfully." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// ── GET /api/auth/google ──────────────────────────────────────────────────────
// Redirect to Google OAuth
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

// ── GET /api/auth/google/callback ─────────────────────────────────────────────
router.get("/google/callback", async (req, res) => {
  const { code, error } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";

  if (error || !code) return res.redirect(`${FRONTEND}?auth_error=google_denied`);

  try {
    // Exchange code for token
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
    if (!tokenData.access_token) throw new Error("No access token");

    // Get user info
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!googleUser.email) throw new Error("No email from Google");

    // Upsert user
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role, is_verified, google_id)
       VALUES ($1, $2, $3, 'buyer', TRUE, $4)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(users.name, $1),
         google_id = COALESCE(users.google_id, $4),
         is_verified = TRUE,
         updated_at = NOW()
       RETURNING id, name, email, role, anon_tag, is_verified`,
      [googleUser.name, googleUser.email, "GOOGLE_OAUTH_" + googleUser.id, googleUser.id]
    );
    const user = rows[0];
    const t = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });

    // Redirect back to frontend with token
    res.redirect(`${FRONTEND}?auth_token=${t}&auth_user=${encodeURIComponent(JSON.stringify(user))}`);
  } catch (err) {
    console.error("[Google OAuth]", err.message);
    res.redirect(`${FRONTEND}?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// ── DELETE /api/auth/me ───────────────────────────────────────────────────────
// User deletes their own account
router.delete("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    // Soft-delete: anonymise personal data, mark deleted
    await query(
      `UPDATE users SET
        name = 'Deleted User',
        email = 'deleted_' || id || '@wekasoko.deleted',
        password_hash = '',
        phone = NULL,
        google_id = NULL,
        account_status = 'deleted',
        updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    res.json({ ok: true, message: "Account deleted." });
  } catch (err) {
    next(err);
  }
});
