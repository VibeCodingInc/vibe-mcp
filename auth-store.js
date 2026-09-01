/**
 * Auth Store - In-memory singleton for authentication state
 *
 * This is the SOURCE OF TRUTH for auth during MCP runtime.
 * File persistence (config.json) is only for durability across restarts.
 *
 * Why this exists:
 * - OAuth callback and API calls happen in the same MCP process
 * - File-based auth was unreliable due to per-PID session files and caching
 * - In-memory state is immediate and deterministic
 *
 * Usage:
 * - Startup: authStore.hydrate() loads from disk once
 * - OAuth: authStore.setToken(token) updates immediately
 * - API calls: authStore.getToken() returns current token (no file I/O)
 */

// In-memory state - the single source of truth during runtime
let _token = null;
let _handle = null;
let _oneLiner = null;
let _hydrated = false;
// Has the SERVER confirmed this credential in this process? A token read off disk is
// a claim; only a verify round-trip makes it a fact. Kept separate from _token so
// callers can distinguish "saved" from "authenticated" — announcing presence or
// unlocking a tool on the strength of a filename is how a green dot comes to mean
// nothing (issues #107, #110).
let _verified = false;
// We held a credential and could not tell whose it was. Distinct from "no credential":
// signed out is an honest state, but a rejected token means the name on disk is not
// backed by anything, and nothing may present it as the current identity (#107/#110).
let _rejected = false;

/**
 * Hydrate auth state from disk (call once at MCP startup)
 * This loads persisted state from config.json
 */
/**
 * The handle a token was ISSUED FOR, read from its own subject claim.
 *
 * Decode, not verify — the signature is the server's business and it checks it on
 * every call. What this answers is narrower and local: "whose credential is this?"
 * Returns null for anything unparseable, so a malformed token can never masquerade.
 */
function handleFromToken(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const who = claims.handle || claims.sub;
    return typeof who === 'string' && who ? who : null;
  } catch {
    return null;
  }
}

/**
 * The principal a token PROVES, from its own claim — or null for the legacy
 * handle-only shape. Decode, not verify (same posture as handleFromToken):
 * the server checks the signature on every call; this answers the narrower
 * local question "does this credential carry principal authority at all?"
 * A handle is a mutable label; only the principal claim is authority (#300).
 */
function principalFromToken(token) {
  // Only a well-formed JWT answers this question. Reading segment [1] out of
  // whatever String() produced accepted `h.<payload>`, `.<payload>.sig`,
  // `h.<payload>.sig.extra` and an object whose toString() returned a token —
  // every one of them then reported principal authority it had not proven.
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  // base64url alphabet only: Buffer.from is lenient and silently skips the
  // characters that would tell us this is not a token at all.
  // ALL THREE segments must be base64url — a signature of `!!!` is not a
  // signature, and validating only the payload let malformed tokens through.
  // Alphabet AND length: a single base64url character cannot encode anything
  // (a length of 4n+1 is an impossible remainder), so 'A' and '_' are not
  // signatures even though every character in them is legal.
  // Alphabet, length, AND canonical form. A segment whose trailing pad bits are
  // non-zero decodes without complaint but is not the encoding it claims to be;
  // round-tripping is the only check that catches it.
  const b64url = (seg) => {
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) return false;
    if (seg.length < 2 || seg.length % 4 === 1) return false;
    try {
      return Buffer.from(seg, 'base64url').toString('base64url') === seg;
    } catch {
      return false;
    }
  };
  if (!b64url(header) || !b64url(payload) || !b64url(signature)) return null;
  try {
    // The header must decode to a JSON object too. `A` is not a possible
    // base64url encoding of anything, and a non-JSON header means this is not
    // a token whose payload we should be reading claims out of.
    const rawHeader = Buffer.from(header, 'base64url').toString('utf8');
    const head = JSON.parse(rawHeader);
    if (!head || typeof head !== 'object' || Array.isArray(head)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    const pid = Object.prototype.hasOwnProperty.call(claims, 'principal_id')
      ? claims.principal_id : null;
    return typeof pid === 'string' && pid ? pid : null;
  } catch {
    return null;
  }
}

