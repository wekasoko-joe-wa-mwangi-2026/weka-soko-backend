// src/services/mpesa.service.js
const axios = require("axios");
const { query } = require("../db/pool");

const BASE_URL = process.env.MPESA_BASE_URL || "https://sandbox.safaricom.co.ke";
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// ── Generate OAuth Token ──────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Generate Password ─────────────────────────────────────────────────────────
function generatePassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, "")
    .slice(0, 14);
  const raw = `${SHORTCODE}${PASSKEY}${timestamp}`;
  return {
    password: Buffer.from(raw).toString("base64"),
    timestamp,
  };
}

// ── Format Phone Number ───────────────────────────────────────────────────────
function formatPhone(phone) {
  // Normalize to 2547XXXXXXXX
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("0")) return "254" + clean.slice(1);
  if (clean.startsWith("254")) return clean;
  if (clean.startsWith("7") || clean.startsWith("1")) return "254" + clean;
  return clean;
}

// ── Initiate STK Push ─────────────────────────────────────────────────────────
async function initiateSTKPush({ phone, amount, accountRef, description, paymentId }) {
  const token = await getAccessToken();
  const { password, timestamp } = generatePassword();
  const formattedPhone = formatPhone(phone);

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.ceil(amount),              // M-Pesa only accepts integers
    PartyA: formattedPhone,
    PartyB: SHORTCODE,
    PhoneNumber: formattedPhone,
    CallBackURL: CALLBACK_URL,
    AccountReference: accountRef || "WekaSoko",
    TransactionDesc: description || "Weka Soko Payment",
  };

  const res = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  const data = res.data;

  if (data.ResponseCode === "0") {
    // Update payment record with checkout ID
    await query(
      `UPDATE payments SET mpesa_checkout_id = $1, stk_push_sent_at = NOW(), mpesa_phone = $2 WHERE id = $3`,
      [data.CheckoutRequestID, formattedPhone, paymentId]
    );
    return { success: true, checkoutRequestId: data.CheckoutRequestID, message: data.CustomerMessage };
  } else {
    throw new Error(data.errorMessage || "STK Push failed");
  }
}

// ── Handle M-Pesa Callback ────────────────────────────────────────────────────
async function handleCallback(body) {
  const stkCallback = body?.Body?.stkCallback;
  if (!stkCallback) return { success: false, error: "Invalid callback body" };

  const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

  if (ResultCode !== 0) {
    // Payment failed/cancelled
    await query(
      `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE mpesa_checkout_id = $1`,
      [CheckoutRequestID]
    );
    return { success: false, resultCode: ResultCode, message: ResultDesc };
  }

  // Extract metadata
  const items = CallbackMetadata?.Item || [];
  const get = (name) => items.find((i) => i.Name === name)?.Value;

  const receipt = get("MpesaReceiptNumber");
  const amount = get("Amount");
  const phone = get("PhoneNumber");

  // Mark payment confirmed
  const { rows } = await query(
    `UPDATE payments
     SET status = 'confirmed', mpesa_receipt = $1, confirmed_at = NOW(), updated_at = NOW()
     WHERE mpesa_checkout_id = $2
     RETURNING id, type, listing_id, payer_id`,
    [receipt, CheckoutRequestID]
  );

  if (!rows.length) return { success: false, error: "Payment not found" };

  const payment = rows[0];

  // Handle post-payment actions based on type
  if (payment.type === "unlock") {
    await query(
      `UPDATE listings SET is_unlocked = TRUE, unlocked_at = NOW(), status = 'sold' WHERE id = $1`,
      [payment.listing_id]
    );
    // Notify both parties
    await notifyUnlock(payment.listing_id, payment.payer_id);
  }

  if (payment.type === "escrow") {
    const releaseAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await query(
      `UPDATE escrows SET status = 'holding', release_after = $1 WHERE payment_id = $2`,
      [releaseAfter, payment.id]
    );
  }

  return { success: true, receipt, amount, phone };
}

// ── Notify parties after unlock ───────────────────────────────────────────────
async function notifyUnlock(listingId, sellerId) {
  const { rows: listing } = await query(
    `SELECT l.*, u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email,
            b.name AS buyer_name, b.phone AS buyer_phone, b.email AS buyer_email
     FROM listings l
     JOIN users u ON u.id = l.seller_id
     LEFT JOIN users b ON b.id = l.locked_buyer_id
     WHERE l.id = $1`,
    [listingId]
  );
  if (!listing.length) return;

  const l = listing[0];

  // Notify seller
  await query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, 'unlock_confirmed', 'Contact details unlocked!', $2, $3)`,
    [
      l.seller_id,
      `Your contact is now visible to the buyer for "${l.title}". They can reach you directly.`,
      JSON.stringify({ listing_id: listingId, buyer_phone: l.buyer_phone, buyer_email: l.buyer_email }),
    ]
  );

  // Notify buyer
  if (l.locked_buyer_id) {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'seller_unlocked', 'Seller contact revealed!', $2, $3)`,
      [
        l.locked_buyer_id,
        `The seller of "${l.title}" has unlocked their contact. You can now reach them directly.`,
        JSON.stringify({ listing_id: listingId, seller_phone: l.seller_phone, seller_email: l.seller_email }),
      ]
    );
  }
}

// ── Query STK Push Status (polling fallback) ──────────────────────────────────
async function querySTKStatus(checkoutRequestId) {
  const token = await getAccessToken();
  const { password, timestamp } = generatePassword();

  const res = await axios.post(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return res.data;
}

module.exports = { initiateSTKPush, handleCallback, querySTKStatus, formatPhone };
