// src/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
// notification.service skipped — WhatsApp not configured
const { sendEmail } = require("../services/email.service");

const router = express.Router();

const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";
const ADMIN_URL = process.env.ADMIN_URL || "https://weka-soko-admin.vercel.app";

// ── Anon tag generator ──────────────────────────────────────────────────────
const ANON_ADJ  = ["Swift","Bold","Sharp","Bright","Keen","Wise","Calm","Fierce","Sleek","Prime","Epic","Fresh","Solid","Grand","Noble","Elite","Savvy","Agile","Brave","Deft"];
const ANON_NOUN = ["Falcon","Cheetah","Baobab","Serval","Mamba","Eagle","Kiboko","Tembo","Duma","Simba","Faru","Tawi","Nguvu","Imara","Jasiri","Hodari","Makini","Shujaa","Moran","Paka"];
function generateAnonTag() {
  return ANON_ADJ[Math.floor(Math.random()*ANON_ADJ.length)] +
         ANON_NOUN[Math.floor(Math.random()*ANON_NOUN.length)] +
         Math.floor(10+Math.random()*90);
}
function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
}

// ── Email verification helper ───────────────────────────────────────────────
async function sendVerificationEmail(userId, email, name) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24*60*60*1000);
  await query(
    `UPDATE users SET email_verify_token=$1, email_verify_expires=$2 WHERE id=$3`,
    [token, expires, userId]
  );
  const link = `${FRONTEND}?verify_email=${token}`;
  sendEmail(
    email, name,
    "✅ Verify your Weka Soko email",
    `Hi ${name},\n\nThank you for joining Weka Soko!\n\nPlease verify your email to unlock all features:\n${link}\n\nThis link expires in 24 hours.\n\nIf you didn't create an account, please ignore this email.\n\n— Weka Soko`
  ).catch(e => console.error("[Auth] Verify email failed:", e.message));
}

// ── POST /api/auth/register ─────────────────────────────────────────────────
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("role").isIn(["buyer","seller"]).withMessage("Role must be buyer or seller"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, email, password, role, phone } = req.body;
      // Check email uniqueness
      const existing = await query("SELECT id FROM users WHERE email=$1", [email]);
      if (existing.rows.length) return res.status(409).json({ error: "An account with this email already exists." });

      // Check phone uniqueness (only if phone provided)
      if (phone && phone.trim()) {
        const existingPhone = await query("SELECT id FROM users WHERE phone=$1 AND phone IS NOT NULL", [phone.trim()]);
        if (existingPhone.rows.length) return res.status(409).json({ error: "An account with this phone number already exists." });
      }

      const hash = await bcrypt.hash(password, 12);
      const anonTag = generateAnonTag();
      const verifyToken = crypto.randomBytes(32).toString("hex");
      const verifyExpires = new Date(Date.now() + 24*60*60*1000);

      const { rows } = await query(
        `INSERT INTO users (name,email,password_hash,role,phone,anon_tag,email_verify_token,email_verify_expires)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,name,email,role,anon_tag,is_verified,created_at`,
        [name, email, hash, role, phone||null, anonTag, verifyToken, verifyExpires]
      );
      const user = rows[0];

      // Send verification email in background — do NOT await, respond instantly
      const link = `${FRONTEND}?verify_email=${verifyToken}`;
      sendEmail(
        email, name,
        "✅ Verify your Weka Soko email — one step left!",
        `Hi ${name},\n\nWelcome to Weka Soko! 🎉\n\nYou're almost ready. Please verify your email address to activate your account:\n\n👉 ${link}\n\nThis link expires in 24 hours. Once verified, you can sign in and start using Weka Soko.\n\nIf you didn't create this account, you can safely ignore this email.\n\n— Weka Soko`
      ).catch(e => console.error("[Auth] Verify email:", e.message));

      // Welcome message intentionally skipped — WhatsApp not configured

      // Return token immediately — user can use platform right away
      // Email verification is a soft reminder, not a hard block
      const token = signToken(user);
      res.status(201).json({
        ok: true,
        token,
        user,
        message: `Welcome to Weka Soko! Check your email to verify your account.`
      });
    } catch (err) {
      // PostgreSQL unique constraint violation
      if (err.code === "23505") {
        if (err.constraint?.includes("email") || err.detail?.includes("email")) {
          return res.status(409).json({ error: "An account with this email already exists." });
        }
        if (err.constraint?.includes("phone") || err.detail?.includes("phone")) {
          return res.status(409).json({ error: "An account with this phone number already exists." });
        }
        return res.status(409).json({ error: "An account with these details already exists." });
      }
      next(err);
    }
  }
);

