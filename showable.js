'use strict';

/**
 * Showable — text the person approves must show what it is.
 *
 * A draft is approved by being seen (tools/drafts.js, turns.js). Characters
 * that do not show break that: zero-width and format characters, tag
 * characters (which can spell out a whole hidden string after "Thanks!"),
 * variation selectors, other default-ignorable characters (U+034F can carry
 * one bit per letter), private-use and unassigned code points, lone
 * surrogates, line and paragraph separators, Hangul fillers, and control
 * characters other than newline and tab can carry text the person never saw,
 * or make two different texts look the same (reviews 2026-11-21, fifth and
 * sixth pass). vibe_prepare refuses a body, link title or link address that
 * holds any of them. One rule, here.
 *
 * Emoji are not broken by it: U+FE0F is allowed right after an emoji or in a
 * keycap (one of 0-9 # * , U+FE0F, U+20E3: 1️⃣), U+200D only between two
 * emoji (❤️, 👨‍👩‍👧, 👍🏽, 🧑🏽‍💻, 🏳️‍🌈). Regional-indicator flags (🇫🇷) are
 * ordinary characters; flags spelled with tag characters are refused. An
 * unassigned code point that is Extended_Pictographic (a newer emoji than this
 * Node's Unicode data) passes.
 */

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FORMAT = /\p{Cf}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const PRIVATE = /\p{Co}/u;
const SURROGATE = /\p{Cs}/u;
const UNASSIGNED = /\p{Cn}/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const isModifier = (cp) => cp >= 0x1F3FB && cp <= 0x1F3FF;   // skin tones (Emoji_Modifier)
const ch = (cp) => (cp === undefined ? '' : String.fromCodePoint(cp));
const pictographic = (cp) => cp !== undefined && PICTOGRAPHIC.test(ch(cp));

function hiddenAlways(cp) {
  if ((cp < 0x20 && cp !== 0x0A && cp !== 0x09) || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F)) return true;   // controls
  if (cp >= 0xE0000 && cp <= 0xE0FFF) return true;          // tags and the rest of that block
  if (cp >= 0xFE00 && cp <= 0xFE0E) return true;            // variation selectors (FE0F is judged in context)
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;          // variation selectors supplement
  if (cp === 0x2028 || cp === 0x2029) return true;          // line / paragraph separator
  if (cp === 0x3164 || cp === 0x115F || cp === 0x1160 || cp === 0xFFA0) return true;   // Hangul fillers
  const c = ch(cp);
  if (FORMAT.test(c) || IGNORABLE.test(c) || PRIVATE.test(c) || SURROGATE.test(c)) return true;
  if (UNASSIGNED.test(c) && !PICTOGRAPHIC.test(c)) return true;
  return false;
}

/**
 * The first character that does not show, or null:
 * { codePoint: 'U+200C', position: 14 } (position counts characters, from 1).
 */
function firstHidden(text) {
  // Array.from splits by code point and keeps a lone surrogate as its own unit.
  const cps = Array.from(String(text == null ? '' : text), (c) => c.codePointAt(0));
  // Does the emoji element that ends at index i (a pictograph, optionally
  // followed by U+FE0F or a skin-tone modifier) exist?
  const emojiEndsAt = (i) => {
    if (i < 0) return false;
    if (pictographic(cps[i])) return true;
    return (cps[i] === 0xFE0F || isModifier(cps[i])) && i > 0 && pictographic(cps[i - 1]);
  };
  const hit = (i) => ({ codePoint: `U+${cps[i].toString(16).toUpperCase().padStart(4, '0')}`, position: i + 1 });
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0xFE0F) {
      if (i > 0 && pictographic(cps[i - 1])) continue;
      if (i > 0 && KEYCAP_BASE.test(ch(cps[i - 1])) && cps[i + 1] === 0x20E3) continue;
      return hit(i);
    }
    if (cp === 0x200D) {
      if (emojiEndsAt(i - 1) && pictographic(cps[i + 1])) continue;
      return hit(i);
    }
    if (hiddenAlways(cp)) return hit(i);
  }
  return null;
}

/** True when the text holds a character that does not show. */
function hasHiddenCharacters(text) { return firstHidden(text) !== null; }

module.exports = { hasHiddenCharacters, firstHidden };
