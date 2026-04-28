// src/routes/payments.js — Paystack integration for Starter accounts
const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { initializeTransaction, verifyTransaction, handleWebhook } = require("../services/paystack.service");

const router = express.Router();
const { sendPushToUser } = require("./push");
const { sendPaymentConfirmationEmail } = require("../services/notification.service");

const UNLOCK_FEE = parseInt(process.env.UNLOCK_FEE_KES || "260");
const ESCROW_FEE_PCT = parseFloat(process.env.ESCROW_FEE_PERCENT || "5.5") / 100;

// ── POST /api/payments/unlock ──────────────────────────────────────────────────
// Initialize Paystack payment for unlocking seller contact
router.post("/unlock", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, email, voucher_code } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id is required" });

    const { rows: listingRows } = await query(
      `SELECT * FROM listings WHERE id = $1 AND status != 'deleted'`, [listing_id]
    );
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = listingRows[0];

    if (listing.seller_id !== req.user.id)
      return res.status(403).json({ error: "Only the seller can unlock this listing" });
    if (listing.is_contact_public)
      return res.status(400).json({ error: "Listing is already unlocked" });

    let discountPct = 0, voucherRow = null;
    if (voucher_code) {
      const { rows: vrows } = await query(
        `SELECT * FROM vouchers WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND uses < max_uses`,
        [voucher_code.toUpperCase()]
      );
      if (vrows.length) { voucherRow = vrows[0]; discountPct = voucherRow.discount_percent || 0; }
    }

    // Admin discount (flat KSh amount) applied before percentage voucher discount
    const adminDiscount = parseInt(listing.unlock_discount || 0);
    const baseAmount = Math.max(0, UNLOCK_FEE - adminDiscount);
    const finalAmount = Math.max(0, Math.round(baseAmount * (1 - discountPct / 100)));

    const { rows: existingPayment } = await query(
      `SELECT id FROM payments WHERE listing_id = $1 AND type = 'unlock' AND status = 'confirmed'`,
      [listing_id]
    );
    if (existingPayment.length)
      return res.status(400).json({ error: "Payment already confirmed for this listing" });

    // Get user email for Paystack
    const userEmail = email || req.user.email;
    if (!userEmail) return res.status(400).json({ error: "email is required for payment" });

    // Generate unique reference
    const reference = `WS-UNLOCK-${listing_id.slice(0,8).toUpperCase()}-${Date.now()}`;

    // Create payment record
    const { rows: paymentRows } = await query(
      `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, mpesa_receipt, status) VALUES ($1,$2,'unlock',$3,$4,$5,'pending') RETURNING id`,
      [req.user.id, listing_id, finalAmount, req.user.phone || '', reference]
    );
    const paymentId = paymentRows[0].id;
    
    if (voucherRow) await query(`UPDATE vouchers SET uses = uses + 1 WHERE id = $1`, [voucherRow.id]);

    // Initialize Paystack transaction
    const paystackResult = await initializeTransaction({
      email: userEmail,
      amount: finalAmount,
      phone: req.user.phone || '',
      reference,
      description: `Unlock contact for: ${listing.title}`,
      metadata: { payment_id: paymentId, listing_id, type: 'unlock', voucher_code: voucher_code || null }
    });

    res.json({ 
      message: "Payment initialized. Complete payment on the checkout page.", 
      authorization_url: paystackResult.authorization_url,
      reference: paystackResult.reference,
      paymentId, 
      finalAmount, 
      discountPct 
    });

  } catch (err) { next(err); }
});

