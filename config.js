/**
 * Config — User identity and paths
 *
 * Canonical location: ~/.vibe/config.json
 * Falls back to ~/.vibecodings/config.json for backward compat
 */

const fs = require('fs');
const path = require('path');

// Identity is normally HOME-locked to ~/.vibe. VIBE_HOME overrides the base dir
// so a SECOND session on the same machine can be a DIFFERENT being — required to
// run the live weave (a fable needs two distinct beings). Set it to an isolated
// dir and `vibe init` there mints/loads a separate identity, e.g.
//   VIBE_HOME=~/.vibe-b claude   (that session signs in as being B)
// Unset → identical behavior to before (base = ~/.vibe). Set-but-empty → throws
// (vibe-home.js): guessing would silently merge two identities.
const { vibeHome, isIsolated } = require('./vibe-home');
const VIBE_DIR = vibeHome();
const VIBECODINGS_DIR = path.join(process.env.HOME, '.vibecodings');
const PRIMARY_CONFIG = path.join(VIBE_DIR, 'config.json');          // Primary
const FALLBACK_CONFIG = path.join(VIBECODINGS_DIR, 'config.json');  // Fallback
const TERMINAL_AUTH_FILE = path.join(VIBE_DIR, 'auth.json');        // Cross-client (Buddy/Terminal)
const CONFIG_FILE = PRIMARY_CONFIG;

