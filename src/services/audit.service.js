// src/services/audit.service.js
// Risk 10: Every admin action is logged for accountability and breach detection
const { query } = require("../db/pool");

async function auditLog({ adminId, adminEmail, action, targetType, targetId, details = {}, ip = null }) {
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [adminId || null, adminEmail || null, action, targetType || null, String(targetId || ""), JSON.stringify(details), ip || null]
    );
  } catch (e) {
    // Never crash the request if audit logging fails — just warn
    console.error("[AuditLog] Failed to write:", e.message);
  }
}

module.exports = { auditLog };
