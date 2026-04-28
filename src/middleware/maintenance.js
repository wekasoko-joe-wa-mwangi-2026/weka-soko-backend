// src/middleware/maintenance.js
// Risk 5: Flip MAINTENANCE_MODE=true in Railway env to take the platform offline
// without a redeployment. Admin routes are always exempt.
const { query } = require("../db/pool");

let cached = { enabled: false, message: "", checkedAt: 0 };
const CACHE_TTL = 30000; // re-check DB every 30s

async function getMaintenanceState() {
  if (Date.now() - cached.checkedAt < CACHE_TTL) return cached;
  try {
    const { rows } = await query(`SELECT key, value FROM platform_config WHERE key IN ('maintenance_mode','maintenance_message')`);
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    cached = {
      enabled: map.maintenance_mode === "true",
      message: map.maintenance_message || "We are performing scheduled maintenance. Back shortly.",
      checkedAt: Date.now(),
    };
  } catch { /* keep previous cached value on DB error */ }
  return cached;
}

// Force-refresh cache (called after admin toggles maintenance mode)
function invalidateMaintenanceCache() { cached.checkedAt = 0; }

async function maintenanceMiddleware(req, res, next) {
  // Always allow: admin routes, health check, M-Pesa/Paystack callbacks, and auth routes (login/signup)
  if (
    req.path.startsWith("/api/admin") || 
    req.path === "/health" || 
    req.path.includes("/mpesa/callback") ||
    req.path.includes("/paystack/webhook") ||
    req.path === "/api/auth/login" ||
    req.path === "/api/auth/register" ||
    req.path === "/api/auth/forgot-password" ||
    req.path === "/api/auth/reset-password"
  ) return next();
  const state = await getMaintenanceState();
  if (state.enabled) {
    return res.status(503).json({
      error: "maintenance",
      message: state.message,
      maintenance: true,
    });
  }
  next();
}

module.exports = { maintenanceMiddleware, getMaintenanceState, invalidateMaintenanceCache };
