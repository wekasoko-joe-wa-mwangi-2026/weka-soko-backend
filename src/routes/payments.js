// src/routes/payments.js
const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { initiateSTKPush, handleCallback, querySTKStatus } = require("../services/mpesa.service");

const router = express.Router();

const UNLOCK_FEE = parseInt(process.env.UNLOCK_FEE_KES || "250");
const ESCROW_FEE_PCT = parseFloat(process.env.ESCROW_FEE_PERCENT || "7.5") / 100;

// ── POST /api/payments/unlock ─────────────────────────────────────────────────
// Seller pays KSh 250 to unlock contact details
router.post("/unlock", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, phone, voucher_code } = req.body;

    if (!listing_id) {
      return res.status(400).json({ error: "listing_id is required" });
    }

    // Verify listing exists and this user is the seller
    const { rows: listingRows } = await query(
      `SELECT * FROM listings WHERE id = $1 AND status != 'deleted'`,
      [listing_id]
    );
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = listingRows[0];

    if (listing.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Only the seller can unlock this listing" });
    }

    if (listing.is_unlocked) {
      return res.status(400).json({ error: "Listing is already unlocked" });
    }

    if (!listing.locked_buyer_id) {
      return res.status(400).json({ error: "No buyer has locked in yet. Wait for a buyer to lock in first." });
    }

    // Check voucher
    let discountPct = 0;
    let voucherRow = null;
    if (voucher_code) {
      const { rows: vrows } = await query(
        `SELECT * FROM vouchers WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND uses < max_uses`,
        [voucher_code.toUpperCase()]
      );
      if (vrows.length) { voucherRow = vrows[0]; discountPct = voucherRow.discount_percent || 0; }
    }

    const finalAmount = Math.max(0, Math.round(UNLOCK_FEE * (1 - discountPct / 100)));

    // Check if there's already a confirmed unlock payment
    const { rows: existingPayment } = await query(
      `SELECT id, status FROM payments WHERE listing_id = $1 AND type = 'unlock' AND status = 'confirmed'`,
      [listing_id]
    );
    if (existingPayment.length) {
      return res.status(400).json({ error: "Payment already confirmed for this listing" });
    }

    // FREE UNLOCK via 100% voucher
    if (finalAmount === 0) {
      if (voucherRow) {
        await query(`UPDATE vouchers SET uses = uses + 1 WHERE id = $1`, [voucherRow.id]);
      }
      const { rows: newPay } = await query(
        `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, status, confirmed_at, mpesa_receipt)
         VALUES ($1, $2, 'unlock', 0, 'voucher', 'confirmed', NOW(), $3) RETURNING id`,
        [req.user.id, listing_id, `VOUCHER-${voucher_code}`]
      );
      await query(`UPDATE listings SET is_unlocked = TRUE, unlocked_at = NOW() WHERE id = $1`, [listing_id]);
      const { rows: unlocked } = await query(
        `SELECT l.*, u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email
         FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
        [listing_id]
      );
      return res.json({ unlocked: true, listing: unlocked[0], message: "Contact details unlocked via voucher!" });
    }

    if (!phone) return res.status(400).json({ error: "phone is required for paid unlock" });

    // Create payment record
    const { rows: paymentRows } = await query(
      `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone)
       VALUES ($1, $2, 'unlock', $3, $4)
       RETURNING id`,
      [req.user.id, listing_id, finalAmount, phone]
    );
    const paymentId = paymentRows[0].id;
    if (voucherRow) await query(`UPDATE vouchers SET uses = uses + 1 WHERE id = $1`, [voucherRow.id]);

    // Initiate STK Push
    const result = await initiateSTKPush({
      phone,
      amount: finalAmount,
      accountRef: `WS-UNLOCK-${listing_id.slice(0, 8).toUpperCase()}`,
      description: `Weka Soko unlock - ${listing.title}`,
      paymentId,
    });

    res.json({
      message: "STK Push sent. Enter your M-Pesa PIN to confirm.",
      checkoutRequestId: result.checkoutRequestId,
      paymentId,
      finalAmount,
      discountPct,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/payments/escrow ─────────────────────────────────────────────────
// Buyer initiates escrow payment
router.post("/escrow", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, phone } = req.body;

    if (!listing_id || !phone) {
      return res.status(400).json({ error: "listing_id and phone are required" });
    }

    const { rows: listingRows } = await query(
      `SELECT * FROM listings WHERE id = $1 AND status != 'deleted'`,
      [listing_id]
    );
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = listingRows[0];

    if (listing.seller_id === req.user.id) {
      return res.status(400).json({ error: "Seller cannot use escrow for their own listing" });
    }

    // Check no active escrow
    const { rows: existingEscrow } = await query(
      `SELECT id FROM escrows WHERE listing_id = $1 AND status = 'holding'`,
      [listing_id]
    );
    if (existingEscrow.length) {
      return res.status(409).json({ error: "An escrow is already active for this listing" });
    }

    const feeAmount = Math.round(listing.price * ESCROW_FEE_PCT);
    const totalAmount = listing.price + feeAmount;

    const result = await withTransaction(async (client) => {
      // Create payment record
      const { rows: paymentRows } = await client.query(
        `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone)
         VALUES ($1, $2, 'escrow', $3, $4)
         RETURNING id`,
        [req.user.id, listing_id, totalAmount, phone]
      );
      const paymentId = paymentRows[0].id;

      // Create escrow record (status: holding only after payment confirmed via callback)
      const releaseAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO escrows (listing_id, buyer_id, seller_id, payment_id, item_amount, fee_amount, total_amount, status, release_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'holding', $8)`,
        [listing_id, req.user.id, listing.seller_id, paymentId, listing.price, feeAmount, totalAmount, releaseAfter]
      );

      // Update listing to mark escrow active
      await client.query(`UPDATE listings SET status = 'locked' WHERE id = $1`, [listing_id]);

      return paymentId;
    });

    // Initiate STK Push
    const stkResult = await initiateSTKPush({
      phone,
      amount: totalAmount,
      accountRef: `WS-ESCROW-${listing_id.slice(0, 8).toUpperCase()}`,
      description: `Weka Soko escrow - ${listing.title}`,
      paymentId: result,
    });

    res.json({
      message: `STK Push sent for KSh ${totalAmount.toLocaleString()} (includes 7.5% escrow fee). Enter your M-Pesa PIN.`,
      checkoutRequestId: stkResult.checkoutRequestId,
      breakdown: { item_price: listing.price, escrow_fee: feeAmount, total: totalAmount },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/payments/mpesa/callback ─────────────────────────────────────────
// Safaricom calls this after STK Push response
router.post("/mpesa/callback", async (req, res, next) => {
  try {
    const result = await handleCallback(req.body);
    // Always respond 200 to Safaricom immediately
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

    if (!result.success) {
      console.warn("M-Pesa callback failure:", result);
    }
  } catch (err) {
    console.error("M-Pesa callback error:", err);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" }); // always 200 to Safaricom
  }
});

// ── GET /api/payments/status/:checkoutRequestId ───────────────────────────────
// Frontend polls this to check if payment went through
router.get("/status/:checkoutRequestId", requireAuth, async (req, res, next) => {
  try {
    const { checkoutRequestId } = req.params;

    // First check our DB
    const { rows } = await query(
      `SELECT id, status, type, listing_id, confirmed_at, mpesa_receipt
       FROM payments WHERE mpesa_checkout_id = $1`,
      [checkoutRequestId]
    );

    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const payment = rows[0];

    if (payment.status === "confirmed") {
      return res.json({ status: "confirmed", payment });
    }

    if (payment.status === "failed") {
      return res.json({ status: "failed", payment });
    }

    // Still pending — query Daraja for live status
    try {
      const darajaStatus = await querySTKStatus(checkoutRequestId);
      if (darajaStatus.ResultCode === "0") {
        return res.json({ status: "pending_confirmation", daraja: darajaStatus });
      }
    } catch (darajaErr) {
      // Daraja query can fail in sandbox — just return our DB status
    }

    res.json({ status: payment.status, payment });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/payments/escrow/:id/confirm-receipt ────────────────────────────
// Buyer confirms they received the item in good order
router.post("/escrow/:id/confirm-receipt", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND buyer_id = $2 AND status = 'holding'`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or not yours" });

    await query(
      `UPDATE escrows SET buyer_confirmed = TRUE, buyer_confirmed_at = NOW(), status = 'released', released_at = NOW(), released_by = $1 WHERE id = $2`,
      [req.user.id, id]
    );
    await query(
      `UPDATE listings SET status = 'sold' WHERE id = $1`,
      [rows[0].listing_id]
    );

    // Notify seller
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, 'escrow_released', '💰 Funds Released!', $2, $3)`,
      [rows[0].seller_id, "The buyer has confirmed receipt. Your funds have been released.", JSON.stringify({ escrow_id: id })]
    );

    res.json({ message: "Receipt confirmed. Funds released to seller." });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/payments/escrow/:id/dispute ─────────────────────────────────────
router.post("/escrow/:id/dispute", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) return res.status(400).json({ error: "Reason for dispute is required" });

    const { rows } = await query(
      `SELECT * FROM escrows WHERE id = $1 AND buyer_id = $2 AND status = 'holding'`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE escrows SET status = 'disputed' WHERE id = $1`,
        [id]
      );
      await client.query(
        `INSERT INTO disputes (escrow_id, raised_by, reason) VALUES ($1, $2, $3)`,
        [id, req.user.id, reason]
      );
    });

    res.json({ message: "Dispute raised. Our team will review within 24 hours." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// ── POST /api/payments/verify-receipt ─────────────────────────────────────────
// User pastes an M-Pesa transaction code to manually confirm payment
router.post("/verify-receipt", requireAuth, async (req, res, next) => {
  try {
    const { receipt_code, listing_id, type } = req.body;
    if (!receipt_code || !listing_id || !type) {
      return res.status(400).json({ error: "receipt_code, listing_id and type are required" });
    }

    const code = receipt_code.trim().toUpperCase();

    // Check if receipt already used
    const { rows: existing } = await query(
      `SELECT id, status FROM payments WHERE mpesa_receipt = $1`,
      [code]
    );
    if (existing.length && existing[0].status === "confirmed") {
      return res.status(409).json({ error: "This transaction code has already been used." });
    }

    // Find the pending payment for this listing
    const { rows: payments } = await query(
      `SELECT * FROM payments WHERE listing_id = $1 AND type = $2 AND payer_id = $3 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [listing_id, type, req.user.id]
    );

    // If no pending payment found, create one
    let paymentId;
    if (!payments.length) {
      const { rows: listingRows } = await query(`SELECT * FROM listings WHERE id = $1`, [listing_id]);
      if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
      const listing = listingRows[0];
      const amount = type === "unlock" ? parseInt(process.env.UNLOCK_FEE_KES || "250") : listing.price;
      const { rows: newPayment } = await query(
        `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.user.id, listing_id, type, amount, "manual"]
      );
      paymentId = newPayment[0].id;
    } else {
      paymentId = payments[0].id;
    }

    // Mark payment as confirmed with the pasted receipt
    await query(
      `UPDATE payments SET status = 'confirmed', mpesa_receipt = $1, confirmed_at = NOW() WHERE id = $2`,
      [code, paymentId]
    );

    // Unlock listing if unlock payment
    if (type === "unlock") {
      await query(
        `UPDATE listings SET is_unlocked = TRUE, unlocked_at = NOW() WHERE id = $1`,
        [listing_id]
      );
      // Fetch updated listing with seller details
      const { rows: unlocked } = await query(
        `SELECT l.*, u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email
         FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
        [listing_id]
      );
      return res.json({ ok: true, status: "confirmed", receipt: code, listing: unlocked[0] });
    }

    res.json({ ok: true, status: "confirmed", receipt: code });
  } catch (err) {
    next(err);
  }
});
