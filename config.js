/**
 * Config — User identity and paths
 *
 * UNIFIED: Uses ~/.vibecodings/config.json as primary source
 * Falls back to ~/.vibe/config.json for backward compat
 */

const fs = require('fs');
const path = require('path');

const VIBE_DIR = path.join(process.env.HOME, '.vibe');
const VIBECODINGS_DIR = path.join(process.env.HOME, '.vibecodings');
const PRIMARY_CONFIG = path.join(VIBECODINGS_DIR, 'config.json');  // Primary
const FALLBACK_CONFIG = path.join(VIBE_DIR, 'config.json');        // Fallback
const CONFIG_FILE = PRIMARY_CONFIG;

function ensureDir() {
  if (!fs.existsSync(VIBECODINGS_DIR)) {
    fs.mkdirSync(VIBECODINGS_DIR, { recursive: true });
  }
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
  // Fallback to legacy config (returns full object)
  try {
    if (fs.existsSync(FALLBACK_CONFIG)) {
      return JSON.parse(fs.readFileSync(FALLBACK_CONFIG, 'utf8'));
    }
  } catch (e) {}
  return { handle: null, one_liner: null, visible: true, publicKey: null, privateKey: null };
}

function save(config) {
  ensureDir();
  // Load existing to preserve fields we're not updating
  let existing = {};
  try {
    if (fs.existsSync(PRIMARY_CONFIG)) {
      existing = JSON.parse(fs.readFileSync(PRIMARY_CONFIG, 'utf8'));
    }
  } catch (e) {}

  // Save to primary config in vibecodings format
  const data = {
    username: config.handle || config.username || existing.username,
    workingOn: config.one_liner || config.workingOn || existing.workingOn,
    createdAt: config.createdAt || existing.createdAt || new Date().toISOString().split('T')[0],
    // AIRC keypair (persisted across sessions)
    publicKey: config.publicKey || existing.publicKey || null,
    privateKey: config.privateKey || existing.privateKey || null,
    // Guided mode (AskUserQuestion menus)
    guided_mode: config.guided_mode !== undefined ? config.guided_mode : existing.guided_mode,
    // Notification level
    notifications: config.notifications || existing.notifications || null,
    // GitHub Activity settings
    github_activity_enabled: config.github_activity_enabled !== undefined ? config.github_activity_enabled : existing.github_activity_enabled,
    github_activity_privacy: config.github_activity_privacy || existing.github_activity_privacy || null,
    // Privy OAuth token (persisted across MCP process restarts)
    privyToken: config.privyToken || existing.privyToken || null,
    authMethod: config.authMethod || existing.authMethod || null
  };
  fs.writeFileSync(PRIMARY_CONFIG, JSON.stringify(data, null, 2));
}

function getHandle() {
  // Prefer session-specific handle over shared config
  const sessionHandle = getSessionHandle();
  if (sessionHandle) return sessionHandle;
  // Fall back to shared config
  const config = load();
  return config.handle || null;
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
  // Check session first, then shared config
  const sessionHandle = getSessionHandle();
  if (sessionHandle) return true;
  const config = load();
  return config.handle && config.handle.length > 0;
}

// Session management - unique ID per Claude Code instance
// Now stores full identity (handle + one_liner), not just sessionId
const SESSION_FILE = path.join(VIBECODINGS_DIR, `.session_${process.pid}`);

function generateSessionId() {
  return 'sess_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
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
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
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
  return cfg?.privyToken || null;
}

/**
 * Save Privy JWT token (used after browser OAuth flow)
 * @param {string} token - Privy access token
 */
function savePrivyToken(token) {
  // Save to session data
  const data = getSessionData() || {};
  saveSessionData({
    ...data,
    sessionId: data.sessionId || generateSessionId(),
    token,
    authMethod: 'privy'  // Track that this is a Privy token
  });

  // Also save to shared config for persistence across MCP restarts
  const cfg = load();
  cfg.privyToken = token;
  cfg.authMethod = 'privy';
  save(cfg);
}

/**
 * Check if user has Privy auth (vs legacy keypair)
 */
function hasPrivyAuth() {
  const data = getSessionData();
  if (data?.authMethod === 'privy' && data?.token) return true;

  const cfg = load();
  return cfg?.authMethod === 'privy' && cfg?.privyToken;
}

/**
 * Remove keypair after migration to Privy
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

// Notification settings
// Levels: "all" | "mentions" | "off"
// - all: desktop + bell for unread, mentions, presence (default)
// - mentions: only @mentions trigger notifications
// - off: no notifications
function getNotifications() {
  const config = load();
  return config.notifications || 'all';
}

function setNotifications(level) {
  const validLevels = ['all', 'mentions', 'off'];
  if (!validLevels.includes(level)) {
    throw new Error(`Invalid notification level. Use: ${validLevels.join(', ')}`);
  }
  const config = load();
  config.notifications = level;
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
  getNotifications,
  setNotifications,
  // GitHub Activity settings
  getGithubActivityEnabled,
  setGithubActivityEnabled,
  getGithubActivityPrivacy,
  setGithubActivityPrivacy,
  getApiUrl,
  // Privy OAuth helpers
  savePrivyToken,
  hasPrivyAuth,
  removeKeypair,
  getAuthUrl,
  // Generic key-value for ephemeral session state
  get,
  set
};