// ── GET /api/auth/verify-email ──────────────────────────────────────────────
router.get("/verify-email", async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Token required" });

    const { rows } = await query(
      `SELECT id,name,email,email_verify_expires FROM users WHERE email_verify_token=$1`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or already used verification link" });
    const user = rows[0];
    if (new Date(user.email_verify_expires) < new Date()) {
      return res.status(400).json({ error: "Verification link expired. Please request a new one." });
    }
    await query(
      `UPDATE users SET is_verified=TRUE, email_verify_token=NULL, email_verify_expires=NULL WHERE id=$1`,
      [user.id]
    );
    // Return a JWT so the frontend can log them in automatically
    const { rows: fresh } = await query(
      `SELECT id,name,email,role,anon_tag,is_verified FROM users WHERE id=$1`, [user.id]
    );
    const jwt = signToken(fresh[0]);
    res.json({ ok: true, message: "Email verified! You can now sign in.", token: jwt, user: fresh[0] });
  } catch (err) { next(err); }
});

// ── POST /api/auth/resend-verification-by-email ─────────────────────────────
// Resend verification email without requiring auth — for users who can't log in
// because they haven't verified yet. Rate-limited by email.
router.post("/resend-verification-by-email", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const { rows } = await query(
      `SELECT id,name,email,is_verified FROM users WHERE email=$1 AND account_status IS DISTINCT FROM 'deleted'`,
      [email.toLowerCase().trim()]
    );
    // Always return ok — don't reveal whether email exists
    if (!rows.length || rows[0].is_verified) {
      return res.json({ ok: true, message: "If that email exists and is unverified, we've sent a new link." });
    }

    await sendVerificationEmail(rows[0].id, rows[0].email, rows[0].name);
    res.json({ ok: true, message: "Verification email sent. Check your inbox." });
  } catch (err) { next(err); }
});

// ── POST /api/auth/resend-verification ─────────────────────────────────────
router.post("/resend-verification", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id,name,email,is_verified FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    if (rows[0].is_verified) return res.status(400).json({ error: "Email already verified" });
    await sendVerificationEmail(rows[0].id, rows[0].email, rows[0].name);
    res.json({ ok: true, message: "Verification email sent" });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;
      const { rows } = await query(
        `SELECT id,name,email,password_hash,role,anon_tag,is_suspended,is_verified,account_status FROM users WHERE email=$1`,
        [email]
      );
      if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });
      const user = rows[0];
      if (user.account_status === "deleted") return res.status(401).json({ error: "Invalid credentials" });
      // Admin accounts must use the admin panel — not the main site
      if (user.role === "admin") return res.status(403).json({ error: "Admin accounts must sign in via the Weka Soko Admin panel." });
      if (user.is_suspended) return res.status(403).json({ error: "Account suspended. Contact support@wekasoko.co.ke" });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      delete user.password_hash;
      delete user.account_status;
      const token = signToken(user);
      // Include needsVerification flag so the frontend can show a soft banner
      res.json({ user, token, needsVerification: !user.is_verified });
    } catch (err) { next(err); }
  }
);

