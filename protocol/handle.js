/**
 * handle — the ONE canonical form of a /vibe handle.
 *
 * This exists because the same defect has landed three times now: a padded/cased handle
 * normalized differently in different layers, so a self-DM passed the self-check AND
 * delivered. The most recent instance is instructive — `normalizeHandle` in
 * tools/_shared.js stripped a leading `@` BEFORE trimming, so " @alice " became "@alice"
 * (the leading space defeated the ^@ match), which then failed to equal "alice" and let a
 * padded self-target through. Order of operations, not intent. (Fixed: it trims first
 * now, and tools/deliver.js uses canonicalHandle for the recipient and the self-check.)
 *
 * Rules, matching api/lib/handles.js so the platform and the protocol agree:
 *   strip zero-width characters → NFC normalize → trim → strip leading @s → trim again
 *   → lowercase. The dash is KEPT: a handle is a GitHub login and logins may contain
 *   '-'. The platform's handles.js folds '-' to '_' when it first assigns a handle, so
 *   'a-b' and 'a_b' can name the same account there; this form does not merge them
 *   (see the note in canonicalHandle).
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

/**
 * The recipient exactly as the platform STORES it (message-service
 * storedRecipientHandle: lowercase, leading @ stripped, hyphens KEPT). The
 * #392 approval digest is computed over this form; it must agree byte-for-byte
 * with the server's, so it is deliberately not canonicalHandle().
 */
function storedRecipientHandle(value) {
  return String(value || '').toLowerCase().replace(/^@/, '');
}

/** Canonical comparison/storage form, or '' when there isn't one. */
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
