/**
 * handle — the ONE canonical form of a /vibe handle.
 *
 * This exists because the same defect has landed three times now: a padded/cased handle
 * normalized differently in different layers, so a self-DM passed the self-check AND
 * delivered. The most recent instance is instructive — `normalizeHandle` in
 * tools/_shared.js strips a leading `@` BEFORE trimming, so " @alice " becomes "@alice"
 * (the leading space defeats the ^@ match), which then fails to equal "alice" and lets a
 * padded self-target through. Order of operations, not intent.
 *
 * Rules, matching api/lib/handles.js so the platform and the protocol agree:
 *   strip zero-width characters → NFC normalize → trim → strip leading @s → trim again
 *   → lowercase → map '-' to '_' (the platform treats them as the same handle).
 *
 * NOT done: unicode folding of letters. Platform handles are ASCII [a-z0-9_], so a
 * non-ASCII handle is INVALID rather than something to fold — folding lookalikes would
 * silently merge two distinct people. Use isCanonicalHandle() to reject at the boundary.
 *
 * Imported by mcp-server (stdio) and api/ (hosted); api/mcp.js already imports from
 * mcp-server/, so the direction is established.
 */

'use strict';

// Zero-width and bidi controls: invisible padding that makes two handles look identical.
const INVISIBLE = /[​-‍⁠﻿؜‎‏‪-‮⁦-⁩]/g;

/** Canonical comparison/storage form, or '' when there isn't one. */
/**
 * The recipient exactly as the platform STORES it (message-service
 * storedRecipientHandle: lowercase, leading @ stripped, hyphens KEPT). The
 * #392 approval digest is computed over this form; it must agree byte-for-byte
 * with the server's, so it is deliberately not canonicalHandle().
 */
function storedRecipientHandle(value) {
  return String(value || '').toLowerCase().replace(/^@/, '');
}

function canonicalHandle(value) {
  if (typeof value !== 'string') return '';
  let h = value.replace(INVISIBLE, '');
  h = h.normalize ? h.normalize('NFC') : h;
  // A handle is the GitHub login, and GitHub logins may contain '-'. Rewriting
  // dashes to underscores made `vibe inbox synth-stan` look up synth_stan and
  // render an empty thread (found live 2026-09-02). Keep the dash.
  return h.trim().replace(/^@+/, '').trim().toLowerCase();
}

/** Platform-legal shape: ASCII letters, digits, underscore, dash (GitHub logins). Reject anything else. */
const isCanonicalHandle = (value) => /^[a-z0-9_-]{1,39}$/.test(canonicalHandle(value));

/** True when two handles refer to the same principal label. */
const sameHandle = (a, b) => {
  const x = canonicalHandle(a);
  return !!x && x === canonicalHandle(b);
};

module.exports = { canonicalHandle, isCanonicalHandle, sameHandle, storedRecipientHandle };