// ── POST /api/auth/admin-login ───────────────────────────────────────────────
// Separate login endpoint exclusively for admin panel users.
// Regular users (buyer/seller) are blocked here.
router.post(
  "/admin-login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;
      const { rows } = await query(
        `SELECT id,name,email,password_hash,role,admin_level,anon_tag,is_suspended,is_verified,account_status FROM users WHERE email=$1`,
        [email]
      );
      if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });
      const user = rows[0];
      if (user.account_status === "deleted") return res.status(401).json({ error: "Invalid credentials" });
      // Only admin accounts allowed here
      if (user.role !== "admin") return res.status(403).json({ error: "Access denied. This login is for admin accounts only." });
      if (user.is_suspended) return res.status(403).json({ error: "Account suspended. Contact support@wekasoko.co.ke" });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      delete user.password_hash;
      delete user.account_status;
      const token = signToken(user);
      res.json({ user, token });
    } catch (err) { next(err); }
  }
);

// ── GET /api/auth/me ────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id,name,email,role,anon_tag,phone,avatar_url,is_verified,
              response_rate,avg_response_hours,account_status,whatsapp_phone,created_at
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!rows.length || rows[0].account_status === "deleted") return res.status(401).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/profile ─────────────────────────────────────────────────
router.patch("/profile", requireAuth, async (req, res, next) => {
  try {
    const { name, phone, whatsapp_phone } = req.body;
    // Check phone not already used by another account
    if (phone && phone.trim()) {
      const existingPhone = await query(
        "SELECT id FROM users WHERE phone=$1 AND id!=$2 AND phone IS NOT NULL",
        [phone.trim(), req.user.id]
      );
      if (existingPhone.rows.length) return res.status(409).json({ error: "This phone number is already linked to another account." });
    }
    const { rows } = await query(
      `UPDATE users SET name=COALESCE($1,name),phone=COALESCE($2,phone),
       whatsapp_phone=COALESCE($3,whatsapp_phone),updated_at=NOW()
       WHERE id=$4 RETURNING id,name,email,role,anon_tag,phone,whatsapp_phone`,
      [name||null, phone||null, whatsapp_phone||null, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505" && (err.constraint?.includes("phone") || err.detail?.includes("phone"))) {
      return res.status(409).json({ error: "This phone number is already linked to another account." });
    }
    next(err);
  }
});

// ── POST /api/auth/change-password ──────────────────────────────────────────
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    const { rows } = await query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    if (rows[0].password_hash && !rows[0].password_hash.startsWith("GOOGLE_")) {
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: "Current password incorrect" });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2`, [hash, req.user.id]);
    res.json({ message: "Password changed successfully" });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/role ────────────────────────────────────────────────────
router.patch("/role", requireAuth, async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!["buyer","seller"].includes(role)) return res.status(400).json({ error: "Role must be buyer or seller" });
    const { rows: cur } = await query(`SELECT anon_tag FROM users WHERE id=$1`, [req.user.id]);
    const anonTag = cur[0]?.anon_tag || generateAnonTag();
    const { rows } = await query(
      `UPDATE users SET role=$1,anon_tag=$2,updated_at=NOW() WHERE id=$3
       RETURNING id,name,email,role,anon_tag,phone,is_verified`,
      [role, anonTag, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ user: rows[0], message: `Switched to ${role}` });
  } catch (err) { next(err); }
});

// ── DELETE /api/auth/account ────────────────────────────────────────────────
router.delete("/account", requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;

    // Step 1: collect Cloudinary IDs before any rows vanish
    const { rows: photoRows } = await query(
      `SELECT lp.public_id FROM listing_photos lp
       JOIN listings l ON l.id = lp.listing_id
       WHERE l.seller_id=$1 AND lp.public_id IS NOT NULL`, [uid]
    ).catch(() => ({ rows: [] }));

    // Step 2: dynamically nullify EVERY FK pointing at users(id)
    const { rows: fkRefs } = await query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
      JOIN information_schema.key_column_usage ccu
        ON rc.unique_constraint_name = ccu.constraint_name
        AND rc.unique_constraint_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
        AND tc.table_name != 'users'
    `).catch(() => ({ rows: [] }));

    for (const { table_name, column_name } of fkRefs) {
      await query(
        `UPDATE ${table_name} SET ${column_name}=NULL WHERE ${column_name}=$1`, [uid]
      ).catch(e => console.warn(`[deleteAccount] nullify ${table_name}.${column_name}:`, e.message));
    }

    // Step 3: delete child rows in FK-safe order
    const steps = [
      `DELETE FROM payments WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
      `DELETE FROM disputes WHERE escrow_id IN (SELECT id FROM escrows WHERE buyer_id=$1 OR seller_id=$1)`,
      `DELETE FROM escrows WHERE buyer_id=$1 OR seller_id=$1`,
      `DELETE FROM reviews WHERE reviewer_id=$1 OR reviewee_id=$1`,
      `DELETE FROM seller_pitches WHERE seller_id=$1`,
      `DELETE FROM seller_pitches WHERE request_id IN (SELECT id FROM buyer_requests WHERE user_id=$1)`,
      `DELETE FROM buyer_requests WHERE user_id=$1`,
      `DELETE FROM listing_reports WHERE reporter_id=$1`,
      `DELETE FROM listing_reports WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
      `DELETE FROM chat_messages WHERE sender_id=$1 OR receiver_id=$1`,
      `DELETE FROM chat_violations WHERE user_id=$1`,
      `DELETE FROM listing_photos WHERE listing_id IN (SELECT id FROM listings WHERE seller_id=$1)`,
      `DELETE FROM listings WHERE seller_id=$1`,
      `DELETE FROM notifications WHERE user_id=$1`,
      `DELETE FROM password_history WHERE user_id=$1`,
      `DELETE FROM password_resets WHERE user_id=$1`,
    ];
    for (const sql of steps) {
      await query(sql, [uid]).catch(e => console.warn(`[deleteAccount] ${sql.slice(0,50)}:`, e.message));
    }

    // Step 4: delete the user
    await query(`DELETE FROM users WHERE id=$1`, [uid]);

    // Step 5: purge Cloudinary — non-fatal
    if (photoRows.length > 0) {
      try {
        const { deleteByPublicId } = require("../services/cloudinary.service");
        await Promise.allSettled(photoRows.map(r => deleteByPublicId(r.public_id)));
      } catch (e) { console.warn("[deleteAccount] Cloudinary:", e.message); }
    }

    res.json({ ok: true, message: "Account permanently deleted." });
  } catch (err) { console.error("[Delete account]", err.message); next(err); }
});

