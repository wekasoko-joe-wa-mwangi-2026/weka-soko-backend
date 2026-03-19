// src/routes/push.js
// Web Push notification subscriptions + sending
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BP3ld9PLaKtag2FUgo7RnvJkikkxZLJfW5muX4ALMQNJvFN5IwM_mqqvME5MarKiLFCNkGt3zqtIC0bxnPBqOBQ";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "Ugxaico8CKcwo7w2bFr__aRlkMA5rck6uGjLoPjJSK0";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@wekasoko.co.ke";

// ── GET /api/push/vapid-public-key ───────────────────────────────────────────
router.get("/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
router.post("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: "Invalid subscription" });

    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys?.p256dh || null;
    const auth = subscription.keys?.auth || null;

    // Upsert — update if endpoint already exists for this user
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id=$1, p256dh=$3, auth=$4, updated_at=NOW()`,
      [req.user.id, endpoint, p256dh, auth]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/push/unsubscribe ─────────────────────────────────────────────
router.delete("/unsubscribe", requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    await query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`, [req.user.id, endpoint]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── sendPushToUser — call this from anywhere in the backend ──────────────────
async function sendPushToUser(userId, payload) {
  try {
    const { rows } = await query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1`,
      [userId]
    );
    if (!rows.length) return;

    const payloadStr = JSON.stringify(payload);
    const results = await Promise.allSettled(rows.map(sub => sendPush(sub, payloadStr)));

    // Clean up expired/invalid subscriptions
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const err = result.reason;
        if (err.statusCode === 404 || err.statusCode === 410) {
          query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [rows[i].endpoint]).catch(() => {});
        }
      }
    });
  } catch (e) {
    console.warn("[Push] sendPushToUser error:", e.message);
  }
}

// ── Low-level VAPID push sender (no external dependencies) ───────────────────
async function sendPush(subscription, payloadStr) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  // Build JWT header + claims
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  }));
  const sigInput = `${header}.${claims}`;

  // Sign with private key
  const privateKeyBuffer = Buffer.from(VAPID_PRIVATE_KEY, "base64url");
  const sign = crypto.createSign("SHA256");
  sign.update(sigInput);
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", "hex"),
      privateKeyBuffer,
      Buffer.from("a14403420004", "hex"),
      Buffer.from(VAPID_PUBLIC_KEY, "base64url"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const derSig = crypto.sign("SHA256", Buffer.from(sigInput), keyObj);
  const jwt = `${sigInput}.${derToJwt(derSig)}`;

  const vapidAuth = `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`;

  // Encrypt payload if keys provided
  let body = null;
  let headers = {
    "Authorization": vapidAuth,
    "TTL": "86400",
  };

  if (payloadStr && subscription.p256dh && subscription.auth) {
    const encrypted = await encryptPayload(payloadStr, subscription.p256dh, subscription.auth);
    body = encrypted.ciphertext;
    headers = {
      ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Content-Length": String(body.length),
    };
  }

  return new Promise((resolve, reject) => {
    const req = https.request(subscription.endpoint, { method: "POST", headers }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else {
        const err = new Error(`Push failed: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        reject(err);
      }
      res.resume();
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function b64url(str) {
  return Buffer.from(str).toString("base64url");
}

function derToJwt(der) {
  // Convert DER-encoded signature to R||S format for JWT
  let offset = 2;
  if (der[1] === 0x81) offset = 3;
  const rLen = der[offset + 1];
  let r = der.slice(offset + 2, offset + 2 + rLen);
  const sLen = der[offset + 2 + rLen + 1];
  let s = der.slice(offset + 2 + rLen + 2);
  // Pad/trim to 32 bytes each
  if (r[0] === 0) r = r.slice(1);
  if (s[0] === 0) s = s.slice(1);
  const rPad = Buffer.alloc(32); r.copy(rPad, 32 - r.length);
  const sPad = Buffer.alloc(32); s.copy(sPad, 32 - s.length);
  return Buffer.concat([rPad, sPad]).toString("base64url");
}

async function encryptPayload(plaintext, p256dhB64, authB64) {
  const receiverPub = Buffer.from(p256dhB64, "base64url");
  const authSecret = Buffer.from(authB64, "base64url");

  // Generate ephemeral key pair
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const senderPub = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(receiverPub);

  // HKDF — auth info
  const authInfo = Buffer.from("Content-Encoding: auth\0", "utf8");
  const prk = hkdf(authSecret, sharedSecret, authInfo, 32);

  // HKDF — content encryption key
  const salt = crypto.randomBytes(16);
  const keyInfo = buildInfo("aesgcm", receiverPub, senderPub);
  const contentKey = hkdf(salt, prk, keyInfo, 16);
  const nonceInfo = buildInfo("nonce", receiverPub, senderPub);
  const nonce = hkdf(salt, prk, nonceInfo, 12);

  // Encrypt
  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const padded = Buffer.concat([Buffer.alloc(2), Buffer.from(plaintext)]);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm record format: salt(16) + rs(4) + keyid_len(1) + keyid + ciphertext
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const keyidLen = Buffer.alloc(1); keyidLen.writeUInt8(senderPub.length, 0);
  const ciphertext = Buffer.concat([salt, rs, keyidLen, senderPub, encrypted]);
  return { ciphertext };
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const t = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.slice(0, length);
}

function buildInfo(type, receiverPub, senderPub) {
  const typeBuffer = Buffer.from(`Content-Encoding: ${type}\0`, "utf8");
  const contextLen = Buffer.alloc(1); contextLen.writeUInt8(0, 0);
  const r = Buffer.alloc(2); r.writeUInt16BE(receiverPub.length, 0);
  const s = Buffer.alloc(2); s.writeUInt16BE(senderPub.length, 0);
  return Buffer.concat([typeBuffer, contextLen, r, receiverPub, s, senderPub]);
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
