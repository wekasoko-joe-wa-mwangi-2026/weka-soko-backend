// src/routes/payments.js
const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { initiateSTKPush, handleCallback, querySTKStatus } = require("../services/mpesa.service");
const { safePaymentUpdate, ConcurrencyError } = require("../services/concurrency.service");

const router = express.Router();
const { sendPushToUser } = require("./push");
const UNLOCK_FEE = parseInt(process.env.UNLOCK_FEE_KES || "250");
const ESCROW_FEE_PCT = parseFloat(process.env.ESCROW_FEE_PERCENT || "5.5") / 100;

// ── POST /api/payments/unlock ──────────────────────────────────────────────────
// Uses optimistic locking to prevent double-unlock race conditions
router.post("/unlock", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, phone, voucher_code, version } = req.body;
    if (!listing_id) return res.status(400).json({ error: "listing_id is required" });

    const { rows: listingRows } = await query(
      `SELECT * FROM listings WHERE id = $1 AND status != 'deleted'`,
      [listing_id]
    );
    if (!listingRows.length) return res.status(404).json({ error: "Listing not found" });
    const listing = listingRows[0];

    if (listing.seller_id !== req.user.id)
      return res.status(403).json({ error: "Only the seller can unlock this listing" });
    if (listing.is_contact_public)
      return res.status(400).json({ error: "Listing is already unlocked" });

    if (version !== undefined && version !== listing.version) {
      return res.status(409).json({
        error: "Listing was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: listing.version
      });
    }

    let discountPct = 0, voucherRow = null;
    if (voucher_code) {
      const { rows: vrows } = await query(
        `SELECT * FROM vouchers WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND uses < max_uses`,
        [voucher_code.toUpperCase()]
      );
      if (vrows.length) { voucherRow = vrows[0]; discountPct = voucherRow.discount_percent || 0; }
    }

    const adminDiscount = parseInt(listing.unlock_discount || 0);
    const baseAmount = Math.max(0, UNLOCK_FEE - adminDiscount);
    const finalAmount = Math.max(0, Math.round(baseAmount * (1 - discountPct / 100)));

    const { rows: existingPayment } = await query(
      `SELECT id FROM payments WHERE listing_id = $1 AND type = 'unlock' AND status = 'confirmed'`,
      [listing_id]
    );
    if (existingPayment.length)
      return res.status(400).json({ error: "Payment already confirmed for this listing" });

    if (finalAmount === 0) {
      const result = await withTransaction(async (client) => {
        if (voucherRow) await client.query(`UPDATE vouchers SET uses = uses + 1, version = version + 1 WHERE id = $1`, [voucherRow.id]);
        const { rows: paymentRows } = await client.query(
          `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, status, confirmed_at, mpesa_receipt, version) VALUES ($1,$2,'unlock',0,'voucher','confirmed',NOW(),$3,1) RETURNING *`,
          [req.user.id, listing_id, `VOUCHER-${voucher_code}`]
        );

        const unlockResult = await client.query(
          `UPDATE listings SET unlocked_at = NOW(), is_contact_public = TRUE, version = version + 1 WHERE id = $1 AND version = $2 RETURNING *`,
          [listing_id, listing.version]
        );

        if (!unlockResult.rowCount) {
          throw new ConcurrencyError("Listing was modified by another request. Please refresh.", "OPTIMISTIC_LOCK_FAILED");
        }

        return paymentRows[0];
      });

      const { rows: unlocked } = await query(
        `SELECT l.*, u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
        [listing_id]
      );
      const unlockPayload = { type: "listing_unlocked", title: "🔓 Contact Info Unlocked!", body: `Your listing "${listing.title}" is now unlocked. Buyers can see your contact info.`, data: { listing_id } };
      await query(`INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)`, [listing.seller_id, unlockPayload.type, unlockPayload.title, unlockPayload.body, JSON.stringify(unlockPayload.data)]).catch(()=>{});
      sendPushToUser(listing.seller_id, unlockPayload).catch(()=>{});
      return res.json({ unlocked: true, listing: unlocked[0], message: "Contact details unlocked via voucher!" });
    }

    if (!phone) return res.status(400).json({ error: "phone is required for paid unlock" });

    const { rows: paymentRows } = await query(
      `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, version) VALUES ($1,$2,'unlock',$3,$4,1) RETURNING id`,
      [req.user.id, listing_id, finalAmount, phone]
    );
    const paymentId = paymentRows[0].id;
    if (voucherRow) await query(`UPDATE vouchers SET uses = uses + 1, version = version + 1 WHERE id = $1`, [voucherRow.id]);

    const result = await initiateSTKPush({
      phone, amount: finalAmount,
      accountRef: `WS-UNLOCK-${listing_id.slice(0,8).toUpperCase()}`,
      description: `Weka Soko unlock - ${listing.title}`,
      paymentId,
    });
    res.json({ message: "STK Push sent. Enter your M-Pesa PIN to confirm.", checkoutRequestId: result.checkoutRequestId, paymentId, finalAmount, discountPct });
  } catch (err) {
    if (err.code === "OPTIMISTIC_LOCK_FAILED") return res.status(409).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── POST /api/payments/escrow ──────────────────────────────────────────────────
// Uses SELECT FOR UPDATE to prevent race conditions when creating escrow
router.post("/escrow", requireAuth, async (req, res, next) => {
  try {
    const { listing_id, phone } = req.body;
    if (!listing_id || !phone) return res.status(400).json({ error: "listing_id and phone are required" });

    const result = await withTransaction(async (client) => {
      const { rows: listingRows } = await client.query(
        `SELECT * FROM listings WHERE id = $1 AND status != 'deleted' FOR UPDATE`,
        [listing_id]
      );
      if (!listingRows.length) throw new ConcurrencyError("Listing not found", "NOT_FOUND");
      const listing = listingRows[0];

      if (listing.seller_id === req.user.id)
        throw new ConcurrencyError("Seller cannot use escrow for their own listing", "SELF_ESCROW");

      const { rows: existingEscrow } = await client.query(
        `SELECT id FROM escrows WHERE listing_id = $1 AND status = 'holding' FOR UPDATE`,
        [listing_id]
      );
      if (existingEscrow.length)
        throw new ConcurrencyError("An escrow is already active for this listing", "ESCROW_EXISTS");

      const feeAmount = Math.round(listing.price * ESCROW_FEE_PCT);
      const totalAmount = listing.price + feeAmount;

      const { rows: paymentRows } = await client.query(
        `INSERT INTO payments (payer_id, listing_id, type, amount_kes, mpesa_phone, version) VALUES ($1,$2,'escrow',$3,$4,1) RETURNING id`,
        [req.user.id, listing_id, totalAmount, phone]
      );
      const paymentId = paymentRows[0].id;
      const releaseAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO escrows (listing_id, buyer_id, seller_id, payment_id, item_amount, fee_amount, total_amount, status, release_after, version) VALUES ($1,$2,$3,$4,$5,$6,$7,'holding',$8,1)`,
        [listing_id, req.user.id, listing.seller_id, paymentId, listing.price, feeAmount, totalAmount, releaseAfter]
      );
      await client.query(`UPDATE listings SET status = 'locked', version = version + 1 WHERE id = $1`, [listing_id]);
      return { paymentId, listing, totalAmount, feeAmount };
    });

    const stkResult = await initiateSTKPush({ phone, amount: result.totalAmount, accountRef: `WS-ESCROW-${listing_id.slice(0,8).toUpperCase()}`, description: `Weka Soko escrow - ${result.listing.title}`, paymentId: result.paymentId });
    res.json({ message: `STK Push sent for KSh ${result.totalAmount.toLocaleString()} (includes 5.5% escrow fee). Enter your M-Pesa PIN.`, checkoutRequestId: stkResult.checkoutRequestId, breakdown: { item_price: result.listing.price, escrow_fee: result.feeAmount, total: result.totalAmount } });
  } catch (err) {
    if (err.code === "ESCROW_EXISTS") return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === "NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
    if (err.code === "SELF_ESCROW") return res.status(400).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── POST /api/payments/mpesa/callback ──────────────────────────────────────────────
router.post("/mpesa/callback", async (req, res, next) => {
  try {
    const result = await handleCallback(req.body);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    if (!result.success) console.warn("M-Pesa callback failure:", result);
  } catch (err) { console.error("M-Pesa callback error:", err); res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" }); }
});

// ── GET /api/payments/status/:checkoutRequestId ──────────────────────────────────────────
router.get("/status/:checkoutRequestId", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, status, type, listing_id, confirmed_at, mpesa_receipt FROM payments WHERE mpesa_checkout_id = $1`, [req.params.checkoutRequestId]);
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const payment = rows[0];
    if (payment.status === "confirmed") return res.json({ status: "confirmed", payment });
    if (payment.status === "failed") return res.json({ status: "failed", payment });
    try {
      const darajaStatus = await querySTKStatus(req.params.checkoutRequestId);
      if (darajaStatus.ResultCode === "0") return res.json({ status: "pending_confirmation", daraja: darajaStatus });
    } catch {}
    res.json({ status: payment.status, payment });
  } catch (err) { next(err); }
});

// ── POST /api/payments/escrow/:id/confirm-receipt ──────────────────────────────────────────
// Uses optimistic locking to prevent double-confirmation race conditions
router.post("/escrow/:id/confirm-receipt", requireAuth, async (req, res, next) => {
  try {
    const { version } = req.body;
    const { rows } = await query(`SELECT * FROM escrows WHERE id = $1 AND buyer_id = $2 AND status = 'holding'`, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or not yours" });
    const escrow = rows[0];

    if (version !== undefined && version !== escrow.version) {
      return res.status(409).json({
        error: "Escrow was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: escrow.version
      });
    }

    const result = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE escrows SET buyer_confirmed=TRUE, buyer_confirmed_at=NOW(), status='released', released_at=NOW(), released_by=$1, version=version+1 WHERE id=$2 AND version=$3 RETURNING *`,
        [req.user.id, req.params.id, escrow.version]
      );

      if (!updateResult.rowCount) {
        throw new ConcurrencyError("Escrow was modified by another request. Please refresh.", "OPTIMISTIC_LOCK_FAILED");
      }

      await client.query(`UPDATE listings SET status='sold', version=version+1 WHERE id=$1`, [escrow.listing_id]);
      return updateResult.rows[0];
    });

    const escrowReleasePayload = { type: "escrow_released", title: "💰 Funds Released!", body: "The buyer confirmed receipt. Your payment has been released — check your M-Pesa.", data: { escrow_id: req.params.id } };
    await query(`INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'escrow_released','💰 Funds Released!',$2,$3)`, [escrow.seller_id, escrowReleasePayload.body, JSON.stringify({ escrow_id: req.params.id })]);
    sendPushToUser(escrow.seller_id, escrowReleasePayload).catch(()=>{});
    res.json({ message: "Receipt confirmed. Funds released to seller." });
  } catch (err) {
    if (err.code === "OPTIMISTIC_LOCK_FAILED") return res.status(409).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── POST /api/payments/escrow/:id/dispute ─────────────────────────────────────────────────────
// Uses optimistic locking to prevent race conditions
router.post("/escrow/:id/dispute", requireAuth, async (req, res, next) => {
  try {
    const { reason, version } = req.body;
    if (!reason) return res.status(400).json({ error: "Reason for dispute is required" });
    const { rows } = await query(`SELECT * FROM escrows WHERE id=$1 AND buyer_id=$2 AND status='holding'`, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Escrow not found or already resolved" });
    const escrow = rows[0];

    if (version !== undefined && version !== escrow.version) {
      return res.status(409).json({
        error: "Escrow was modified by another request. Please refresh and try again.",
        code: "OPTIMISTIC_LOCK_FAILED",
        currentVersion: escrow.version
      });
    }

    const result = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE escrows SET status='disputed', version=version+1 WHERE id=$1 AND version=$2 RETURNING *`,
        [req.params.id, escrow.version]
      );

      if (!updateResult.rowCount) {
        throw new ConcurrencyError("Escrow was modified by another request. Please refresh.", "OPTIMISTIC_LOCK_FAILED");
      }

      await client.query(`INSERT INTO disputes (escrow_id, raised_by, reason) VALUES ($1,$2,$3)`, [req.params.id, req.user.id, reason]);
      return updateResult.rows[0];
    });

    res.json({ message: "Dispute raised. Our team will review within 24 hours." });
  } catch (err) {
    if (err.code === "OPTIMISTIC_LOCK_FAILED") return res.status(409).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── POST /api/payments/retry ──────────────────────────────────────────────────
// Risk 2: User can retry a failed STK push without losing their payment record
router.post("/retry", requireAuth, async (req, res, next) => {
  try {
    const { payment_id, phone } = req.body;
    if (!payment_id || !phone) return res.status(400).json({ error: "payment_id and phone required" });
    const { rows } = await query(
      `SELECT * FROM payments WHERE id=$1 AND payer_id=$2 AND status='pending'`,
      [payment_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Pending payment not found" });
    const payment = rows[0];
    const result = await initiateSTKPush({
      phone,
      amount: payment.amount_kes,
      accountRef: `WS-RETRY-${payment.listing_id?.slice(0,8).toUpperCase() || payment_id.slice(0,8).toUpperCase()}`,
      description: `Weka Soko payment retry`,
      paymentId: payment.id,
    });
    await query(`UPDATE payments SET mpesa_phone=$1, updated_at=NOW() WHERE id=$2`, [phone, payment.id]);
    res.json({ message: "STK Push resent. Enter your M-Pesa PIN.", checkoutRequestId: result.checkoutRequestId });
  } catch (err) { next(err); }
});

// ── POST /api/payments/verify-manual ───────────────────────────────────────────────────────────
// Uses transaction with row locking to prevent double-confirmation race conditions
router.post("/verify-manual", requireAuth, async (req, res, next) => {
  try {
    const { mpesa_code, listing_id, type, version } = req.body;
    if (!mpesa_code || !listing_id || !type) return res.status(400).json({ error: "mpesa_code, listing_id and type are required" });
    const code = mpesa_code.trim().toUpperCase();

    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT id, status FROM payments WHERE mpesa_receipt = $1 FOR UPDATE`,
        [code]
      );
      if (existing.length && existing[0].status === "confirmed") {
        throw new ConcurrencyError("This transaction code has already been used.", "ALREADY_USED");
      }

      const { rows: payments } = await client.query(
        `SELECT * FROM payments WHERE listing_id=$1 AND type=$2 AND payer_id=$3 AND status='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [listing_id, type, req.user.id]
      );

      let paymentId;
      if (!payments.length) {
        const { rows: listingRows } = await client.query(`SELECT * FROM listings WHERE id=$1 FOR UPDATE`, [listing_id]);
        if (!listingRows.length) throw new ConcurrencyError("Listing not found", "NOT_FOUND");
        const amount = type === "unlock" ? parseInt(process.env.UNLOCK_FEE_KES || "250") : listingRows[0].price;
        const { rows: newPayment } = await client.query(
          `INSERT INTO payments (payer_id,listing_id,type,amount_kes,mpesa_phone,version) VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
          [req.user.id, listing_id, type, amount, "manual"]
        );
        paymentId = newPayment[0].id;
      } else {
        paymentId = payments[0].id;
      }

      await client.query(
        `UPDATE payments SET status='confirmed', mpesa_receipt=$1, confirmed_at=NOW(), version=version+1 WHERE id=$2`,
        [code, paymentId]
      );

      if (type === "unlock") {
        await client.query(
          `UPDATE listings SET status='pending_review', unlocked_at=NOW(), is_contact_public=TRUE, version=version+1 WHERE id=$1`,
          [listing_id]
        );
        const { rows: unlocked } = await client.query(
          `SELECT l.*, u.name AS seller_name, u.phone AS seller_phone, u.email AS seller_email FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1`,
          [listing_id]
        );
        return { ok: true, status: "confirmed", receipt: code, listing: unlocked[0] };
      }
      return { ok: true, status: "confirmed", receipt: code };
    });

    res.json(result);
  } catch (err) {
    if (err.code === "ALREADY_USED") return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === "NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
