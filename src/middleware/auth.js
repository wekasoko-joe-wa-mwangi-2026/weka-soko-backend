// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");

/**
 * Verify JWT and attach user to req.user
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await query(
      `SELECT id, name, email, role, anon_tag, is_suspended, violation_count FROM users WHERE id = $1`,
      [decoded.id]
    );

    if (!rows.length) return res.status(401).json({ error: "User not found" });
    if (rows[0].is_suspended) return res.status(403).json({ error: "Account suspended due to policy violations" });

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError") return res.status(401).json({ error: "Invalid token" });
    if (err.name === "TokenExpiredError") return res.status(401).json({ error: "Token expired" });
    next(err);
  }
}

/**
 * Optional auth - attaches user if token present, but doesn't require it
 */
async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next();
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(`SELECT id, name, email, role, anon_tag FROM users WHERE id = $1`, [decoded.id]);
    if (rows.length) req.user = rows[0];
    next();
  } catch {
    next(); // just proceed without user
  }
}

/**
 * Require admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Require seller role
 */
function requireSeller(req, res, next) {
  if (!req.user || (req.user.role !== "seller" && req.user.role !== "admin")) {
    return res.status(403).json({ error: "Seller account required" });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireSeller };
