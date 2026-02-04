/**
 * Presence — Heartbeat loop
 *
 * Sends heartbeat every 30 seconds while MCP server is running.
 * Uses session tokens for per-session identity.
 * Users become "idle" after 5 minutes of no heartbeat.
 */

const config = require('./config');
const store = require('./store');
const notify = require('./notify');
const analytics = require('./analytics');
const os = require('os');
const { execSync } = require('child_process');

let heartbeatInterval = null;
let sessionInitialized = false;

function start() {
  if (heartbeatInterval) return;

  // Initial heartbeat (with session setup)
  initSession();

  // Then every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30 * 1000);
}

function stop() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // End local session journal + analytics
  try {
    const sessionId = config.getSessionId();
    if (sessionId) {
      const getSessions = require('./store/sessions');
      getSessions().endSession(sessionId);
    }
    analytics.trackSession('ended');
  } catch (e) { /* journal/analytics is best-effort */ }

  // Clean up session file
  config.clearSession();
}

async function initSession() {
  if (!config.isInitialized()) return;

  // Use session-aware getters (prefer session identity over shared config)
  const handle = config.getHandle();
  if (!handle) return;

  // Get or create session ID
  const sessionId = config.getSessionId();
  store.setSessionId(sessionId);

  // Register session with API if not already done
  if (!sessionInitialized) {
    const result = await store.registerSession(sessionId, handle);
    sessionInitialized = result.success;
  }

  // Track session start (anonymous analytics)
  analytics.trackSession('started', {
    machine: os.hostname(),
    platform: process.platform,
    node: process.version
  });

  // Start local session journal
  try {
    const getSessions = require('./store/sessions');
    let repo = null;
    let branch = null;
    try {
      repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 2000 }).trim();
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (e) { /* not in a git repo */ }
    getSessions().startSession(sessionId, handle, {
      repo,
      branch,
      machineId: os.hostname()
    });
  } catch (e) { /* journal is best-effort */ }

  // Send initial heartbeat
  sendHeartbeat();
}

async function sendHeartbeat() {
  if (!config.isInitialized()) return;

  // Use session-aware getters (prefer session identity over shared config)
  const handle = config.getHandle();
  const one_liner = config.getOneLiner();
  if (handle) {
    store.heartbeat(handle, one_liner || '', null, 'mcp');

    // Check for notifications (runs in background, non-blocking)
    notify.checkAll(store).catch(() => {});
  }
}

// Force an immediate heartbeat (for doctor auto-fix)
async function forceHeartbeat() {
  if (!config.isInitialized()) {
    throw new Error('Not initialized');
  }

  const handle = config.getHandle();
  const sessionId = config.getSessionId();

  // Re-register session if needed
  if (!sessionInitialized) {
    const result = await store.registerSession(sessionId, handle);
    sessionInitialized = result.success;
  }

  // Send heartbeat
  const one_liner = config.getOneLiner();
  await store.heartbeat(handle, one_liner || '', null, 'mcp');

  return { success: true, handle };
}

module.exports = { start, stop, forceHeartbeat };
