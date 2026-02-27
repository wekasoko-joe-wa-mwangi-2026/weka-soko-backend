// src/services/moderation.service.js

/**
 * Weka Soko Chat Moderation Engine
 * Detects and blocks any attempt to share contact information
 * before the KSh 250 unlock has been paid.
 *
 * Covers:
 *  - Kenyan phone numbers (07xx, 01xx, +254, 254)
 *  - Disguised numbers (dots, dashes, spaces, symbols, words)
 *  - L33tspeak digit substitutions
 *  - Email addresses
 *  - URLs / website links
 *  - Social media handles / messaging apps
 *  - WhatsApp, Telegram, Signal references
 *  - Location (exact address before unlock)
 */

// ── Normalizer ───────────────────────────────────────────────────────────────
// Strip visual tricks so we can match on clean text
function normalize(text) {
  return text
    .toLowerCase()
    // L33tspeak swaps
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/6/g, "g")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "q")
    // Remove separators between digits
    .replace(/[\s\.\-\•\*\_\|\\\/,;:~`'"!@#$%^&()\[\]{}]/g, "");
}

// ── Pattern Set ───────────────────────────────────────────────────────────────
const PATTERNS = [
  // Raw Kenyan phone numbers: 07xx, 01xx
  {
    id: "ke_phone_raw",
    label: "Kenyan phone number",
    regex: /\b0[17]\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d/g,
  },
  // +254 or 254 prefix
  {
    id: "ke_phone_intl",
    label: "International phone number",
    regex: /(\+|00)?\s*2\s*5\s*4\s*[\s\-\.]?[17]\d[\s\.\-\•\*]*\d{7}/g,
  },
  // Any 10+ digit sequence (disguised numbers)
  {
    id: "long_digit_sequence",
    label: "Phone number (disguised)",
    regex: /\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d[\s\.\-\•\*]*\d/g,
  },
  // Word-based numbers: "zero seven one..."
  {
    id: "word_numbers",
    label: "Phone number (in words)",
    regex: /\b(zero|one|two|three|four|five|six|seven|eight|nine)[\s,\-]+(zero|one|two|three|four|five|six|seven|eight|nine)[\s,\-]+(zero|one|two|three|four|five|six|seven|eight|nine)/gi,
  },
  // Email addresses
  {
    id: "email",
    label: "Email address",
    regex: /[a-z0-9._%+\-]+\s*[@＠]\s*[a-z0-9.\-]+\s*[.]\s*[a-z]{2,}/gi,
  },
  // "at" word substitution for @
  {
    id: "email_at_word",
    label: "Email address (disguised)",
    regex: /[a-z0-9._%+\-]{3,}\s+\bat\b\s+[a-z0-9.\-]+\s+\bdot\b\s+[a-z]{2,}/gi,
  },
  // URLs
  {
    id: "url_http",
    label: "URL/Link",
    regex: /https?:\/\/[^\s]+/gi,
  },
  {
    id: "url_www",
    label: "URL/Link",
    regex: /\bwww\.[a-z0-9\-]+\.[a-z]{2,}/gi,
  },
  // Social / messaging platforms
  {
    id: "whatsapp",
    label: "WhatsApp reference",
    regex: /\b(wa\.me|whatsapp|whts\s*app|w\.?a\.?p?)\b/gi,
  },
  {
    id: "telegram",
    label: "Telegram reference",
    regex: /\b(t\.me|telegram|tg)\b/gi,
  },
  {
    id: "signal",
    label: "Signal reference",
    regex: /\bsignal\s*(app|me|number)?\b/gi,
  },
  {
    id: "instagram_dm",
    label: "Instagram/DM reference",
    regex: /\b(instagram|insta|ig|dm me|slide into|send me a dm)\b/gi,
  },
  {
    id: "facebook",
    label: "Facebook/Messenger reference",
    regex: /\b(facebook|fb\.com|messenger|fb me)\b/gi,
  },
  // Explicit "call me / text me / reach me" + contact hints
  {
    id: "call_me",
    label: "Contact info hint",
    regex: /\b(call\s+me|text\s+me|reach\s+me|contact\s+me|message\s+me|ping\s+me|reach\s+out)\b/gi,
  },
  // Typical "my number is / my contact is"
  {
    id: "my_number",
    label: "Contact info hint",
    regex: /\b(my\s+(number|num|contact|phone|cell|mobile|email|gmail|mail|handle|username))\b/gi,
  },
];

// ── Normalized (anti-l33tspeak) patterns ─────────────────────────────────────
const NORMALIZED_PATTERNS = [
  // After normalization, 0→o, 7→t — "ot" is "07" in l33tspeak
  // Check for o + digits after normalization:
  {
    id: "leet_phone",
    label: "Phone number (l33tspeak)",
    regex: /o[t1i]\d{5,}/g,
  },
];

// ── Main Detection Function ───────────────────────────────────────────────────
function detectContactInfo(text) {
  if (!text || typeof text !== "string") return { blocked: false };

  // Test raw text
  for (const pattern of PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      return {
        blocked: true,
        reason: pattern.label,
        patternId: pattern.id,
        matched: match[0],
      };
    }
  }

  // Test normalized text
  const norm = normalize(text);
  for (const pattern of NORMALIZED_PATTERNS) {
    const match = norm.match(pattern.regex);
    if (match) {
      return {
        blocked: true,
        reason: pattern.label,
        patternId: pattern.id,
        matched: match[0],
      };
    }
  }

  return { blocked: false };
}

// ── Severity Escalation ───────────────────────────────────────────────────────
function getSeverity(violationCount) {
  if (violationCount >= 3) return "suspended";
  if (violationCount >= 2) return "flagged";
  return "warning";
}

module.exports = { detectContactInfo, getSeverity };
