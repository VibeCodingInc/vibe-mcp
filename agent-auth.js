/**
 * An agent on /vibe as itself.
 *
 * Everything else in this package signs a PERSON in, through GitHub in a
 * browser. An agent that did that would be a person as far as /vibe knows, and
 * every rule that tells people from agents would be lying about it. This is the
 * other way in: the agent's own credential, issued for its own handle by the
 * people who run /vibe, exchanged for a session that says what it is.
 *
 * How it is configured (in the env of the agent's vibe server, never in a tool):
 *
 *   VIBE_AGENT_HANDLE      the agent's handle
 *   VIBE_AGENT_MINT_FILE   a file holding its credential (preferred), or
 *   VIBE_AGENT_MINT        the credential itself
 *   VIBE_HOME              the agent's OWN identity directory (required)
 *
 * The rules, in code:
 *   - The credential is read once, kept in this module, and removed from the
 *     process environment, so no child process, hook or tool inherits it. It is
 *     sent only as the `x-agent-mint` header to this service's own endpoints.
 *     Nothing here returns it, prints it, or writes it to disk.
 *   - An agent identity needs its own VIBE_HOME. Without one it would overwrite
 *     the identity of whoever owns the machine's default directory.
 *   - The session is the one the service minted for THIS handle; a token for
 *     any other handle is discarded.
 *   - A session is reused until it is close to expiring. The service allows few
 *     mints per hour, and an agent that re-minted on every start would lock
 *     itself out.
 *
 * Naming the operator ("an agent run by @x") is a different act by a different
 * party: the person who runs the agent, signed in as themselves, co-presenting
 * this same credential. See `operate` in cli.js.
 */

'use strict';

const fs = require('fs');
const { isIsolated } = require('./vibe-home');

const HANDLE = /^[a-z0-9][a-z0-9_-]{1,38}$/;
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;   // re-mint when under three days remain
const TIMEOUT_MS = 8000;

const norm = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();

// ── the credential: read once, then out of the environment ──────────────────

let _secret = null;
let _secretProblem = null;
let _captured = false;

function capture(env = process.env) {
  if (_captured) return;
  _captured = true;
  const file = env.VIBE_AGENT_MINT_FILE;
  let raw = env.VIBE_AGENT_MINT || '';
  if (!raw && file) {
    try { raw = fs.readFileSync(file, 'utf8'); } catch { _secretProblem = 'the credential file could not be read'; }
  }
  raw = String(raw).trim();
  if (raw && (/\s/.test(raw) || raw.length < 16 || raw.length > 512)) {
    _secretProblem = 'the credential does not look like one (it must be one line, 16 to 512 characters)';
    raw = '';
  }
  _secret = raw || null;
  // Nothing spawned from here on can read it from the environment.
  delete env.VIBE_AGENT_MINT;
}

/** Any text that might carry the credential, made safe to show. */
function scrub(text) {
  capture();
  const s = String(text == null ? '' : text);
  return _secret ? s.split(_secret).join('[agent credential]') : s;
}

/** The agent this process is configured to be, or null. Never includes the credential. */
function configured(env = process.env) {
  capture(env);
  const handle = norm(env.VIBE_AGENT_HANDLE);
  if (!handle) return null;
  let problem = null;
  if (!HANDLE.test(handle)) problem = 'VIBE_AGENT_HANDLE is not a handle';
  else if (!_secret) problem = _secretProblem || 'no credential: set VIBE_AGENT_MINT_FILE to a file that holds it';
  else if (!isIsolated(env)) problem = 'an agent needs its own identity directory: set VIBE_HOME for it (it must not share a person\'s)';
  return { handle, problem };
}

const isAgent = (env = process.env) => Boolean(configured(env));

/** The credential, for the one other caller that co-presents it (`operate`). Not exported to tools. */
function credentialForOperator(env = process.env) {
  capture(env);
  return _secret;
}

// ── the session ─────────────────────────────────────────────────────────────

function claimsOf(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; }
}

/** Is the stored session this agent's own, minted as an agent, with time left? */
function sessionState(handle) {
  const authStore = require('./auth-store');
  const token = authStore.getToken();
  if (!token) return { usable: false, why: 'none' };
  const seen = authStore.inspectToken(token);
  const claims = claimsOf(token);
  if (!seen.ok) return { usable: false, why: seen.reason };
  if (norm(seen.handle) !== handle) return { usable: false, why: 'other_identity' };
  if (claims.mint !== 'agent') return { usable: false, why: 'not_an_agent_session' };
  if (seen.expiresAt && seen.expiresAt - Date.now() < RENEW_BEFORE_MS) return { usable: false, why: 'expiring', expiresAt: seen.expiresAt };
  return { usable: true, expiresAt: seen.expiresAt || null };
}

