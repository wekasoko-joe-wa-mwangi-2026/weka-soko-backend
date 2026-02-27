// src/db/migrate.js
// Run: node src/db/migrate.js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `

-- ═══════════════════════════════════════════════════
--  WEKA SOKO — FULL DATABASE SCHEMA
-- ═══════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for search

-- ─── ENUMS ──────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('buyer', 'seller', 'admin');
CREATE TYPE listing_status AS ENUM ('active', 'locked', 'sold', 'deleted');
CREATE TYPE payment_type AS ENUM ('unlock', 'escrow');
CREATE TYPE payment_status AS ENUM ('pending', 'confirmed', 'failed', 'refunded');
CREATE TYPE escrow_status AS ENUM ('holding', 'released', 'disputed', 'refunded');
CREATE TYPE violation_severity AS ENUM ('warning', 'flagged', 'suspended');
CREATE TYPE dispute_status AS ENUM ('open', 'resolved', 'escalated');

-- ─── USERS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone         VARCHAR(20),                        -- private, not exposed
  role          user_role NOT NULL DEFAULT 'buyer',
  anon_tag      VARCHAR(20),                        -- e.g. "Seller #4821"
  avatar_url    TEXT,
  is_verified   BOOLEAN DEFAULT FALSE,
  is_suspended  BOOLEAN DEFAULT FALSE,
  violation_count INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LISTINGS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(255) NOT NULL,
  description     TEXT NOT NULL,
  reason_for_sale TEXT,
  category        VARCHAR(80),
  price           NUMERIC(12,2) NOT NULL,
  location        VARCHAR(255),                     -- neighbourhood only
  status          listing_status DEFAULT 'active',
  is_unlocked     BOOLEAN DEFAULT FALSE,            -- true after KSh 250 paid
  unlocked_at     TIMESTAMPTZ,
  locked_buyer_id UUID REFERENCES users(id),        -- buyer who locked in
  locked_at       TIMESTAMPTZ,
  view_count      INT DEFAULT 0,
  interest_count  INT DEFAULT 0,
  search_vector   TSVECTOR,                         -- for full-text search
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LISTING PHOTOS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_photos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  public_id   TEXT,                                 -- cloudinary public_id
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PAYMENTS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payer_id            UUID NOT NULL REFERENCES users(id),
  listing_id          UUID NOT NULL REFERENCES listings(id),
  type                payment_type NOT NULL,
  amount_kes          NUMERIC(12,2) NOT NULL,
  status              payment_status DEFAULT 'pending',
  mpesa_checkout_id   VARCHAR(100),                 -- CheckoutRequestID from Daraja
  mpesa_receipt       VARCHAR(100),                 -- MpesaReceiptNumber on success
  mpesa_phone         VARCHAR(20),
  stk_push_sent_at    TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ESCROW ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escrows (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      UUID NOT NULL REFERENCES listings(id),
  buyer_id        UUID NOT NULL REFERENCES users(id),
  seller_id       UUID NOT NULL REFERENCES users(id),
  payment_id      UUID NOT NULL REFERENCES payments(id),
  item_amount     NUMERIC(12,2) NOT NULL,
  fee_amount      NUMERIC(12,2) NOT NULL,           -- 7.5%
  total_amount    NUMERIC(12,2) NOT NULL,
  status          escrow_status DEFAULT 'holding',
  release_after   TIMESTAMPTZ,                      -- auto-release timestamp (48hrs)
  released_at     TIMESTAMPTZ,
  released_by     UUID REFERENCES users(id),        -- admin or auto
  buyer_confirmed BOOLEAN DEFAULT FALSE,
  buyer_confirmed_at TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DISPUTES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  escrow_id   UUID NOT NULL REFERENCES escrows(id),
  raised_by   UUID NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  evidence    JSONB DEFAULT '[]',                   -- photo URLs etc
  status      dispute_status DEFAULT 'open',
  resolved_by UUID REFERENCES users(id),
  resolution  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── MESSAGES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  receiver_id     UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  is_blocked      BOOLEAN DEFAULT FALSE,
  block_reason    VARCHAR(100),
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CHAT VIOLATIONS ────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_violations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  listing_id  UUID REFERENCES listings(id),
  message_id  UUID REFERENCES messages(id),
  reason      TEXT,
  severity    violation_severity DEFAULT 'warning',
  reviewed    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICATIONS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  type        VARCHAR(80) NOT NULL,
  title       VARCHAR(255),
  body        TEXT,
  data        JSONB DEFAULT '{}',
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_listings_seller      ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status      ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category    ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_created     ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_search      ON listings USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_listings_price       ON listings(price);
CREATE INDEX IF NOT EXISTS idx_messages_listing     ON messages(listing_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender      ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_payments_listing     ON payments(listing_id);
CREATE INDEX IF NOT EXISTS idx_payments_mpesa       ON payments(mpesa_checkout_id);
CREATE INDEX IF NOT EXISTS idx_escrows_listing      ON escrows(listing_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_violations_user      ON chat_violations(user_id);

-- ─── FULL TEXT SEARCH TRIGGER ────────────────────────
CREATE OR REPLACE FUNCTION update_listing_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.category, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.location, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS listings_search_update ON listings;
CREATE TRIGGER listings_search_update
  BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_listing_search_vector();

-- ─── AUTO-UPDATE updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS touch_users ON users;
CREATE TRIGGER touch_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS touch_listings ON listings;
CREATE TRIGGER touch_listings BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS touch_payments ON payments;
CREATE TRIGGER touch_payments BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS touch_escrows ON escrows;
CREATE TRIGGER touch_escrows BEFORE UPDATE ON escrows FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("🗄️  Running Weka Soko migrations...");
    await client.query(schema);
    console.log("✅ Migration complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
