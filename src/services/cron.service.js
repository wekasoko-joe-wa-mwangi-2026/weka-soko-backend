// src/services/cron.service.js
const cron = require("node-cron");
const { query } = require("../db/pool");
const { runFollowUps } = require("./followup.service");

function startCronJobs() {

  // ── Seller follow-ups — runs daily at 9am and 9pm ────────────────────────
  // Only messages sellers whose listing is 17.5+ days old with no follow-up
  cron.schedule("0 9,21 * * *", async () => {
    console.log("[Cron] Running seller follow-up job...");
    await runFollowUps();
  });

  // ── Auto-release expired escrows every 30 minutes ─────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      const { rows } = await query(
        `SELECT e.id, e.seller_id, e.listing_id
         FROM escrows e
         WHERE e.status = 'holding'
           AND e.release_after < NOW()
           AND e.buyer_confirmed = FALSE`
      );
      for (const escrow of rows) {
        await query(
          `UPDATE escrows SET status = 'released', released_at = NOW(), notes = 'Auto-released after 48hr window' WHERE id = $1`,
          [escrow.id]
        );
        await query(`UPDATE listings SET status = 'sold' WHERE id = $1`, [escrow.listing_id]);
        console.log(`[Cron] Auto-released escrow ${escrow.id}`);
      }
    } catch (err) {
      console.error("[Cron] Escrow auto-release error:", err.message);
    }
  });

  // ── Clean up stale pending payments every hour ────────────────────────────
  cron.schedule("0 * * * *", async () => {
    try {
      await query(
        `UPDATE payments SET status = 'failed'
         WHERE status = 'pending'
           AND created_at < NOW() - INTERVAL '2 hours'`
      );
    } catch (err) {
      console.error("[Cron] Stale payment cleanup error:", err.message);
    }
  });

  console.log("⏰ Cron jobs started (follow-ups, escrow release, payment cleanup)");
}

module.exports = { startCronJobs };