// ── POST /api/payments/escrow ──────────────────────────────────────────────────
router.post("/escrow", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, email } = req.body;
    if (!listing_id || !email) return res.status(400).json({ error: "listing_id and email are required" });
    
    const { rows: listingRows } = await query(`SELECT * FROM listings WHERE id = $1 AND status != 'deleted'`, [listing_id]);
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = listingRows[0];
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: "Seller cannot use escrow for their own listing" });
    
    const { rows: existingEscrow } = await query(`SELECT id FROM escrows WHERE listing_id = $1 AND status = 'holding'`, [listing_id]);
    if (existingEscrow.length) return res.status(409).json({ error: "An escrow is already active for this listing" });
    
    const feeAmount = Math.round(listing.price * ESCROW_FEE_PCT);
    const totalAmount = listing.price + feeAmount;
    const releaseAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Generate unique reference
    const reference = `WS-ESCROW-${listing_id.slice(0,8).toUpperCase()}-${Date.now()}`;

    await withTransaction(async (client) => {
      const { rows: paymentRows } = await client.query(
        `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, mpesa_receipt, status) VALUES ($1,$2,'escrow',$3,$4,$5,'pending') RETURNING id`,
        [req.user.id, listing_id, totalAmount, '', reference]
      );
      const paymentId = paymentRows[0].id;

await client.query(
      `INSERT INTO escrows (listing_id, buyer_id, seller_id, payment_id, item_amount, fee_amount, total_amount, amount_kes, status, release_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [listing_id, req.user.id, listing.seller_id, paymentId, listing.price, feeAmount, totalAmount, totalAmount, releaseAfter]
    );

      // Initialize Paystack transaction
      const paystackResult = await initializeTransaction({
        email,
        amount: totalAmount,
        phone: req.user.phone || '',
        reference,
        description: `Escrow payment for: ${listing.title}`,
        metadata: { payment_id: paymentId, listing_id, type: 'escrow', seller_id: listing.seller_id, buyer_id: req.user.id }
      });

      res.json({ 
        message: "Escrow payment initialized. Complete payment on the checkout page.",
        authorization_url: paystackResult.authorization_url,
        reference: paystackResult.reference,
        paymentId,
        breakdown: { item_price: listing.price, escrow_fee: feeAmount, total: totalAmount }
      });
    });
  } catch (err) { next(err); }
});

// ── POST /api/payments/paystack/webhook ──────────────────────────────────────────────
// Paystack webhook handler
router.post("/paystack/webhook", async (req, res, next) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const { event, data } = await handleWebhook(req.body, signature);

    // Acknowledge receipt immediately
    res.status(200).json({ received: true });

    // Process asynchronously
    if (event === 'charge.success') {
      const { reference, amount, status, metadata } = data;
      
      // Update payment record
      const { rows: paymentRows } = await query(
        `UPDATE payments SET status = 'confirmed', confirmed_at = NOW() WHERE mpesa_receipt = $1 RETURNING *`,
        [reference]
      );
      
      if (paymentRows.length) {
        const payment = paymentRows[0];
        
        if (payment.type === 'unlock') {
          await query(`UPDATE listings SET is_contact_public = TRUE, unlocked_at = NOW() WHERE id = $1`, [payment.listing_id]);
          
          // Get listing details for notification
          const { rows: listingRows } = await query(
            `SELECT l.*, u.name AS seller_name, u.email AS seller_email FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
            [payment.listing_id]
          );
          
          if (listingRows.length) {
            const listing = listingRows[0];
            
            // Notify seller
            await query(
              `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
              [listing.seller_id, 'listing_unlocked', 'Contact Info Unlocked', 
               `Your listing "${listing.title}" is now unlocked. Buyers can see your contact info.`,
               JSON.stringify({ listing_id: listing.id })]
            ).catch(()=>{});
            
            sendPushToUser(listing.seller_id, {
              type: "listing_unlocked",
              title: "Contact Info Unlocked",
              body: `Your listing "${listing.title}" is now unlocked.`,
              data: { listing_id: listing.id }
            }).catch(()=>{});

            // Send confirmation email
            try {
              await sendPaymentConfirmationEmail({
                to: listing.seller_email,
                name: listing.seller_name,
                type: 'unlock',
                listingTitle: listing.title,
                amount: payment.amount_kes,
                receipt: reference
              });
            } catch (e) { console.error('Email error:', e); }
          }
        } else if (payment.type === 'escrow') {
          await query(`UPDATE escrows SET status = 'holding' WHERE payment_id = $1`, [payment.id]);
          
          // Notify both parties
          const { rows: escrowRows } = await query(
            `SELECT e.*, l.title, l.seller_id, e.buyer_id FROM escrows e JOIN listings l ON l.id = e.listing_id WHERE e.payment_id = $1`,
            [payment.id]
          );
          
          if (escrowRows.length) {
            const escrow = escrowRows[0];
            
            // Notify buyer
            await query(
              `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
              [escrow.buyer_id, 'escrow_confirmed', 'Escrow Payment Confirmed',
               `Your escrow payment for "${escrow.title}" has been confirmed. Funds are held securely.`,
               JSON.stringify({ escrow_id: escrow.id, listing_id: escrow.listing_id })]
            ).catch(()=>{});

            // Notify seller
            await query(
              `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
              [escrow.seller_id, 'escrow_received', 'Escrow Payment Received',
               `Payment received for "${escrow.title}". Funds held until buyer confirms receipt.`,
               JSON.stringify({ escrow_id: escrow.id, listing_id: escrow.listing_id })]
            ).catch(()=>{});
          }
        }
      }
    }
  } catch (err) { 
    console.error('Webhook error:', err);
    res.status(200).json({ received: true }); // Still return 200 to prevent retries
  }
});

// ── GET /api/payments/status/:reference ──────────────────────────────────────────────
// Check payment status by Paystack reference
router.get("/status/:reference", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, status, type, listing_id, confirmed_at, mpesa_receipt FROM payments WHERE mpesa_receipt = $1`,
      [req.params.reference]
    );
    
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    
    const payment = rows[0];
    
    if (payment.status === 'confirmed') {
      return res.json({ status: "confirmed", payment });
    }
    
    // Verify with Paystack
    try {
      const paystackStatus = await verifyTransaction(req.params.reference);
      if (paystackStatus.status && paystackStatus.data.status === 'success') {
        // Update if Paystack says it's successful but we haven't recorded it
        await query(`UPDATE payments SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`, [payment.id]);
        return res.json({ status: "confirmed", payment: { ...payment, status: 'confirmed' } });
      }
    } catch (e) { console.error('Paystack verify error:', e); }
    
    res.json({ status: payment.status, payment });
  } catch (err) { next(err); }
});