// ── POST /api/auth/forgot-password ─────────────────────────────────────────
// Works for both frontend users AND admin users
// Rate limited in index.js via forgotLimiter (5 per IP per hour)
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email, admin } = req.body;  // admin=true sends link to admin URL
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { rows } = await query(
      `SELECT id,name,email,account_status,role FROM users WHERE email=$1`,
      [email.toLowerCase().trim()]
    );

    // Always respond the same — never leak whether email exists
    if (!rows.length || rows[0].account_status === "deleted") {
      return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
    }

    const user = rows[0];

    // For admin panel resets: only allow admin users
    if (admin && user.role !== "admin") {
      return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
    }

    // Throttle: max 3 unused tokens per user per hour
    const { rows: recent } = await query(
      `SELECT COUNT(*) FROM password_resets
       WHERE user_id=$1 AND used=FALSE AND created_at > NOW()-INTERVAL '1 hour'`,
      [user.id]
    );
    if (parseInt(recent[0].count) >= 3) {
      return res.status(429).json({ error: "Too many reset requests. Please wait 1 hour." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60*60*1000); // 1 hour
    await query(`UPDATE password_resets SET used=TRUE WHERE user_id=$1 AND used=FALSE`, [user.id]);
    await query(`INSERT INTO password_resets (user_id,token,expires_at) VALUES ($1,$2,$3)`, [user.id, token, expiresAt]);

    // Admin resets go to admin URL, regular users go to frontend
    const baseUrl = (admin && user.role === "admin") ? ADMIN_URL : FRONTEND;
    const resetLink = `${baseUrl}?reset_token=${token}`;

    sendEmail(
      user.email, user.name,
      "🔐 Reset your Weka Soko password",
      `Hi ${user.name},\n\nYou requested a password reset.\n\nSet a new password here (valid for 1 hour):\n${resetLink}\n\nIf you didn't request this, ignore this email. Your password is unchanged.\n\n— Weka Soko`
    ).catch(e => console.error("[Reset email]", e.message));

    console.log(`[Auth] Password reset sent to ${user.email}`);
    res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ──────────────────────────────────────────
router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const { rows } = await query(
      `SELECT id,user_id,expires_at,used FROM password_resets WHERE token=$1`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or expired reset link" });
    const reset = rows[0];
    if (reset.used) return res.status(400).json({ error: "This reset link has already been used" });
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: "Reset link expired. Please request a new one." });
    }

    // ── Check against password history ──────────────────────────────────────
    // Get current password hash
    const { rows: curUser } = await query(`SELECT password_hash FROM users WHERE id=$1`, [reset.user_id]);
    const currentHash = curUser[0]?.password_hash;

    // Check if new password matches current password
    if (currentHash && await bcrypt.compare(password, currentHash)) {
      return res.status(400).json({ error: "You have used this password before. Please choose a different password." });
    }

    // Check against last 5 historical hashes
    const { rows: histRows } = await query(
      `SELECT password_hash FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [reset.user_id]
    ).catch(() => ({ rows: [] })); // graceful if table doesn't exist yet

    for (const row of histRows) {
      if (row.password_hash && await bcrypt.compare(password, row.password_hash)) {
        return res.status(400).json({ error: "You have used this password before. Please choose a different password." });
      }
    }

    // Save current password to history before overwriting
    if (currentHash) {
      await query(
        `INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`,
        [reset.user_id, currentHash]
      ).catch(() => {}); // non-fatal if table doesn't exist yet
    }

    const hash = await bcrypt.hash(password, 12);
    await query(`UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2`, [hash, reset.user_id]);
    await query(`UPDATE password_resets SET used=TRUE WHERE id=$1`, [reset.id]);

    res.json({ ok: true, message: "Password updated. You can now sign in." });
  } catch (err) { next(err); }
});

// ── Google OAuth ────────────────────────────────────────────────────────────
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

    const anonTag = generateAnonTag();
    const { rows } = await query(
      `INSERT INTO users (name,email,password_hash,role,is_verified,google_id,anon_tag)
       VALUES ($1,$2,$3,'buyer',TRUE,$4,$5)
       ON CONFLICT (email) DO UPDATE SET
         name=COALESCE(NULLIF(users.name,''),$1),
         google_id=COALESCE(users.google_id,$4),
         anon_tag=COALESCE(users.anon_tag,$5),
         is_verified=TRUE,
         updated_at=NOW()
       RETURNING id,name,email,role,anon_tag,is_verified,account_status`,
      [googleUser.name, googleUser.email, "GOOGLE_OAUTH_"+googleUser.id, googleUser.id, anonTag]
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

// ── POST /api/auth/seed-admin ───────────────────────────────────────────────
// One-time endpoint to create the first admin user on a fresh database.
// Protected by SEED_SECRET env variable. Disable by removing SEED_SECRET.
router.post("/seed-admin", async (req, res, next) => {
  try {
    const secret = process.env.SEED_SECRET;
    if (!secret) return res.status(404).json({ error: "Not found" });
    if (req.body.secret !== secret) return res.status(403).json({ error: "Forbidden" });

    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email and password required" });

    // Check if any admin already exists
    const { rows: existing } = await query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
    if (existing.length) return res.status(409).json({ error: "An admin account already exists. Remove SEED_SECRET from env vars." });

    const hash = await require("bcryptjs").hash(password, 12);
    const anonTag = "AdminWekaSoko01";
    const { rows } = await query(
      `INSERT INTO users (name,email,password_hash,role,anon_tag,is_verified,admin_level)
       VALUES ($1,$2,$3,'admin',$4,true,'super') RETURNING id,name,email,role,admin_level`,
      [name, email, hash, anonTag]
    );
    res.json({ ok: true, message: "Admin created successfully. Now remove SEED_SECRET from Railway env vars.", admin: rows[0] });
  } catch (err) { next(err); }
});


module.exports = router;