function hydrate() {
  if (_hydrated) return; // Only hydrate once

  try {
    const config = require('./config');
    const cfg = config.load();

    _oneLiner = cfg.one_liner || cfg.workingOn || null;

    // ONE IDENTITY, ONE AUTHORITY — and the authority is whichever credential still WORKS.
    //
    // This used to take cfg.authToken unconditionally and only look at auth.json when
    // config.json had no token at all. So a machine holding a DEAD token in config.json
    // and a LIVE one in auth.json hydrated with the dead one and reported
    // isAuthenticated() === true. Reproduced before this change:
    //
    //     hydrate chose: expired | isAuthenticated(): true
    //
    // Presence order is unchanged — config.json still wins when it is usable. What
    // changed is that "present" is no longer mistaken for "usable". Falling back only on
    // ABSENCE means the freshest credential loses to the first one on disk, which is
    // precisely the "several credentials for one identity" failure canon law 3 exists to
    // prevent (§4). With 30-day logins every machine eventually holds a stale one, so
    // this is a matter of when, not whether.
    //
    // Deliberately local: inspectToken decodes `exp` rather than asking the server,
    // because hydrate runs at boot where the network may be the broken thing. It cannot
    // prove a token is GOOD — only the server can, and markVerified() records that later.
    // It reliably rejects one that is definitively over.
    const candidates = [
      cfg.authToken,
      cfg.privyToken,
      config.loadTerminalAuth()?.token,
    ].filter(Boolean);

    _token = candidates.find((t) => inspectToken(t).ok) || null;

    if (!_token && candidates.length > 0) {
      // Every credential we hold is unusable. That is signed OUT, not signed in as the
      // least-bad option — and it must be distinguishable from having none at all, so a
      // remembered handle does not step in to name a session nothing backs (#110).
      const why = inspectToken(candidates[0]).reason;
      console.error(`[auth-store] No usable credential (${candidates.length} found, first is ${why})`);
      _rejected = true;
    }

    // THE TOKEN IS THE IDENTITY.
    //
    // The handle used to be read from config.json independently of the token, so the
    // two could name different people and nothing noticed: the client displayed
    // @brightseth, the server saw @vibetester1, and a DM went out as the wrong
    // principal while reporting success. (Found by the first terminal-to-terminal
    // test, issue #107 — a self-send recorded in the database.)
    //
    // A stored handle is a label someone wrote down; the token is what the server
    // acts on. When they disagree, the file is wrong — never the credential.
    const stored = cfg.handle || cfg.username || null;
    _handle = _token ? handleFromToken(_token) : null;

    if (_token && !_handle) {
      // A token we cannot attribute is one we must not act under.
      console.error('[auth-store] Token carries no identity — treating as signed out');
      _token = null;
      _rejected = true;
    } else if (_token && stored && stored !== _handle) {
      console.error(
        `[auth-store] Stored handle @${stored} does not own this session — acting as @${_handle}`
      );
    }

    _hydrated = true;

    if (_token) {
      console.error('[auth-store] Hydrated: @' + _handle);
    } else {
      console.error('[auth-store] Hydrated: no token');
    }
  } catch (e) {
    console.error('[auth-store] Hydration failed:', e.message);
  }
}

/**
 * Set auth token (call after OAuth completes)
 * @param {string} token - JWT token
 */
function setToken(token, { verified = false } = {}) {
  if (token) {
    const who = handleFromToken(token);
    if (!who) {
      // Same rule hydrate() applies, applied here too — a credential we cannot
      // attribute must not become the session.
      console.error('[auth-store] Refusing a token with no identity');
      _token = null; _handle = null; _verified = false; _rejected = true;
      return;
    }
  }

  const hadToken = !!_token;
  _rejected = false;
  _token = token;
  _verified = !!token && verified;

  // Identity travels WITH the credential (see hydrate). A new token can belong to a
  // different person — after a re-auth, an account switch, or a cross-client sync —
  // so the handle is re-derived here rather than left pointing at the previous one.
  if (token) {
    const who = handleFromToken(token);
    if (who && who !== _handle) {
      if (_handle) console.error(`[auth-store] Now acting as @${who} (was @${_handle})`);
      _handle = who;
    }
  }

  if (!hadToken && token) {
    console.error('[auth-store] Token set (was empty)');
  } else if (hadToken && token && token !== _token) {
    console.error('[auth-store] Token updated');
  }
}

/**
 * Get current auth token
 * @returns {string|null} Current token or null
 */
function getToken() {
  return _token;
}

/**
 * Set user handle
 * @param {string} handle - User handle (without @)
 */
function setHandle(handle) {
  // A handle may be REMEMBERED, never asserted over a credential.
  //
  // `vibe_init` called this immediately after setToken(), passing the callback's separate
  // `handle` field — so the identity derived from the token was overwritten by a value
  // that merely travelled alongside it. When they agree nothing happens; when they
  // disagree the client acts as one principal and displays another, which is issue #107
  // recreated at the exact moment a new person signs in.
  //
  // tests/identity-binding.test.js did not catch it: it asserts setToken() AFTER
  // setHandle(), where the token re-anchors. The real order is the reverse.
  if (_token) {
    const owner = handleFromToken(_token);
    if (owner && handle && handle !== owner) {
      console.error(
        `[auth-store] Ignoring handle @${handle} — this credential belongs to @${owner}`
      );
      return;
    }
  }
  _handle = handle;
}

/**
 * Get current handle
 * @returns {string|null} Current handle or null
 */
function getHandle() {
  return _handle;
}

/**
 * Did we hold a credential we could not attribute?
 *
 * "Signed out" and "signed in as nobody" look identical from `getHandle()` — both null.
 * They are not the same fact, and callers that fall back to a remembered name need to
 * tell them apart: with no credential the name on disk is the best we have, but with a
 * REJECTED one it is a name nothing supports (#110).
 *
 * @returns {boolean}
 */
function hasRejectedCredential() {
  return _rejected;
}

/**
 * Is a stored credential actually usable right now?
 *
 * "A token exists" and "you are signed in" are different facts, and conflating them is
 * how `npx slashvibe-mcp` came to answer "/vibe is configured" on a machine holding a
 * credential that had expired 23 days earlier — then advise restarting the coding agent,
 * which cannot help. The file existed, so the check passed.
 *
 * Local and cheap: decodes `exp` rather than asking the server, because this runs on the
 * recovery path where the network may be the thing that is wrong. It cannot prove a token
 * is GOOD — only the server can — but it reliably catches the case that actually stranded
 * someone, which is a credential that is definitively over.
 *
 * @returns {{ ok: boolean, reason: 'none'|'unattributable'|'expired'|'usable', handle: string|null, expiresAt: number|null }}
 */
function inspectToken(token) {
  if (!token) return { ok: false, reason: 'none', handle: null, expiresAt: null };
  const who = handleFromToken(token);
  if (!who) return { ok: false, reason: 'unattributable', handle: null, expiresAt: null };
  let exp = null;
  try {
    const part = String(token).split('.')[1];
    exp = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).exp ?? null;
  } catch { exp = null; }
  // No exp claim is not a failure — legacy tokens carry none, and refusing them here
  // would sign people out to fix a display bug.
  if (exp && exp * 1000 <= Date.now()) {
    return { ok: false, reason: 'expired', handle: who, expiresAt: exp * 1000 };
  }
  return { ok: true, reason: 'usable', handle: who, expiresAt: exp ? exp * 1000 : null };
}

/**
 * Set one-liner (what user is building)
 * @param {string} oneLiner - One-liner description
 */
function setOneLiner(oneLiner) {
  _oneLiner = oneLiner;
}

/**
 * Get current one-liner
 * @returns {string|null} Current one-liner or null
 */
function getOneLiner() {
  return _oneLiner;
}

/**
 * Check if user is authenticated
 * @returns {boolean} True if token exists
 */
function isAuthenticated() {
  return !!_token;
}

/** The server confirmed this credential in this process. */
function isVerified() {
  return !!_token && _verified;
}

/** Record a successful server verification for the token we already hold. */
function markVerified(handle) {
  if (!_token) return;
  if (handle && handle !== _handle) {
    console.error(`[auth-store] Server says this session is @${handle} (held @${_handle})`);
    _handle = handle;
  }
  _verified = true;
}

/**
 * Clear all auth state (for logout/reset)
 */
function clear() {
  _token = null;
  _handle = null;
  _oneLiner = null;
  _verified = false;
  _rejected = false;
  // Clearing must also forget that we ever loaded, or `hydrate()` returns early forever
  // and the store stays empty while disk holds a perfectly good credential. Everything
  // that reads identity then falls through to the file — which is issue #107 reappearing
  // by a different route, and silently, since the file usually names the right person.
  //
  // NOTE for whoever wires logout to this: clearing memory is not signing out. Disk is
  // re-read on the next question, so a logout must also remove the credential from
  // config.json — otherwise the session comes straight back.
  _hydrated = false;
  console.error('[auth-store] Cleared');
}

/**
 * Get full auth state (for debugging)
 * @returns {object} Current auth state
 */
function getState() {
  return {
    token: _token ? _token.substring(0, 20) + '...' : null,
    handle: _handle,
    oneLiner: _oneLiner,
    hydrated: _hydrated,
    isAuthenticated: !!_token
  };
}

module.exports = {
  hydrate,
  setToken,
  getToken,
  setHandle,
  getHandle,
  hasRejectedCredential,
  inspectToken,
  principalFromToken,
  setOneLiner,
  getOneLiner,
  isAuthenticated,
  clear,
  getState,
  isVerified,
  markVerified,
};
