// src/services/followup.service.js — Automated 2.5-week seller follow-ups
const { query } = require("../db/pool");

const FOLLOWUP_INTERVAL_DAYS = 17.5; // 2.5 weeks

/**
 * Find all active listings that haven't been followed up in 17.5 days
 * and send WhatsApp + inbox message to seller asking if item is sold.
 */
async function runFollowUps() {
  console.log("[FollowUp] Running 2.5-week follow-up check...");

  try {
    // Find listings: active, older than 17.5 days, not followed up recently
    const staleListings = await query(`
      SELECT 
        l.id, l.title, l.created_at, l.last_followup_at,
        u.id as seller_id, u.name as seller_name, 
        u.email as seller_email, u.phone as seller_phone,
        u.whatsapp_phone
      FROM listings l
      JOIN users u ON l.seller_id = u.id
      WHERE l.status = 'active'
        AND l.created_at < NOW() - INTERVAL '${FOLLOWUP_INTERVAL_DAYS} days'
        AND (
          l.last_followup_at IS NULL 
          OR l.last_followup_at < NOW() - INTERVAL '${FOLLOWUP_INTERVAL_DAYS} days'
        )
      LIMIT 50
    `);

    console.log(`[FollowUp] Found ${staleListings.rows.length} listings needing follow-up`);

    for (const listing of staleListings.rows) {
      try {
        await sendFollowUp(listing);
        
        // Update last_followup_at
        await query(
          "UPDATE listings SET last_followup_at = NOW() WHERE id = $1",
          [listing.id]
        );
      } catch (err) {
        console.error(`[FollowUp] Failed for listing ${listing.id}:`, err.message);
      }
    }

    console.log("[FollowUp] Done.");
  } catch (err) {
    console.error("[FollowUp] Cron error:", err.message);
  }
}

async function sendFollowUp(listing) {
  const message = `Hi ${listing.seller_name}! \n\nYour Weka Soko listing *"${listing.title}"* has been active for over 2 weeks.\n\nHas it been sold yet? If yes, please log in and mark it as sold so we can keep the platform up to date.\n\nIf it's still available, no action needed — your ad stays live! \n\nVisit: https://weka-soko.vercel.app\n\n— Weka Soko Team`;

  // 1. Send WhatsApp via Meta API
  if (process.env.WHATSAPP_TOKEN && listing.whatsapp_phone) {
    try {
      const phone = listing.whatsapp_phone.replace(/^0/, "254").replace(/\D/g, "");
      await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: message },
        }),
      });
      console.log(`[FollowUp] WhatsApp sent to ${listing.seller_name}`);
    } catch (err) {
      console.error("[FollowUp] WhatsApp send failed:", err.message);
    }
  }

  // 2. Send platform inbox message
  await query(
    `INSERT INTO messages (recipient_id, sender_type, subject, body, listing_id, created_at)
     VALUES ($1, 'system', $2, $3, $4, NOW())`,
    [
      listing.seller_id,
      `Follow-up: Is "${listing.title}" still available?`,
      message,
      listing.id,
    ]
  );

  // 3. Send email (if email service configured)
  if (process.env.SENDGRID_API_KEY) {
    try {
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: listing.seller_email, name: listing.seller_name }] }],
          from: { email: "noreply@wekasoko.co.ke", name: "Weka Soko" },
          subject: `Still available? Your listing "${listing.title}"`,
          content: [{ type: "text/plain", value: message }],
        }),
      });
    } catch (err) {
      console.error("[FollowUp] Email send failed:", err.message);
    }
  }
}

module.exports = { runFollowUps, sendFollowUp };