const REFUSALS = {
  403: 'The service refused this agent\'s credential. Either it is not the credential for this handle, or the handle has not been set up as an agent. Ask whoever runs /vibe.',
  429: 'Too many sign-in attempts for this agent in the last hour. It will work again later; the saved session is reused until then.',
  503: 'The service could not establish this agent\'s identity right now. If this handle already belongs to a person, it cannot also be an agent.',
};

let _inFlight = null;

/**
 * Make sure this process holds the agent's own session. Resolves to
 * { ok, handle, expiresAt?, minted?, message? }. Never throws, never prompts,
 * never opens a browser.
 */
function ensureSession({ force = false, env = process.env, fetchImpl = fetch } = {}) {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const me = configured(env);
    if (!me) return { ok: false, handle: null, message: 'This process is not configured as an agent.' };
    if (me.problem) return { ok: false, handle: me.handle, message: `@${me.handle} cannot sign in: ${me.problem}.` };

    const authStore = require('./auth-store');
    const config = require('./config');
    authStore.hydrate();

    const now = sessionState(me.handle);
    if (now.usable && !force) return { ok: true, handle: me.handle, expiresAt: now.expiresAt, minted: false };
    // Someone else's sign-in lives in this directory. It is not used, and it is
    // not removed either: it may be a person's, and it is theirs. The agent
    // needs a directory of its own.
    if (now.why === 'other_identity') {
      return { ok: false, handle: me.handle, message: `This identity directory already holds another sign-in (@${norm(authStore.getHandle() || '') || 'someone'}). An agent needs a VIBE_HOME of its own; nothing here was changed.` };
    }

    const base = String(config.getApiUrl()).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let status; let body = null;
    try {
      const response = await fetchImpl(`${base}/api/auth/buddy-token`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-agent-mint': _secret },
        body: JSON.stringify({ handle: me.handle }),
      });
      status = response.status;
      body = await response.json().catch(() => null);
    } catch {
      // Offline with a session that still works is fine; say so rather than fail.
      if (now.why === 'expiring') return { ok: true, handle: me.handle, expiresAt: now.expiresAt, minted: false, message: 'Could not reach /vibe to renew; the current session is still good.' };
      return { ok: false, handle: me.handle, message: 'Could not reach /vibe to sign this agent in. It will try again on the next start.' };
    } finally {
      clearTimeout(timer);
    }

    const token = body && body.success === true && typeof body.token === 'string' ? body.token : null;
    if (status !== 200 || !token) {
      if (now.why === 'expiring') return { ok: true, handle: me.handle, expiresAt: now.expiresAt, minted: false, message: REFUSALS[status] || 'The session could not be renewed.' };
      return { ok: false, handle: me.handle, message: REFUSALS[status] || 'The service did not sign this agent in.' };
    }
    // The session must be for THIS handle, and say it is an agent's.
    const seen = authStore.inspectToken(token);
    if (!seen.ok || norm(seen.handle) !== me.handle || claimsOf(token).mint !== 'agent') {
      return { ok: false, handle: me.handle, message: 'The service answered with a session that is not this agent\'s. It was not used.' };
    }

    try { await require('./actor-session').clearActorSession(); } catch {}
    config.saveAuthToken(token);
    config.setSessionIdentity(me.handle, config.getOneLiner() || '');
    authStore.setToken(token);
    authStore.setHandle(me.handle);
    const saved = config.load();
    saved.handle = me.handle;
    saved.authMethod = 'agent';
    saved.pendingAuth = false;
    config.save(saved);
    global.vibeNotifier?.emitImmediate();
    return { ok: true, handle: me.handle, expiresAt: seen.expiresAt || null, minted: true };
  })().finally(() => { _inFlight = null; });
  return _inFlight;
}

/** Who the service says this handle is: { kind, operator } or null when it cannot be read. */
async function publicIdentity(handle, { fetchImpl = fetch } = {}) {
  const config = require('./config');
  const base = String(config.getApiUrl()).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${base}/api/identity/${encodeURIComponent(norm(handle))}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return r.status === 404 ? { missing: true } : null;
    const who = await r.json().catch(() => null);
    if (!who || norm(who.handle) !== norm(handle)) return null;
    const operator = typeof who.operator === 'string' && HANDLE.test(norm(who.operator)) ? norm(who.operator)
      : (who.operator && typeof who.operator === 'object' && HANDLE.test(norm(who.operator.handle)) ? norm(who.operator.handle) : null);
    return { kind: ['agent', 'human'].includes(who.kind) ? who.kind : 'other', operator };
  } catch { return null; } finally { clearTimeout(timer); }
}

module.exports = {
  configured, isAgent, ensureSession, sessionState, publicIdentity, scrub, credentialForOperator, norm, HANDLE,
  _resetForTest: () => { _secret = null; _secretProblem = null; _captured = false; _inFlight = null; },
};