// ── POST /api/payments/escrow/:id/confirm-receipt ──────────────────────────────────────────
// Buyer confirms receipt, release funds to seller
router.post("/escrow/:id/confirm-receipt", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, l.title, l.seller_id, l.locked_buyer_id, p.mpesa_receipt, p.amount_kes, u.name AS seller_name, u.email AS seller_email
       FROM escrows e
       JOIN listings l ON l.id = e.listing_id
       JOIN payments p ON p.id = e.payment_id
       JOIN users u ON u.id = e.seller_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    const escrow = rows[0];
    if (escrow.locked_buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can confirm receipt" });
    if (escrow.status !== "holding") return res.status(400).json({ error: "Escrow is not in holding state" });

    await query(`UPDATE escrows SET status = 'released', released_at = NOW() WHERE id = $1`, [req.params.id]);
    
    // Notify seller that funds are released
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
      [escrow.seller_id, 'escrow_released', 'Funds Released',
       `Buyer confirmed receipt. Your payment for "${escrow.title}" has been released.`,
       JSON.stringify({ escrow_id: escrow.id, listing_id: escrow.listing_id })]
    ).catch(()=>{});

    // Send confirmation to seller
    try {
      const { sendEscrowReleasedEmail } = require("../services/notification.service");
      await sendEscrowReleasedEmail({
        to: escrow.seller_email,
        name: escrow.seller_name,
        listingTitle: escrow.title,
        amount: escrow.amount_kes,
        receipt: escrow.mpesa_receipt
      });
    } catch (e) { console.error('Email error:', e); }

    res.json({ ok: true, message: "Receipt confirmed. Seller has been notified." });
  } catch (err) { next(err); }
});

