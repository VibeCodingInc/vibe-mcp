'use strict';

/**
 * Showable — text the person approves must show what it is.
 *
 * A draft is approved by being seen (tools/drafts.js, turns.js). Characters
 * that do not show break that: zero-width and format characters, tag
 * characters (which can spell out a whole hidden string after "Thanks!"),
 * variation selectors, line and paragraph separators, Hangul fillers, and
 * control characters other than newline and tab can carry text the person
 * never saw, or make two different texts look the same (review 2026-11-21,
 * fifth pass). vibe_prepare refuses a body, link title or link address that
 * holds any of them. One rule, here.
 *
 * Emoji are not broken by it: U+FE0F (emoji presentation) is allowed right
 * after an emoji, and U+200D (zero-width joiner) only between two emoji, so
 * ❤️, 👨‍👩‍👧, 👍🏽, 🧑🏽‍💻 and 🏳️‍🌈 pass, and U+FE0F is allowed in a keycap
 * (one of 0-9 # * , U+FE0F, U+20E3: 1️⃣) and nowhere else. Flags made of regional indicators
 * (🇫🇷) pass; subdivision flags spelled with tag characters do not.
 */

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FORMAT = /\p{Cf}/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const isModifier = (cp) => cp >= 0x1F3FB && cp <= 0x1F3FF;   // skin tones (Emoji_Modifier)

function hiddenAlways(cp) {
  if ((cp < 0x20 && cp !== 0x0A && cp !== 0x09) || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F)) return true;   // controls
  if (cp >= 0xE0000 && cp <= 0xE0FFF) return true;          // tags and the rest of that plane block
  if (cp >= 0xFE00 && cp <= 0xFE0E) return true;            // variation selectors (FE0F is judged in context)
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;          // variation selectors supplement
  if (cp === 0x2028 || cp === 0x2029) return true;          // line / paragraph separator
  if (cp === 0x3164 || cp === 0x115F || cp === 0x1160 || cp === 0xFFA0) return true;   // Hangul fillers
  return false;
}

/** True when the text holds a character that does not show. */
function hasHiddenCharacters(text) {
  const cps = Array.from(String(text == null ? '' : text), (c) => c.codePointAt(0));
  // Does the emoji element that ends at index i (a pictograph, optionally
  // followed by U+FE0F or a skin-tone modifier) exist?
  const emojiEndsAt = (i) => {
    if (i < 0) return false;
    const cp = cps[i];
    if (PICTOGRAPHIC.test(String.fromCodePoint(cp))) return true;
    if ((cp === 0xFE0F || isModifier(cp)) && i > 0) return PICTOGRAPHIC.test(String.fromCodePoint(cps[i - 1]));
    return false;
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0xFE0F) {
      if (i > 0 && PICTOGRAPHIC.test(String.fromCodePoint(cps[i - 1]))) continue;
      // Keycap: exactly one of 0-9 # * , then U+FE0F, then U+20E3 (1️⃣ 2️⃣).
      if (i > 0 && KEYCAP_BASE.test(String.fromCodePoint(cps[i - 1])) && cps[i + 1] === 0x20E3) continue;
      return true;
    }
    if (cp === 0x200D) {
      const next = i + 1 < cps.length ? String.fromCodePoint(cps[i + 1]) : '';
      if (emojiEndsAt(i - 1) && next && PICTOGRAPHIC.test(next)) continue;
      return true;
    }
    if (hiddenAlways(cp)) return true;
    if (FORMAT.test(String.fromCodePoint(cp))) return true;   // zero-width, bidi, soft hyphen, BOM, ...
  }
  return false;
}

module.exports = { hasHiddenCharacters };
