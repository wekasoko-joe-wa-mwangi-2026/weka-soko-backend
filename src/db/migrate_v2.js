// src/db/migrate_v2.js — Additional tables for new features
// Run once on Railway: node src/db/migrate_v2.js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `

-- ─── VOUCHERS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vouchers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            VARCHAR(30) UNIQUE NOT NULL,
  type            VARCHAR(20) NOT NULL DEFAULT 'unlock', -- 'unlock' | 'escrow' | 'both'
  discount_percent INT NOT NULL DEFAULT 100,
  description     TEXT,
  max_uses        INT NOT NULL DEFAULT 50,
  uses            INT NOT NULL DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default vouchers
INSERT INTO vouchers (code, type, discount_percent, description, max_uses)
VALUES 
  ('WS-FREE50', 'unlock', 100, 'Free unlock - launch promo', 50),
  ('WS-ESC25', 'escrow', 50, '50% off escrow fee', 20)
ON CONFLICT (code) DO NOTHING;

-- ─── PLATFORM MESSAGES / INBOX ──────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type   VARCHAR(30) DEFAULT 'system', -- 'system' | 'admin' | 'automated'
  subject       VARCHAR(255) NOT NULL,
  body          TEXT NOT NULL,
  listing_id    UUID REFERENCES listings(id) ON DELETE SET NULL,
  is_read       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at DESC);

-- ─── FOLLOW-UP TRACKING ──────────────────────────────
ALTER TABLE listings 
  ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sold_via VARCHAR(20), -- 'platform' | 'elsewhere'
  ADD COLUMN IF NOT EXISTS negotiated_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS subcat VARCHAR(80),
  ADD COLUMN IF NOT EXISTS photos TEXT[], -- array of Cloudinary URLs
  ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(20);

-- ─── USERS — NEW COLUMNS ──────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS mpesa_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'active', -- 'active' | 'suspended' | 'deleted'
  ADD COLUMN IF NOT EXISTS free_unlock_approved BOOLEAN DEFAULT FALSE;

-- ─── PRICE OFFERS / NEGOTIATIONS ────────────────────
CREATE TABLE IF NOT EXISTS price_offers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_price NUMERIC(12,2) NOT NULL,
  message     TEXT,
  status      VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

-- ─── ESCROW — NEW COLUMNS ────────────────────────────
ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS admin_approved BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- ─── PAYMENT RECORDS — TILL REFERENCE ───────────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS till_number VARCHAR(20) DEFAULT '5673935',
  ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(30);

-- ─── IMAGE SCANS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS image_scans (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id    UUID REFERENCES listings(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  has_contact   BOOLEAN DEFAULT FALSE,
  has_nudity    BOOLEAN DEFAULT FALSE,
  scan_result   JSONB,
  scanned_at    TIMESTAMPTZ DEFAULT NOW()
);

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Running Weka Soko v2 migration...");
    await client.query(schema);
    console.log("✅ Migration v2 complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