// ── POST /api/payments/escrow/:id/dispute ─────────────────────────────────────────────────────
// Buyer opens a dispute
router.post("/escrow/:id/dispute", requireAuth, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const { rows } = await query(
      `SELECT e.*, l.title, l.seller_id, l.locked_buyer_id FROM escrows e JOIN listings l ON l.id = e.listing_id WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Escrow not found" });
    const escrow = rows[0];
    if (escrow.locked_buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can dispute" });
    if (escrow.status !== "holding") return res.status(400).json({ error: "Escrow is not in holding state" });

    await query(
      `INSERT INTO disputes (escrow_id, listing_id, opened_by, reason, status, opened_at) VALUES ($1,$2,$3,$4,'open',NOW())`,
      [escrow.id, escrow.listing_id, req.user.id, reason || '']    );
    await query(`UPDATE escrows SET status = 'disputed' WHERE id = $1`, [req.params.id]);

    // Notify admin
    const { rows: admins } = await query(`SELECT id FROM users WHERE role = 'admin'`);
    for (const admin of admins) {
      await query(
        `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`,
        [admin.id, 'new_dispute', 'New Escrow Dispute',
         `A dispute has been opened for "${escrow.title}"`,
         JSON.stringify({ escrow_id: escrow.id, listing_id: escrow.listing_id })]
      ).catch(()=>{});
    }

    res.json({ ok: true, message: "Dispute opened. An admin will review it shortly." });
  } catch (err) { next(err); }
});

// ── POST /api/payments/verify-manual ───────────────────────────────────────────────────────────
// Manual payment verification (for admin or webhook fallback)
router.post("/verify-manual", requireAuth, async (req, res, next) => {
  try {
    const { paystack_ref, listing_id, type } = req.body;
    if (!paystack_ref || !listing_id || !type) return res.status(400).json({ error: "paystack_ref, listing_id and type are required" });
    
    const reference = paystack_ref.trim().toUpperCase();
    
    // Check if already confirmed
    const { rows: existing } = await query(`SELECT id, status FROM payments WHERE mpesa_receipt = $1`, [reference]);
    if (existing.length && existing[0].status === 'confirmed') {
      return res.status(400).json({ error: "Payment already confirmed" });
    }

    // Verify with Paystack
    const paystackStatus = await verifyTransaction(reference);
    if (!paystackStatus.status || paystackStatus.data.status !== 'success') {
      return res.status(400).json({ error: "Payment not verified with Paystack" });
    }

    // Update payment
    const { rows: payments } = await query(
      `SELECT * FROM payments WHERE listing_id=$1 AND type=$2 AND mpesa_receipt=$3 ORDER BY created_at DESC LIMIT 1`,
      [listing_id, type, reference]
    );
    if (!payments.length) return res.status(404).json({ error: "Payment record not found" });
    
    await query(`UPDATE payments SET status='confirmed', confirmed_at=NOW() WHERE id=$1`, [payments[0].id]);

    if (type === 'unlock') {
      await query(`UPDATE listings SET is_contact_public=TRUE, unlocked_at=NOW() WHERE id=$1`, [listing_id]);
    } else if (type === 'escrow') {
      await query(`UPDATE escrows SET status='holding' WHERE payment_id=$1`, [payments[0].id]);
    }

    res.json({ ok: true, message: `Payment confirmed with reference ${reference}` });
  } catch (err) { next(err); }
});

// ── POST /api/payments/:id/refund ───────────────────────────────────────────────────────────
// Process refund for disputed escrow
router.post("/:id/refund", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, e.status as escrow_status FROM payments p LEFT JOIN escrows e ON e.payment_id = p.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const payment = rows[0];
    
    if (payment.status !== 'confirmed') return res.status(400).json({ error: "Payment not confirmed" });
    if (payment.type !== 'escrow') return res.status(400).json({ error: "Only escrow payments can be refunded" });
    if (payment.escrow_status !== 'disputed') return res.status(400).json({ error: "Escrow must be in disputed state" });

    // Process Paystack refund
    try {
      const { processRefund } = require("../services/paystack.service");
      await processRefund(payment.mpesa_receipt, payment.amount_kes);
      
      await query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment.id]);
      await query(`UPDATE escrows SET status = 'refunded' WHERE payment_id = $1`, [payment.id]);
      
      res.json({ ok: true, message: "Refund processed successfully" });
    } catch (e) {
      console.error('Refund error:', e);
      res.status(500).json({ error: "Failed to process refund" });
    }
  } catch (err) { next(err); }
});

module.exports = router;
