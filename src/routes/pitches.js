// src/routes/pitches.js — Seller replies to buyer requests ("I Have This")
const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireSeller } = require("../middleware/auth");
const router = express.Router();

// ── POST /api/pitches — Seller pitches to a buyer request ────────────────────
// Seller writes a short pitch (max 200 chars, no contact info)
// Buyer gets notified and can accept — revealing the seller's contact
router.post("/", requireAuth, requireSeller, async (req, res, next) => {
  try {
    const { request_id, message, price } = req.body;
    if (!request_id || !message) return res.status(400).json({ error: "request_id and message are required" });
    if (message.length > 200) return res.status(400).json({ error: "Pitch must be 200 characters or less" });

    // Check the request exists and is active
    const { rows: reqRows } = await query(
      `SELECT * FROM buyer_requests WHERE id=$1 AND status='active'`, [request_id]
    );
    if (!reqRows.length) return res.status(404).json({ error: "Buyer request not found or no longer active" });
    const buyerRequest = reqRows[0];

    // Seller can't pitch on their own request
    if (buyerRequest.user_id === req.user.id) return res.status(400).json({ error: "Cannot pitch on your own request" });

    // Check for duplicate pitch from same seller
    const { rows: existing } = await query(
      `SELECT id FROM seller_pitches WHERE request_id=$1 AND seller_id=$2 AND status!='withdrawn'`,
      [request_id, req.user.id]
    );
    if (existing.length) return res.status(409).json({ error: "You have already pitched on this request" });

    // Save the pitch
    const { rows: pitch } = await query(
      `INSERT INTO seller_pitches (request_id, seller_id, message, offered_price, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [request_id, req.user.id, message.trim(), price ? parseFloat(price) : null]
    );

    // Notify the buyer
    const sellerAnon = req.user.anon_tag || "A seller";
    await query(
      `INSERT INTO notifications (user_id,type,title,body,data)
       VALUES ($1,'seller_pitch','Someone has what you want!',$2,$3)`,
      [
        buyerRequest.user_id,
        `${sellerAnon} says they have "${buyerRequest.title}"${price ? ` for KSh ${parseFloat(price).toLocaleString()}` : ""}. Pay KSh 250 to reveal their contact.`,
        JSON.stringify({ pitch_id: pitch[0].id, request_id, seller_anon: sellerAnon, message, offered_price: price || null })
      ]
    );

    // Real-time push to buyer
    const io = req.app?.get("io");
    if (io) {
      io.to(`user:${buyerRequest.user_id}`).emit("notification", {
        type: "seller_pitch",
        title: "Someone has what you want!",
        body: `${sellerAnon} has a match for your request: "${buyerRequest.title}"`,
        data: { pitch_id: pitch[0].id, request_id }
      });
    }

    res.status(201).json({ ok: true, pitch: pitch[0], message: "Pitch sent! The buyer has been notified." });
  } catch (err) { next(err); }
});

// ── POST /api/pitches/:id/accept — Buyer accepts a pitch (pays to reveal seller contact) ──
router.post("/:id/accept", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { phone, voucher_code } = req.body;

    // Get the pitch
    const { rows: pitchRows } = await query(
      `SELECT p.*, r.user_id AS buyer_id, r.title AS request_title
       FROM seller_pitches p JOIN buyer_requests r ON r.id=p.request_id
       WHERE p.id=$1`, [id]
    );
    if (!pitchRows.length) return res.status(404).json({ error: "Pitch not found" });
    const pitch = pitchRows[0];
    if (pitch.buyer_id !== req.user.id) return res.status(403).json({ error: "Not your request" });
    if (pitch.status !== "pending") return res.status(400).json({ error: "Pitch already responded to" });

    // Check for existing confirmed payment on this pitch
    const { rows: existingPay } = await query(
      `SELECT id FROM payments WHERE listing_id IS NULL AND payer_id=$1 AND status='confirmed'
       AND mpesa_receipt LIKE 'PITCH-%'`,
      [req.user.id]
    );

    // Check voucher
    let discountPct = 0;
    let voucherRow = null;
    if (voucher_code) {
      const { rows: vrows } = await query(
        `SELECT * FROM vouchers WHERE code=$1 AND active=true
         AND (expires_at IS NULL OR expires_at > NOW()) AND uses < max_uses`,
        [voucher_code.toUpperCase()]
      );
      if (vrows.length) { voucherRow = vrows[0]; discountPct = voucherRow.discount_percent || 0; }
    }

    const PITCH_FEE = 250;
    const finalAmount = Math.max(0, Math.round(PITCH_FEE * (1 - discountPct / 100)));

    // Free via voucher
    if (finalAmount === 0) {
      if (voucherRow) await query(`UPDATE vouchers SET uses=uses+1 WHERE id=$1`, [voucherRow.id]);
      await query(`UPDATE seller_pitches SET status='accepted', accepted_at=NOW() WHERE id=$1`, [id]);

      // Get seller's contact info
      const { rows: seller } = await query(`SELECT name,phone,email,anon_tag FROM users WHERE id=$1`, [pitch.seller_id]);

      // Notify seller
      await query(
        `INSERT INTO notifications (user_id,type,title,body,data) VALUES ($1,'pitch_accepted','Your pitch was accepted!',$2,$3)`,
        [pitch.seller_id, `A buyer accepted your pitch on "${pitch.request_title}". They now have your contact details.`, JSON.stringify({ request_id: pitch.request_id, pitch_id: id })]
      );
      const io = req.app?.get("io");
      if (io) io.to(`user:${pitch.seller_id}`).emit("notification", { type: "pitch_accepted", title: "Your pitch was accepted!", data: { pitch_id: id } });

      return res.json({ ok: true, unlocked: true, seller_contact: { name: seller[0].name, phone: seller[0].phone, email: seller[0].email } });
    }

    if (!phone) return res.status(400).json({ error: "phone is required for paid reveal" });

    // Initiate M-Pesa STK Push
    const { initiateSTKPush } = require("../services/mpesa.service");
    const { rows: payRow } = await query(
      `INSERT INTO payments (payer_id,type,amount_kes,mpesa_phone,status) VALUES ($1,'pitch_reveal',$2,$3,'pending') RETURNING id`,
      [req.user.id, finalAmount, phone]
    );
    const paymentId = payRow[0].id;
    if (voucherRow) await query(`UPDATE vouchers SET uses=uses+1 WHERE id=$1`, [voucherRow.id]);

    // Store pitch_id in payment so callback can handle it
    await query(`UPDATE payments SET mpesa_receipt='PITCH-PENDING-' || $1 WHERE id=$2`, [id, paymentId]);

    const result = await initiateSTKPush({
      phone, amount: finalAmount,
      accountRef: `WS-PITCH-${id.slice(0,8).toUpperCase()}`,
      description: `Weka Soko — reveal seller contact`,
      paymentId,
    });

    res.json({
      message: "STK Push sent. Enter your M-Pesa PIN to reveal seller contact.",
      checkoutRequestId: result.checkoutRequestId,
      paymentId,
      finalAmount,
    });
  } catch (err) { next(err); }
});

// ── POST /api/pitches/:id/decline — Buyer declines a pitch ───────────────────
router.post("/:id/decline", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: pitchRows } = await query(
      `SELECT p.*, r.user_id AS buyer_id FROM seller_pitches p JOIN buyer_requests r ON r.id=p.request_id WHERE p.id=$1`, [id]
    );
    if (!pitchRows.length) return res.status(404).json({ error: "Pitch not found" });
    if (pitchRows[0].buyer_id !== req.user.id) return res.status(403).json({ error: "Not your request" });
    await query(`UPDATE seller_pitches SET status='declined' WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/pitches/mine — Seller sees their own pitches ────────────────────
router.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, r.title AS request_title, r.description AS request_description,
              r.budget, r.county AS request_county
       FROM seller_pitches p JOIN buyer_requests r ON r.id=p.request_id
       WHERE p.seller_id=$1 ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/pitches/for-request/:requestId — Buyer sees pitches on their request ──
router.get("/for-request/:requestId", requireAuth, async (req, res, next) => {
  try {
    const { rows: reqRows } = await query(`SELECT user_id FROM buyer_requests WHERE id=$1`, [req.params.requestId]);
    if (!reqRows.length) return res.status(404).json({ error: "Request not found" });
    if (reqRows[0].user_id !== req.user.id) return res.status(403).json({ error: "Not your request" });
    const { rows } = await query(
      `SELECT p.id, p.message, p.offered_price, p.status, p.created_at,
              u.anon_tag AS seller_anon
       FROM seller_pitches p JOIN users u ON u.id=p.seller_id
       WHERE p.request_id=$1 AND p.status!='withdrawn' ORDER BY p.created_at DESC`,
      [req.params.requestId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