function ensureDir() {
  // 0700 is ENFORCED, not requested: mkdir's mode is umask-masked and does
  // nothing for a pre-existing directory, so chmod runs either way. This
  // directory holds credentials (config.json carries the auth token).
  if (!fs.existsSync(VIBE_DIR)) {
    fs.mkdirSync(VIBE_DIR, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(VIBE_DIR, 0o700);
}

/**
 * Load terminal/buddy auth file (~/.vibe/auth.json)
 * Cross-client: if user authenticated via Buddy app, MCP server can pick it up
 * Format: { token, handle, provider, authenticated_at }
 */
function loadTerminalAuth() {
  try {
    if (fs.existsSync(TERMINAL_AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(TERMINAL_AUTH_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function load() {
  ensureDir();
  // Try primary config first
  try {
    if (fs.existsSync(PRIMARY_CONFIG)) {
      const data = JSON.parse(fs.readFileSync(PRIMARY_CONFIG, 'utf8'));
      // Normalize: support both 'handle' and 'username' field names
      return {
        ...data, // Pass through all fields (including x_credentials, etc.)
        handle: data.handle || data.username || null,
        one_liner: data.one_liner || data.workingOn || null,
        visible: data.visible !== false,
        // AIRC keypair (persisted across sessions)
        publicKey: data.publicKey || null,
        privateKey: data.privateKey || null
      };
    }
  } catch (e) {}
  // Fallback to legacy config (returns full object) — but NEVER for an isolated
  // session. ~/.vibecodings/config.json is the machine's shared legacy identity;
  // reading it under VIBE_HOME means an isolated session silently becomes the
  // shared being (the Stage-0 identity-leak incident). An isolated dir with no
  // config is simply signed out.
  if (!isIsolated()) {
    try {
      if (fs.existsSync(FALLBACK_CONFIG)) {
        return JSON.parse(fs.readFileSync(FALLBACK_CONFIG, 'utf8'));
      }
    } catch (e) {}
  }
  return { handle: null, one_liner: null, visible: true, publicKey: null, privateKey: null };
}

function save(config) {
  ensureDir();
  // Load existing to preserve fields we're not updating.
  //
  // Every field below falls back to `existing`, so a file that failed to parse
  // does not merge into this write — it VANISHES from it, and the auth token
  // with it. Signing someone out is not a repair for a file we could not read.
  let existing = {};
  if (fs.existsSync(PRIMARY_CONFIG)) {
    try {
      existing = JSON.parse(fs.readFileSync(PRIMARY_CONFIG, 'utf8'));
    } catch (e) {
      console.error('Refusing to write config: the file on disk could not be read.', e.message);
      return false;
    }
  }

  // Save to primary config (~/.vibe/config.json)
  const data = {
    username: config.handle || config.username || existing.username,
    workingOn: config.one_liner || config.workingOn || existing.workingOn,
    createdAt: config.createdAt || existing.createdAt || new Date().toISOString().split('T')[0],
    // AIRC keypair (persisted across sessions)
    publicKey: config.publicKey || existing.publicKey || null,
    privateKey: config.privateKey || existing.privateKey || null,
    // Guided mode (AskUserQuestion menus)
    guided_mode: config.guided_mode !== undefined ? config.guided_mode : existing.guided_mode,
    // GitHub Activity settings
    github_activity_enabled: config.github_activity_enabled !== undefined ? config.github_activity_enabled : existing.github_activity_enabled,
    github_activity_privacy: config.github_activity_privacy || existing.github_activity_privacy || null,
    // OAuth token (persisted across MCP process restarts)
    authToken: config.authToken || config.privyToken || existing.authToken || existing.privyToken || null,
    authMethod: config.authMethod || existing.authMethod || null
  };
  // Fields this function does not enumerate — x_credentials, firstDmSent,
  // pendingAuth, visible — used to vanish on every save, because the object
  // above is built field by field.
  //
  // Two layers are needed, not one. Spreading `existing` keeps what was already
  // on disk (each key in `data` already falls back to its existing value, so the
  // overlay never replaces a real value with a null it invented). But callers
  // also SET these fields — `cfg.pendingAuth = true`, `cfg.visible = true`,
  // `save({firstDmSent: true})` — and those writes were dropped just as
  // silently. Keeping only `existing` would preserve the old value and still
  // ignore the update, which reads as working and isn't. So the caller's own
  // non-translated keys go on top of `existing` and under `data`.
  //
  // TRANSLATED names are excluded because they are aliases the block above
  // already resolved; passing them through would write both spellings.
  const TRANSLATED = new Set([
    'handle', 'one_liner', 'username', 'workingOn', 'createdAt',
    'publicKey', 'privateKey', 'guided_mode', 'authToken', 'privyToken',
    'authMethod', 'github_activity_enabled', 'github_activity_privacy',
  ]);
  const fromCaller = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (!TRANSLATED.has(k)) fromCaller[k] = v;
  }
  const merged = { ...existing, ...fromCaller, ...data };

  // 0600: this file carries the auth token — it is a credential, not a preference.
  const tmp = `${PRIMARY_CONFIG}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PRIMARY_CONFIG);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.error('Failed to save config:', e.message);
    return false;
  }
  return true;
}

function getHandle() {
  // THE CREDENTIAL NAMES US — the files below are only what we knew before one loaded.
  //
  // Twenty-eight call sites across the tools read this function, and it answered from
  // disk independently of the token those same tools authenticate with. That is the
  // split identity reproduced in review: a token for account A while display and
  // self-checks said account B, so a tool could route a message to "you" that the
  // server had authored as someone else. Fixing it at each call site would have been
  // twenty-eight chances to miss one; fixing it here makes every reader correct at
  // once, and leaves exactly one place that decides.
  //
  // Required lazily: auth-store loads config during hydration, and a top-level import
  // here would close that circle.
  //
  // We hydrate here rather than assuming someone already did. The store answers from
  // memory, so before hydration it answers null — and this function would quietly fall
  // through to the file, which is the exact bug above. That made the fix depend on an
  // ordering nothing enforced: correct inside the MCP server (which hydrates in its
  // constructor) and wrong in any script, CLI path or test that reads identity first.
  // A guarantee that holds only when called in the right order is not a guarantee.
  // hydrate() is idempotent and reads two files it has usually already read.
  try {
    const authStore = require('./auth-store');
    authStore.hydrate();
    const fromCredential = authStore.getHandle();
    if (fromCredential) return fromCredential;

    // A credential was present and could not be attributed. The remembered name below
    // must NOT step in: it would put a handle on screen that nothing backs, which is
    // this bug wearing the file's clothes. No credential at all is a different and
    // honest state, and falls through.
    if (authStore.hasRejectedCredential()) return null;
  } catch (e) {
    // auth-store unavailable (early boot) — fall through to what is on disk.
  }

  // Prefer session-specific handle over shared config
  const sessionHandle = getSessionHandle();
  if (sessionHandle) return sessionHandle;
  // Fall back to shared config
  const cfg = load();
  if (cfg.handle) return cfg.handle;
  // Cross-client: check terminal/buddy auth file
  const terminalAuth = loadTerminalAuth();
  return terminalAuth?.handle || null;
}

function getOneLiner() {
  // Prefer session-specific one_liner over shared config
  const sessionOneLiner = getSessionOneLiner();
  if (sessionOneLiner) return sessionOneLiner;
  // Fall back to shared config
  const config = load();
  return config.one_liner || null;
}

function isInitialized() {
  // A VALID CREDENTIAL IS INITIALISATION. Asking the file was the bug.
  //
  // This checked only for a stored handle, so a config that held a perfectly good token
  // and no `username` reported "not initialized" forever. Tools behind requireInit()
  // refused with "Run `vibe init` first" while presence — which resolves identity from
  // the credential — worked in the same response. One reply, two answers about whether
  // you are signed in.
  //
  // It is reachable by accident: save() writes `username: config.handle ||
  // config.username || existing.username`, and when all three are absent that value is
  // `undefined`, which JSON.stringify DROPS. So the key does not go null, it disappears,
  // and nothing puts it back. Observed on this machine 2026-08-01.
  //
  // The credential is the identity (#107). If one names us, we are initialised — and if
  // one does not, no remembered string should pretend otherwise.
  if (getHandle()) return true;
  const sessionHandle = getSessionHandle();
  if (sessionHandle) return true;
  const config = load();
  return !!(config.handle && config.handle.length > 0);
}

// Session management - unique ID per Claude Code instance
// Now stores full identity (handle + one_liner), not just sessionId
const SESSION_FILE = path.join(VIBE_DIR, `.session_${process.pid}`);

function generateSessionId() {
  return 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

// Distinguishes "no session yet" (absent) from "unreadable" (present, corrupt),
// which getSessionData() cannot: both come back as null.
function sessionFileIsReadable() {
  if (!fs.existsSync(SESSION_FILE)) return true;
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (content.startsWith('{')) JSON.parse(content);
    return true;
  } catch (e) {
    return false;
  }
}

function getSessionData() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      // Support old format (just sessionId string) and new format (JSON)
      if (content.startsWith('{')) {
        return JSON.parse(content);
      }
      // Old format: just the sessionId
      return { sessionId: content, handle: null, one_liner: null };
    }
  } catch (e) {}
  return null;
}

function saveSessionData(data) {
  ensureDir();
  if (!sessionFileIsReadable()) {
    console.error('Refusing to write session data: the file on disk could not be read.');
    return false;
  }
  const tmp = `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.error('Failed to save session data:', e.message);
    return false;
  }
  return true;
}

function getSessionId() {
  const data = getSessionData();
  if (data?.sessionId) {
    return data.sessionId;
  }
  // Generate new session
  const sessionId = generateSessionId();
  saveSessionData({ sessionId, handle: null, one_liner: null });
  return sessionId;
}

function getSessionHandle() {
  const data = getSessionData();
  return data?.handle || null;
}

function getSessionOneLiner() {
  const data = getSessionData();
  return data?.one_liner || null;
}

function setSessionIdentity(handle, one_liner, keypair = null) {
  const sessionId = getSessionId();
  const existingData = getSessionData() || {};
  saveSessionData({
    sessionId,
    handle,
    one_liner,
    // Preserve token if already set (from server registration)
    token: existingData.token || null,
    // AIRC keypair (generated on init)
    publicKey: keypair?.publicKey || existingData.publicKey || null,
    privateKey: keypair?.privateKey || existingData.privateKey || null
  });
}

function getKeypair() {
  // First check session data
  const sessionData = getSessionData();
  if (sessionData?.publicKey && sessionData?.privateKey) {
    return {
      publicKey: sessionData.publicKey,
      privateKey: sessionData.privateKey
    };
  }
  // Fall back to shared config (keypairs persist across MCP invocations)
  const config = load();
  if (config?.publicKey && config?.privateKey) {
    return {
      publicKey: config.publicKey,
      privateKey: config.privateKey
    };
  }
  return null;
}

function hasKeypair() {
  return getKeypair() !== null;
}

function saveKeypair(keypair) {
  // Save to shared config so it persists across MCP process invocations
  const config = load();
  config.publicKey = keypair.publicKey;
  config.privateKey = keypair.privateKey;
  save(config);
}

function setAuthToken(token, sessionId = null) {
  const data = getSessionData() || {};
  saveSessionData({
    ...data,
    sessionId: sessionId || data.sessionId || generateSessionId(),
    token
  });
}

function getAuthToken() {
  // First check session data
  const data = getSessionData();
  if (data?.token) return data.token;

  // Fall back to shared config (persisted across MCP process restarts)
  const cfg = load();
  if (cfg?.authToken || cfg?.privyToken) return cfg.authToken || cfg.privyToken;

  // Cross-client: check terminal/buddy auth file (~/.vibe/auth.json)
  const terminalAuth = loadTerminalAuth();
  if (terminalAuth?.token) return terminalAuth.token;

  return null;
}

/**
 * Save auth token (used after browser OAuth flow)
 * @param {string} token - JWT access token from GitHub OAuth
 */
function saveAuthToken(token) {
  // Save to session data
  const data = getSessionData() || {};
  saveSessionData({
    ...data,
    sessionId: data.sessionId || generateSessionId(),
    token,
    authMethod: 'github'  // Track that this is GitHub OAuth
  });

  // Also save to shared config for persistence across MCP restarts.
  //
  // The handle rides WITH the token. Persisting a credential and no identity is how a
  // config comes to hold a valid token under no name — and save() cannot repair it,
  // because it writes `username: undefined` in that case and JSON.stringify drops the
  // key rather than storing null. The state is invisible and permanent.
  const cfg = load();
  cfg.authToken = token;
  cfg.authMethod = 'github';
  if (!cfg.handle) {
    // Derive it from the credential itself rather than leaving the file anonymous.
    try {
      cfg.handle = require('./auth-store').inspectToken(token).handle || cfg.handle;
    } catch (e) { /* auth-store unavailable at early boot — the token still saves */ }
  }
  save(cfg);
}

// Backwards compatibility alias
const savePrivyToken = saveAuthToken;

/**
 * Check if user has OAuth auth (vs legacy keypair)
 * Accepts 'github', 'privy', and 'browser' as valid auth methods (backwards compat)
 */
function hasOAuth() {
  const validAuthMethods = ['github', 'privy', 'browser'];

  const data = getSessionData();
  if (validAuthMethods.includes(data?.authMethod) && data?.token) return true;

  const cfg = load();
  if (validAuthMethods.includes(cfg?.authMethod) && (cfg?.authToken || cfg?.privyToken)) return true;

  // Cross-client: check terminal/buddy auth file
  const terminalAuth = loadTerminalAuth();
  if (terminalAuth?.token && validAuthMethods.includes(terminalAuth?.provider)) return true;

  return false;
}

// Backwards compatibility alias
const hasPrivyAuth = hasOAuth;

/**
 * Remove keypair after migration to GitHub OAuth
 * Clears private key from config (security improvement)
 */
function removeKeypair() {
  const cfg = load();
  delete cfg.publicKey;
  delete cfg.privateKey;
  save(cfg);

  // Also clear from session
  const data = getSessionData();
  if (data) {
    delete data.publicKey;
    delete data.privateKey;
    saveSessionData(data);
  }
}

/**
 * Get auth URL for browser-based GitHub OAuth
 * @param {string|null} handle - Custom handle (optional - defaults to GitHub username)
 */
function getAuthUrl(handle = null) {
  const apiUrl = getApiUrl();
  if (handle) {
    return `${apiUrl}/api/auth/github?handle=${encodeURIComponent(handle)}`;
  }
  // No handle = use GitHub username as handle
  return `${apiUrl}/api/auth/github`;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch (e) {}
}

// Guided mode — show AskUserQuestion menus (default: true for new users)
function getGuidedMode() {
  const config = load();
  // Default to true (guided mode on) if not set
  return config.guided_mode !== false;
}

function setGuidedMode(enabled) {
  const config = load();
  config.guided_mode = enabled;
  save(config);
}

// GitHub Activity settings
// Shows shipping status based on GitHub commit activity
// Default: false (opt-in for privacy)
function getGithubActivityEnabled() {
  const config = load();
  return config.github_activity_enabled === true;
}

function setGithubActivityEnabled(enabled) {
  const config = load();
  config.github_activity_enabled = enabled;
  save(config);
}

// GitHub Activity privacy level
// Levels: "full" | "status_only" | "off"
// - full: Show repos, commit counts, tech stack (default when enabled)
// - status_only: Just show shipping badge (🔥/⚡), no details
// - off: Disabled completely
function getGithubActivityPrivacy() {
  const config = load();
  return config.github_activity_privacy || 'full';
}

function setGithubActivityPrivacy(level) {
  const validLevels = ['full', 'status_only', 'off'];
  if (!validLevels.includes(level)) {
    throw new Error(`Invalid privacy level. Use: ${validLevels.join(', ')}`);
  }
  const config = load();
  config.github_activity_privacy = level;
  save(config);
}

// API URL — central endpoint for all API calls
function getApiUrl() {
  return process.env.VIBE_API_URL || 'https://www.slashvibe.dev';
}

// ─────────────────────────────────────────────────────────────
// Generic key-value store for ephemeral session state
// Used by presence-agent, mute, and other tools for runtime state
// NOT persisted to disk — resets when MCP server restarts
// ─────────────────────────────────────────────────────────────
const sessionState = {};

function get(key, defaultValue = null) {
  return sessionState[key] !== undefined ? sessionState[key] : defaultValue;
}

function set(key, value) {
  sessionState[key] = value;
  return value;
}

module.exports = {
  VIBE_DIR,
  CONFIG_FILE,
  load,
  save,
  loadTerminalAuth,
  getHandle,
  getOneLiner,
  isInitialized,
  getSessionId,
  getSessionHandle,
  getSessionOneLiner,
  setSessionIdentity,
  setAuthToken,
  getAuthToken,
  getKeypair,
  hasKeypair,
  saveKeypair,
  clearSession,
  generateSessionId,
  getGuidedMode,
  setGuidedMode,
  // GitHub Activity settings
  getGithubActivityEnabled,
  setGithubActivityEnabled,
  getGithubActivityPrivacy,
  setGithubActivityPrivacy,
  getApiUrl,
  // OAuth helpers
  saveAuthToken,
  hasOAuth,
  // Backwards compatibility aliases
  savePrivyToken,
  hasPrivyAuth,
  removeKeypair,
  getAuthUrl,
  // Generic key-value for ephemeral session state
  get,
  set
};
