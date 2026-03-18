// src/db/migrate_all.js — Complete migration — runs on every startup (idempotent)
const { pool } = require("./pool");

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Extensions ───────────────────────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ── Enums ────────────────────────────────────────────────────────────────
    await client.query(`DO $$ BEGIN CREATE TYPE user_role AS ENUM ('buyer','seller','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await client.query(`DO $$ BEGIN CREATE TYPE violation_severity AS ENUM ('warning','flagged','suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await client.query(`DO $$ BEGIN CREATE TYPE listing_status AS ENUM ('active','locked','sold','deleted','pending_review','rejected','archived','flagged'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await client.query(`ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'pending_review'`).catch(()=>{});
    await client.query(`ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'rejected'`).catch(()=>{});
    await client.query(`ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'archived'`).catch(()=>{});
    await client.query(`ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'flagged'`).catch(()=>{});

    // ── Helper: safe column add ───────────────────────────────────────────────
    const addCol = (tbl, col, def) => client.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(()=>{});

    // ── USERS ────────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      role user_role NOT NULL DEFAULT 'buyer',
      anon_tag VARCHAR(20),
      avatar_url TEXT,
      is_verified BOOLEAN DEFAULT FALSE,
      email_verify_token VARCHAR(64),
      email_verify_expires TIMESTAMPTZ,
      is_suspended BOOLEAN DEFAULT FALSE,
      admin_level VARCHAR(20) DEFAULT NULL CHECK (admin_level IN ('viewer','moderator','manager','super')),
      violation_count INT DEFAULT 0,
      account_status VARCHAR(20) DEFAULT 'active',
      google_id VARCHAR(100),
      last_seen TIMESTAMPTZ,
      is_online BOOLEAN DEFAULT FALSE,
      response_rate NUMERIC(5,2) DEFAULT NULL,
      avg_response_hours NUMERIC(6,2) DEFAULT NULL,
      avg_rating NUMERIC(3,2) DEFAULT NULL,
      review_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("users","google_id","VARCHAR(100)");
    await addCol("users","last_seen","TIMESTAMPTZ");
    await addCol("users","is_online","BOOLEAN DEFAULT FALSE");
    await addCol("users","email_verify_token","VARCHAR(64)");
    await addCol("users","email_verify_expires","TIMESTAMPTZ");
    await addCol("users","response_rate","NUMERIC(5,2) DEFAULT NULL");
    await addCol("users","avg_response_hours","NUMERIC(6,2) DEFAULT NULL");
    await addCol("users","avg_rating","NUMERIC(3,2) DEFAULT NULL");
    await addCol("users","review_count","INT DEFAULT 0");
    await addCol("users","admin_level","VARCHAR(20) DEFAULT NULL");
    await addCol("users","account_status","VARCHAR(20) DEFAULT 'active'");

    // ── LISTINGS ─────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS listings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      reason_for_sale TEXT,
      category VARCHAR(80),
      subcat VARCHAR(80),
      price NUMERIC(12,2) NOT NULL,
      location VARCHAR(255),
      county VARCHAR(60),
      status VARCHAR(30) DEFAULT 'pending_review',
      is_unlocked BOOLEAN DEFAULT FALSE,
      locked_buyer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      locked_at TIMESTAMPTZ,
      unlocked_at TIMESTAMPTZ,
      listing_anon_tag VARCHAR(20),
      view_count INT DEFAULT 0,
      interest_count INT DEFAULT 0,
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '75 days',
      expiry_warned BOOLEAN DEFAULT FALSE,
      moderation_note TEXT,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      search_vector tsvector,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("listings","listing_anon_tag","VARCHAR(20)");
    await addCol("listings","unlocked_at","TIMESTAMPTZ");
    await addCol("listings","county","VARCHAR(60)");
    await addCol("listings","expires_at","TIMESTAMPTZ DEFAULT NOW() + INTERVAL '75 days'");
    await addCol("listings","expiry_warned","BOOLEAN DEFAULT FALSE");
    await addCol("listings","moderation_note","TEXT");
    await addCol("listings","reviewed_by","UUID REFERENCES users(id) ON DELETE SET NULL");
    await addCol("listings","reviewed_at","TIMESTAMPTZ");
    await addCol("listings","is_contact_public","BOOLEAN DEFAULT FALSE");

    // ── LISTING PHOTOS ───────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS listing_photos (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      public_id TEXT,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // ── LISTING REPORTS ──────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS listing_reports (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason VARCHAR(60) NOT NULL,
      details TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      resolved_by UUID REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(listing_id, reporter_id)
    );`);

    // ── PASSWORD RESETS ──────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // ── PAYMENTS ─────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      payer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'unlock',
      amount_kes NUMERIC(12,2) NOT NULL,
      mpesa_phone VARCHAR(20),
      mpesa_receipt VARCHAR(30),
      mpesa_checkout_id VARCHAR(100),
      voucher_code VARCHAR(30),
      status VARCHAR(30) DEFAULT 'pending',
      confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("payments","type","VARCHAR(30) DEFAULT 'unlock'");
    await addCol("payments","amount_kes","NUMERIC(12,2)");
    await addCol("payments","mpesa_phone","VARCHAR(20)");
    await addCol("payments","mpesa_receipt","VARCHAR(30)");
    await addCol("payments","mpesa_checkout_id","VARCHAR(100)");
    await addCol("payments","voucher_code","VARCHAR(30)");
    await addCol("payments","confirmed_at","TIMESTAMPTZ");

    // ── ESCROWS ──────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS escrows (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      buyer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
      payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
      item_amount NUMERIC(12,2) NOT NULL,
      fee_amount NUMERIC(12,2) DEFAULT 0,
      total_amount NUMERIC(12,2) NOT NULL,
      status VARCHAR(30) DEFAULT 'holding',
      admin_approved BOOLEAN DEFAULT FALSE,
      approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      buyer_confirmed BOOLEAN DEFAULT FALSE,
      buyer_confirmed_at TIMESTAMPTZ,
      release_after TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      released_by UUID REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("escrows","payment_id","UUID REFERENCES payments(id) ON DELETE SET NULL");
    await addCol("escrows","item_amount","NUMERIC(12,2)");
    await addCol("escrows","fee_amount","NUMERIC(12,2) DEFAULT 0");
    await addCol("escrows","total_amount","NUMERIC(12,2)");
    await addCol("escrows","admin_approved","BOOLEAN DEFAULT FALSE");
    await addCol("escrows","approved_by","UUID REFERENCES users(id) ON DELETE SET NULL");
    await addCol("escrows","approved_at","TIMESTAMPTZ");
    await addCol("escrows","buyer_confirmed_at","TIMESTAMPTZ");

    // ── DISPUTES ─────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS disputes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      escrow_id UUID REFERENCES escrows(id) ON DELETE SET NULL,
      raised_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      status VARCHAR(30) DEFAULT 'open',
      resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      resolution TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // ── CHAT MESSAGES ────────────────────────────────────────────────────────
    // Direct messages between seller and buyer on a listing (no thread table needed)
    await client.query(`CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id UUID REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      is_blocked BOOLEAN DEFAULT FALSE,
      block_reason TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("chat_messages","receiver_id","UUID REFERENCES users(id) ON DELETE SET NULL");
    await addCol("chat_messages","is_blocked","BOOLEAN DEFAULT FALSE");
    await addCol("chat_messages","block_reason","TEXT");
    await addCol("chat_messages","is_read","BOOLEAN DEFAULT FALSE");

    // ── CHAT VIOLATIONS ──────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS chat_violations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
      reason TEXT,
      severity VARCHAR(20) DEFAULT 'warning',
      reviewed BOOLEAN DEFAULT FALSE,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("chat_violations","user_id","UUID REFERENCES users(id) ON DELETE CASCADE");
    await addCol("chat_violations","listing_id","UUID REFERENCES listings(id) ON DELETE SET NULL");
    await addCol("chat_violations","message_id","UUID REFERENCES chat_messages(id) ON DELETE SET NULL");
    await addCol("chat_violations","severity","VARCHAR(20) DEFAULT 'warning'");
    await addCol("chat_violations","reviewed","BOOLEAN DEFAULT FALSE");

    // ── NOTIFICATIONS ────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(60),
      title VARCHAR(255),
      body TEXT,
      data JSONB,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // ── VOUCHERS ─────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS vouchers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      code VARCHAR(30) UNIQUE NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'unlock',
      discount_percent INT DEFAULT 100,
      max_uses INT DEFAULT 50,
      uses INT DEFAULT 0,
      description TEXT,
      active BOOLEAN DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
    await addCol("vouchers","discount_percent","INT DEFAULT 100");
    await addCol("vouchers","description","TEXT");
    await addCol("vouchers","active","BOOLEAN DEFAULT TRUE");

    // ── REVIEWS ──────────────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS reviews (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewer_role VARCHAR(10) NOT NULL,
      rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      is_public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(listing_id, reviewer_id)
    );`);
    await addCol("reviews","reviewee_id","UUID REFERENCES users(id) ON DELETE CASCADE");

    // ── BUYER REQUESTS ───────────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS buyer_requests (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      description TEXT NOT NULL,
      budget NUMERIC(12,2),
      county VARCHAR(60),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);


    // ── SELLER PITCHES (I Have This) ─────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS seller_pitches (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      request_id UUID NOT NULL REFERENCES buyer_requests(id) ON DELETE CASCADE,
      seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      offered_price NUMERIC(12,2),
      status VARCHAR(20) DEFAULT 'pending',
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(request_id, seller_id)
    );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pitches_request ON seller_pitches(request_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pitches_seller ON seller_pitches(seller_id)`).catch(()=>{});

    // ── INDEXES ──────────────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_county ON listings(county)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_expires ON listings(expires_at) WHERE status='active'`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_listing ON chat_messages(listing_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pw_reset_token ON password_resets(token)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_listing ON listing_reports(listing_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_status ON listing_reports(status)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_buyer_requests_user ON buyer_requests(user_id)`).catch(()=>{});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_buyer_requests_status ON buyer_requests(status)`).catch(()=>{});

    // ── SEARCH VECTOR ────────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_search ON listings USING GIN(search_vector)`).catch(()=>{});
    await client.query(`
      CREATE OR REPLACE FUNCTION listings_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english',
          COALESCE(NEW.title,'') || ' ' || COALESCE(NEW.description,'') || ' ' ||
          COALESCE(NEW.category,'') || ' ' || COALESCE(NEW.location,'') || ' ' || COALESCE(NEW.county,'')
        );
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `).catch(()=>{});
    await client.query(`DROP TRIGGER IF EXISTS listings_search_trigger ON listings`).catch(()=>{});
    await client.query(`
      CREATE TRIGGER listings_search_trigger
      BEFORE INSERT OR UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION listings_search_update();
    `).catch(()=>{});

    // ── BACKFILLS ────────────────────────────────────────────────────────────
    await client.query(`
      UPDATE users SET anon_tag = CONCAT(
        (ARRAY['Swift','Bold','Sharp','Bright','Keen','Wise','Calm','Fierce','Sleek','Prime'])[1+(abs(hashtext(id::text))%10)],
        (ARRAY['Falcon','Cheetah','Baobab','Serval','Mamba','Eagle','Kiboko','Tembo','Duma','Simba'])[1+(abs(hashtext(reverse(id::text)))%10)],
        (10+abs(hashtext(id::text||'salt'))%90)::text
      ) WHERE anon_tag IS NULL
    `).catch(()=>{});
    await client.query(`
      UPDATE listings SET listing_anon_tag =
        (ARRAY['Swift','Bold','Sharp','Bright','Keen','Wise','Calm','Fierce','Sleek','Prime'])[1+(abs(hashtext(id::text))%10)] ||
        (ARRAY['Falcon','Cheetah','Baobab','Serval','Mamba','Eagle','Kiboko','Tembo','Duma','Simba'])[1+(abs(hashtext(reverse(id::text)))%10)] ||
        (10+abs(hashtext(id::text||'tag'))%90)::text
      WHERE listing_anon_tag IS NULL
    `).catch(()=>{});
    await client.query(`UPDATE listings SET expires_at = created_at + INTERVAL '75 days' WHERE expires_at IS NULL`).catch(()=>{});
    await client.query(`UPDATE listings SET county = TRIM(SPLIT_PART(location,',',-1)) WHERE county IS NULL AND location LIKE '%,%'`).catch(()=>{});

    await client.query("COMMIT");
    console.log("✅ DB migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigration };
