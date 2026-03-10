// src/services/cron.service.js
const cron = require("node-cron");
const { query } = require("../db/pool");
const { runFollowUps } = require("./followup.service");
const { sendEmail } = require("./email.service");

const FRONTEND = process.env.FRONTEND_URL || "https://weka-soko.vercel.app";

function startCronJobs() {

  // ── Seller follow-ups — daily 9am + 9pm ──────────────────────────────────
  cron.schedule("0 9,21 * * *", async () => {
    console.log("[Cron] Seller follow-ups...");
    await runFollowUps().catch(e => console.error("[Cron] Follow-up error:", e.message));
  });

  // ── Listing expiry — daily at 2am ────────────────────────────────────────
  cron.schedule("0 2 * * *", async () => {
    console.log("[Cron] Listing expiry check...");
    try {
      // 1. Warn listings expiring in 7 days (send one warning)
      const { rows: expiringSoon } = await query(`
        SELECT l.id, l.title, l.expires_at, u.name, u.email
        FROM listings l JOIN users u ON u.id=l.seller_id
        WHERE l.status='active'
          AND l.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
          AND l.expiry_warned=FALSE
      `);
      for (const l of expiringSoon) {
        await query(`UPDATE listings SET expiry_warned=TRUE WHERE id=$1`, [l.id]);
        // In-app notification
        await query(
          `INSERT INTO notifications (user_id,type,title,body,data)
           VALUES ((SELECT seller_id FROM listings WHERE id=$1),'listing_expiring','⏰ Ad expiring soon',$2,$3)`,
          [l.id, `"${l.title}" will auto-archive in 7 days. Edit the listing to renew it.`, JSON.stringify({ listing_id: l.id })]
        ).catch(()=>{});
        // Email
        sendEmail(l.email, l.name,
          "⏰ Your Weka Soko ad is expiring soon",
          `Hi ${l.name},\n\nYour listing "${l.title}" will be auto-archived in 7 days.\n\nTo keep it active, edit the listing here:\n${FRONTEND}?listing=${l.id}\n\n— Weka Soko`
        ).catch(()=>{});
        console.log(`[Cron] Expiry warning sent for listing ${l.id}`);
      }

      // 2. Archive expired listings
      const { rows: expired } = await query(`
        UPDATE listings SET status='archived', updated_at=NOW()
        WHERE status='active' AND expires_at <= NOW()
        RETURNING id, title, seller_id
      `);
      for (const l of expired) {
        await query(
          `INSERT INTO notifications (user_id,type,title,body,data)
           VALUES ($1,'listing_archived','📦 Ad archived',$2,$3)`,
          [l.seller_id, `"${l.title}" has been auto-archived after 75 days. Re-post it to make it active again.`, JSON.stringify({ listing_id: l.id })]
        ).catch(()=>{});
        console.log(`[Cron] Archived listing ${l.id}`);
      }
      if (expired.length) console.log(`[Cron] Archived ${expired.length} expired listings`);
    } catch (err) {
      console.error("[Cron] Expiry error:", err.message);
    }
  });

  // ── Seller response rate calculation — daily at 3am ──────────────────────
  // Response rate = % of first buyer messages replied to within 24h
  // Avg response hours = average hours to first reply
  cron.schedule("0 3 * * *", async () => {
    console.log("[Cron] Recalculating seller response rates...");
    try {
      // For each seller: find all listings where a buyer messaged first
      // then check if seller replied, and how fast
      await query(`
        WITH first_buyer_messages AS (
          SELECT DISTINCT ON (m.listing_id)
            m.listing_id,
            l.seller_id,
            m.created_at AS buyer_msg_at
          FROM chat_messages m
          JOIN listings l ON l.id=m.listing_id
          WHERE m.sender_id != l.seller_id
          ORDER BY m.listing_id, m.created_at ASC
        ),
        seller_replies AS (
          SELECT DISTINCT ON (m.listing_id)
            m.listing_id,
            m.created_at AS reply_at
          FROM chat_messages m
          JOIN listings l ON l.id=m.listing_id
          JOIN first_buyer_messages fb ON fb.listing_id=m.listing_id
          WHERE m.sender_id=l.seller_id
            AND m.created_at > fb.buyer_msg_at
          ORDER BY m.listing_id, m.created_at ASC
        ),
        stats_per_seller AS (
          SELECT
            fb.seller_id,
            COUNT(*) AS total_convos,
            COUNT(sr.listing_id) AS replied_convos,
            AVG(EXTRACT(EPOCH FROM (sr.reply_at - fb.buyer_msg_at))/3600) AS avg_hours
          FROM first_buyer_messages fb
          LEFT JOIN seller_replies sr ON sr.listing_id=fb.listing_id
          GROUP BY fb.seller_id
          HAVING COUNT(*) >= 1
        )
        UPDATE users u SET
          response_rate = ROUND((s.replied_convos::numeric / s.total_convos) * 100, 0),
          avg_response_hours = ROUND(COALESCE(s.avg_hours, 0), 1),
          updated_at = NOW()
        FROM stats_per_seller s
        WHERE u.id = s.seller_id
      `);
      console.log("[Cron] Response rates updated");
    } catch (err) {
      console.error("[Cron] Response rate error:", err.message);
    }
  });

  // ── Auto-release expired escrows — every 30 min ───────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      const { rows } = await query(
        `SELECT id,seller_id,listing_id FROM escrows
         WHERE status='holding' AND release_after<NOW() AND buyer_confirmed=FALSE`
      );
      for (const e of rows) {
        await query(`UPDATE escrows SET status='released',released_at=NOW(),notes='Auto-released after 48hr' WHERE id=$1`, [e.id]);
        await query(`UPDATE listings SET status='sold' WHERE id=$1`, [e.listing_id]);
        console.log(`[Cron] Auto-released escrow ${e.id}`);
      }
    } catch (err) { console.error("[Cron] Escrow release:", err.message); }
  });

  // ── Stale payment cleanup — every hour ───────────────────────────────────
  cron.schedule("0 * * * *", async () => {
    try {
      await query(`UPDATE payments SET status='failed' WHERE status='pending' AND created_at<NOW()-INTERVAL '2 hours'`);
    } catch (err) { console.error("[Cron] Payment cleanup:", err.message); }
  });

  console.log("⏰ Cron jobs started: follow-ups | expiry | response-rates | escrow | payments");
}

module.exports = { startCronJobs };
