// src/db/seed-admin.js
// Run once to create the admin account:
// node src/db/seed-admin.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seedAdmin() {
  const client = await pool.connect();
  try {
    const email = "admin@wekasoko.co.ke";
    const password = "WekaSoko@Admin2026";
    const hash = await bcrypt.hash(password, 12);

    await client.query(`
      INSERT INTO users (name, email, password_hash, role, is_verified)
      VALUES ('Weka Soko Admin', $1, $2, 'admin', TRUE)
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $2,
        role = 'admin',
        is_verified = TRUE,
        updated_at = NOW()
    `, [email, hash]);

    console.log("✅ Admin account created/updated!");
    console.log("   Email:    " + email);
    console.log("   Password: " + password);
    console.log("");
    console.log("⚠️  IMPORTANT: Change this password after first login!");
  } catch (err) {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedAdmin();
