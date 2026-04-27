// src/services/notification.service.js — Send transaction confirmations
const { query } = require("../db/pool");
const { sendEmail } = require("./email.service");

/**
 * Send payment confirmation to user via:
 * 1. Platform inbox
 * 2. Email (SendGrid)
 * 3. WhatsApp (Meta API)
 */
async function sendPaymentConfirmation({ userId, type, amount, receipt, listingTitle, listingId }) {
  try {
    // Get user details
    const userResult = await query(
      "SELECT name, email, phone, whatsapp_phone FROM users WHERE id = $1",
      [userId]
    );
    if (userResult.rows.length === 0) return;

    const user = userResult.rows[0];
    const whatsapp = user.whatsapp_phone || user.phone;

    const typeLabel = type === "unlock" ? "Contact Unlock" : "Escrow Payment";
    const subject = `Payment Confirmed — ${typeLabel}`;
    const body = `Hi ${user.name},\n\nYour payment has been confirmed! \n\nDetails:\n• Type: ${typeLabel}\n• Listing: ${listingTitle}\n• Amount: KSh ${Number(amount).toLocaleString("en-KE")}\n• M-Pesa Receipt: ${receipt}\n• Till Number: 5673935\n• Date: ${new Date().toLocaleString("en-KE")}\n\n${type === "unlock" ? "The seller's contact details have been revealed. You can now view them on the listing." : "Funds are now held in escrow. You have 48 hours to confirm receipt of the item."}\n\nThank you for using Weka Soko!\n\nhttps://weka-soko.vercel.app`;

    // 1. Platform inbox
    await query(
      `INSERT INTO inbox_messages (recipient_id, sender_type, subject, body, listing_id, created_at)
       VALUES ($1, 'system', $2, $3, $4, NOW())`,
      [userId, subject, body, listingId || null]
    );

    // 2. WhatsApp
    await sendWhatsApp(whatsapp, body);

    // 3. Email
    await sendEmail(user.email, user.name, subject, body);

    console.log(`[Notify] Payment confirmation sent to ${user.name} for ${receipt}`);
  } catch (err) {
    console.error("[Notify] Payment confirmation error:", err.message);
  }
}

async function sendWelcomeMessage({ userId, name, email, phone }) {
  const body = `Welcome to Weka Soko, ${name}! \n\nYour account has been created successfully.\n\nYou can now:\n• Post items for free \n• Browse thousands of listings \n• Chat safely with buyers and sellers \n• Use our secure escrow service \n\nGet started: https://weka-soko.vercel.app\n\nIf you need help, contact us at support@wekasoko.co.ke\n\n— Weka Soko Team`;

  await sendWhatsApp(phone, body);
  await sendEmail(email, name, "Welcome to Weka Soko! ", body);
}

async function sendEscrowNotification({ buyerId, sellerId, listingTitle, listingId, amount, fee, type }) {
  // type: "activated" | "released" | "refunded" | "disputed"
  const messages = {
    activated: { subject: "Escrow Activated", body: `Escrow has been activated for "${listingTitle}". Funds of KSh ${Number(amount + fee).toLocaleString("en-KE")} are now held securely. The seller must deliver the item within the agreed time.` },
    released: { subject: "Escrow Funds Released", body: `Payment for "${listingTitle}" has been released to the seller. KSh ${Number(amount).toLocaleString("en-KE")} has been sent to the seller's M-Pesa.` },
    refunded: { subject: "Escrow Refunded", body: `Your escrow payment for "${listingTitle}" has been refunded. KSh ${Number(amount + fee).toLocaleString("en-KE")} will be returned to your M-Pesa within 24 hours.` },
    disputed: { subject: "Dispute Raised", body: `A dispute has been raised for "${listingTitle}". Our team will review and resolve within 48 hours. Please check your inbox for updates.` },
  };

  const { subject, body } = messages[type] || messages.activated;

  for (const recipientId of [buyerId, sellerId].filter(Boolean)) {
    try {
      const userResult = await query("SELECT name, email, phone, whatsapp_phone FROM users WHERE id = $1", [recipientId]);
      if (userResult.rows.length === 0) continue;
      const user = userResult.rows[0];

      await query(
        `INSERT INTO inbox_messages (recipient_id, sender_type, subject, body, listing_id, created_at)
         VALUES ($1, 'system', $2, $3, $4, NOW())`,
        [recipientId, subject, body, listingId || null]
      );

      await sendWhatsApp(user.whatsapp_phone || user.phone, body);
      await sendEmail(user.email, user.name, subject, body);
    } catch (err) {
      console.error(`[Notify] Escrow notify error for user ${recipientId}:`, err.message);
    }
  }
}

async function sendBuyerLockedIn({ sellerId, listingTitle, listingId }) {
  try {
    const userResult = await query("SELECT name, email, phone, whatsapp_phone FROM users WHERE id = $1", [sellerId]);
    if (userResult.rows.length === 0) return;
    const user = userResult.rows[0];

    const body = `Great news, ${user.name}! \n\nA buyer has locked in on your listing:\n"${listingTitle}"\n\nTo reveal their contact details, log in and pay the KSh 260 unlock fee.\n\nVisit: https://weka-soko.vercel.app\n\n— Weka Soko Team`;

    await query(
      `INSERT INTO inbox_messages (recipient_id, sender_type, subject, body, listing_id, created_at)
       VALUES ($1, 'system', $2, $3, $4, NOW())`,
      [sellerId, "Buyer Locked In!", body, listingId]
    );
    await sendWhatsApp(user.whatsapp_phone || user.phone, body);
    await sendEmail(user.email, user.name, "A buyer locked in on your listing!", body);
  } catch (err) {
    console.error("[Notify] BuyerLockedIn error:", err.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  if (!process.env.WHATSAPP_TOKEN || !phone) return;
  try {
    const cleaned = phone.toString().replace(/^0/, "254").replace(/\D/g, "");
    await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: cleaned,
        type: "text",
        text: { body: message },
      }),
    });
  } catch (err) {
    console.error("[WhatsApp] Send failed:", err.message);
  }
}


module.exports = {
  sendPaymentConfirmation,
  sendWelcomeMessage,
  sendEscrowNotification,
  sendBuyerLockedIn,
};
