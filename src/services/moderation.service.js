// src/services/moderation.service.js — Weka Soko Contact Info Moderation Engine
// Covers every known method users attempt to share contact info before unlock

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalize(text) {
  return text
    .toLowerCase()
    // Word-to-digit conversions (must do before l33t so "zero" → 0)
    .replace(/\bzero\b/g, "0").replace(/\bone\b/g, "1").replace(/\btwo\b/g, "2")
    .replace(/\bthree\b/g, "3").replace(/\bfour\b/g, "4").replace(/\bfive\b/g, "5")
    .replace(/\bsix\b/g, "6").replace(/\bseven\b/g, "7").replace(/\beight\b/g, "8")
    .replace(/\bnine\b/g, "9")
    // Swahili/mixed word numbers
    .replace(/\bsita\b/g, "6").replace(/\bsaba\b/g, "7").replace(/\bnane\b/g, "8")
    .replace(/\btisa\b/g, "9").replace(/\bmoja\b/g, "1").replace(/\bmbili\b/g, "2")
    .replace(/\btatu\b/g, "3").replace(/\bne\b/g, "4").replace(/\btano\b/g, "5")
    // L33tspeak
    .replace(/o/g, "0").replace(/i/g, "1").replace(/l/g, "1")
    .replace(/e/g, "3").replace(/a/g, "4").replace(/s/g, "5")
    .replace(/g/g, "6").replace(/t/g, "7").replace(/b/g, "8")
    // Remove ALL separators so "0.7.4.3" → "0743"
    .replace(/[\s\.\-\•\*\_\|\\\\/,;:~`'"!@#$%^&()\[\]{}]/g, "")
    // Remove common filler words between digits
    .replace(/\b(and|then|oh|uh|um|er|na|kwa)\b/g, "");
}

// Extract only digits from a string
function digitsOnly(text) {
  return text.replace(/\D/g, "");
}

// Check if a string, after normalization, contains a Kenyan phone number
function containsKEPhone(normalizedText) {
  // After normalization all numbers are digits; look for 07xx or 01xx (10 digits) or 2547xx (12)
  const digits = digitsOnly(normalizedText);
  // Kenyan phone: 07XXXXXXXX or 01XXXXXXXX (10 digits) or 2547XXXXXXXX / 2541XXXXXXXX (12)
  return /07\d{8}|01\d{8}|2547\d{8}|2541\d{8}/.test(digits) ||
    // Any 10+ digit sequence starting with 0
    /0\d{9,}/.test(digits) ||
    // Any 12-digit sequence with 254 prefix
    /254\d{9}/.test(digits);
}

// Check for email-like pattern
function containsEmail(text) {
  // Standard email
  if (/[a-zA-Z0-9._%+\-]+\s*[@＠at]\s*[a-zA-Z0-9.\-]+\s*[.\s]\s*[a-zA-Z]{2,}/.test(text)) return true;
  // "name at domain dot com" style
  if (/\b\w{2,}\s+(at|@)\s+\w{2,}\s+(dot|\.)\s*\w{2,}\b/i.test(text)) return true;
  return false;
}

// ── Raw text patterns (checked before normalization) ──────────────────────────
const RAW_PATTERNS = [
  // Kenyan phone - digits with separators 07X X X X X X X X X
  {
    id: "ke_phone_sep",
    label: "Kenyan phone number",
    test: (t) => /0[17]\s*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d/.test(t),
  },
  // +254 / 254
  {
    id: "ke_phone_intl",
    label: "International phone number",
    test: (t) => /(\+|00)?\s*2\s*5\s*4\s*[\s\-\.]?[17]\d[\s\.\-\•\*]*\d{7}/.test(t),
  },
  // Any 10+ consecutive digits (disguised numbers)
  {
    id: "digit_seq",
    label: "Phone number (digit sequence)",
    test: (t) => /\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d[\s\.\-\•\/\\,]*\d/.test(t),
  },
  // Email
  { id: "email", label: "Email address", test: containsEmail },
  // URLs
  {
    id: "url",
    label: "Website link",
    test: (t) => /https?:\/\/[^\s]+|www\.[a-z0-9\-]+\.[a-z]{2,}/i.test(t),
  },
  // WhatsApp / Telegram / Signal
  {
    id: "messaging_app",
    label: "Messaging app reference",
    test: (t) => /\b(whatsapp|whats.?app|wa\.me|telegram|t\.me|signal\.me|signal app|viber|imo|snapchat)\b/i.test(t),
  },
  // Social media
  {
    id: "social",
    label: "Social media handle",
    test: (t) => /\b(instagram|insta\b|ig\b|facebook|fb\.com|twitter|tiktok|dm me|slide into|my dm|in my bio|linktree)\b/i.test(t),
  },
  // "Call me / text me / contact me"
  {
    id: "contact_hint",
    label: "Contact info hint",
    test: (t) => /\b(call\s+me|text\s+me|reach\s+me|contact\s+me|msg\s+me|ping\s+me|hmu|hit\s+me\s+up|reach\s+out\s+to\s+me|nipa\s+(call|ring)|nipigie|nipigie\s+simu)\b/i.test(t),
  },
  // "My number is / my phone is"
  {
    id: "my_number",
    label: "Contact info hint",
    test: (t) => /\b(my\s+(number|namba|num|contact|phone|cell|mobile|email|gmail|nambari|simu))\b/i.test(t),
  },
  // Unicode lookalikes for @
  {
    id: "unicode_at",
    label: "Email address (disguised)",
    test: (t) => /[＠⓪①②③④⑤⑥⑦⑧⑨]/.test(t),
  },
  // Word-based number patterns: "zero seven four three..."  (3+ number words in a row)
  {
    id: "word_numbers",
    label: "Phone number (in words)",
    test: (t) => /\b(zero|one|two|three|four|five|six|seven|eight|nine|sita|saba|nane|tisa|moja|mbili|tatu|tano)[\s,\-]+(zero|one|two|three|four|five|six|seven|eight|nine|sita|saba|nane|tisa|moja|mbili|tatu|tano)[\s,\-]+(zero|one|two|three|four|five|six|seven|eight|nine|sita|saba|nane|tisa|moja|mbili|tatu|tano)/i.test(t),
  },
  // Mixed: digits interspersed with words  e.g. "0.7.4.3.six.3.four.5.eight.1"
  {
    id: "mixed_word_digit",
    label: "Phone number (mixed digits/words)",
    test: (t) => {
      // Replace word numbers with digits then check for 10-digit sequence
      const cleaned = t.toLowerCase()
        .replace(/\bzero\b/g,"0").replace(/\bone\b/g,"1").replace(/\btwo\b/g,"2")
        .replace(/\bthree\b/g,"3").replace(/\bfour\b/g,"4").replace(/\bfive\b/g,"5")
        .replace(/\bsix\b/g,"6").replace(/\bseven\b/g,"7").replace(/\beight\b/g,"8")
        .replace(/\bnine\b/g,"9")
        .replace(/\bsita\b/g,"6").replace(/\bsaba\b/g,"7").replace(/\bnane\b/g,"8")
        .replace(/\btisa\b/g,"9").replace(/\bmoja\b/g,"1").replace(/\bmbili\b/g,"2")
        .replace(/\btatu\b/g,"3").replace(/\btano\b/g,"5");
      // Now check for phone-like patterns with separators
      return /\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d[\s\.\-,]*\d/.test(cleaned);
    },
  },
  // Hex/base64 encoded numbers: common trick
  {
    id: "hex_encode",
    label: "Encoded number",
    test: (t) => /0x[0-9a-fA-F]{8,}/.test(t),
  },
  // Invite-style language: "let's continue outside" / "continue on another platform"
  {
    id: "offsite_invite",
    label: "Attempt to move off-platform",
    test: (t) => /\b(continue\s+(this|our|the)\s+(chat|conversation|talk|discussion)\s+(outside|elsewhere|off|on\s+another)|talk\s+outside|meet\s+outside\s+weka\s*soko|outside\s+this\s+platform|off\s+(this|the)\s+platform)\b/i.test(t),
  },
];

// ── Normalized patterns (applied after full normalization) ────────────────────
const NORM_PATTERNS = [
  // After normalization: word numbers → digits, l33t → digits, separators removed
  // Look for 10+ digit sequences beginning with 07 or 01 or 254
  {
    id: "norm_ke_phone",
    label: "Phone number (normalized)",
    test: (n) => containsKEPhone(n),
  },
  // Email after normalization: only flag if it looks like email@domain.tld after l33t
  // (Raw email detection already handles standard emails via containsEmail)
  // Only catch "word AT word DOT word" converted to digits: 47 = "at" after l33t
  {
    id: "norm_email",
    label: "Email (normalized)",
    test: (n) => {
      // After l33t: a→4, t→7, so "at" → "47"; "dot" → "307"
      // Match: wordChars + "47" + wordChars + "307" + letters  (word@domain.tld)
      // Must be tight pattern to avoid false positives
      return /[a-z0-9]{2,}47[a-z0-9]{2,}(307|\.|0)[a-z]{2,4}$/.test(n) && n.length < 60;
    },
  },
];

// ── Main detection function ───────────────────────────────────────────────────
function detectContactInfo(text) {
  if (!text || typeof text !== "string") return { blocked: false };

  // Test raw text
  for (const p of RAW_PATTERNS) {
    if (p.test(text)) return { blocked: true, reason: p.label, patternId: p.id };
  }

  // Test normalized text
  const norm = normalize(text);
  for (const p of NORM_PATTERNS) {
    if (p.test(norm)) return { blocked: true, reason: p.label, patternId: p.id };
  }

  return { blocked: false };
}

// ── Listing text scan (for ad descriptions, titles, location fields) ──────────
// Less aggressive — only blocks clear phone/email/url, not social refs
const LISTING_PATTERNS = [
  { id: "ke_phone", label: "Kenyan phone number", test: (t) => /0[17]\d[\s\.\-]*\d{7}/.test(t) },
  { id: "intl_phone", label: "International phone", test: (t) => /(\+|00)254[17]\d{8}/.test(t) },
  { id: "email", label: "Email address", test: containsEmail },
  { id: "url", label: "Website link", test: (t) => /https?:\/\/|www\.[a-z0-9]+\.[a-z]{2,}/i.test(t) },
  { id: "whatsapp", label: "WhatsApp number/link", test: (t) => /wa\.me\/|whatsapp\.com/i.test(t) },
  // Mixed word+digit phone (same as above but stricter threshold)
  {
    id: "word_digit_phone", label: "Phone number in listing",
    test: (t) => {
      const cleaned = t.toLowerCase()
        .replace(/\bzero\b/g,"0").replace(/\bone\b/g,"1").replace(/\btwo\b/g,"2")
        .replace(/\bthree\b/g,"3").replace(/\bfour\b/g,"4").replace(/\bfive\b/g,"5")
        .replace(/\bsix\b/g,"6").replace(/\bseven\b/g,"7").replace(/\beight\b/g,"8")
        .replace(/\bnine\b/g,"9");
      return /0[17][\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d/.test(cleaned);
    },
  },
];

function detectListingContactInfo(text) {
  if (!text || typeof text !== "string") return { blocked: false };
  for (const p of LISTING_PATTERNS) {
    if (p.test(text)) return { blocked: true, reason: p.label, patternId: p.id, field: "listing" };
  }
  return { blocked: false };
}

// Scan all text fields of a listing object
function scanListingForContact(listing) {
  const fields = {
    title: listing.title,
    description: listing.description,
    reason_for_sale: listing.reason_for_sale,
    location: listing.location,
  };
  for (const [field, val] of Object.entries(fields)) {
    if (!val) continue;
    const r = detectListingContactInfo(val);
    if (r.blocked) return { ...r, field };
  }
  return { blocked: false };
}

// ── Severity escalation ───────────────────────────────────────────────────────
function getSeverity(violationCount) {
  if (violationCount >= 3) return "suspended";
  if (violationCount >= 2) return "flagged";
  return "warning";
}

module.exports = { detectContactInfo, detectListingContactInfo, scanListingForContact, getSeverity };
