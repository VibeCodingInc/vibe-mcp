/**
 * Presence — Heartbeat loop
 *
 * Sends heartbeat every 30 seconds while MCP server is running.
 * Uses session tokens for per-session identity.
 * Users become "idle" after 5 minutes of no heartbeat.
 *
 * Also runs a guest message poll every 15 seconds. When guest messages
 * are detected, emits a tools/list_changed notification to force Claude
 * to re-query vibe tools (which triggers getPresenceFooter and injects
 * the messages into context). This ensures Use Case 2 (user testing/QA)
 * works even when the developer is deep in non-vibe tool calls.
 */

const config = require('./config');
const authStore = require('./auth-store');
const store = require('./store');
const { apiHeaders } = require('./api-auth');

let heartbeatInterval = null;
let guestPollInterval = null;
let sessionInitialized = false;

function start() {
  if (heartbeatInterval) return;

  // Initial heartbeat (with session setup)
  initSession();

  // Then every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30 * 1000);

  // Guest message poll: every 15 seconds, check for incoming session messages
  // and emit tools/list_changed to force Claude to pick them up via getPresenceFooter
  if (!guestPollInterval) {
    guestPollInterval = setInterval(pollGuestMessages, 15 * 1000);
  }
}

function stop() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (guestPollInterval) {
    clearInterval(guestPollInterval);
    guestPollInterval = null;
  }
  // Clean up session file
  config.clearSession();
}

async function initSession() {
  if (!config.isInitialized()) return;

  // The handle we broadcast is the one our CREDENTIAL names — not the one written in
  // a config file. Reading config here is what made "presence follows the credential"
  // untrue after #107: the gate moved, the heartbeat did not (codex #4).
  const handle = authStore.getHandle();
  if (!handle) return;

  // Get or create session ID
  const sessionId = config.getSessionId();
  store.setSessionId(sessionId);

  // Register session with API if not already done
  if (!sessionInitialized) {
    const result = await store.registerSession(sessionId, handle);
    sessionInitialized = result.success;
  }

  // Send initial heartbeat
  sendHeartbeat();
}

async function sendHeartbeat() {
  if (!config.isInitialized()) return;

  // Same rule as initSession: presence names whoever holds the credential.
  const handle = authStore.getHandle();
  const one_liner = config.getOneLiner();
  if (handle) {
    store.heartbeat(handle, one_liner || '');
  }
}

/**
 * Poll for guest session messages (from paired users) AND new ordinary DMs.
 * When either exists, emit tools/list_changed to trigger Claude to refresh,
 * which calls getPresenceFooter() and injects the messages into context.
 * Does NOT ack/read the messages — guest ack happens in getPresenceFooter;
 * DM read-cursors advance only when the user opens/replies to the thread.
 */
let lastSeenUnread = null;

async function pollGuestMessages() {
  try {
    const handle = config.getHandle();
    if (!handle) return;

    const apiUrl = config.getApiUrl?.() || 'https://www.slashvibe.dev';
    const resp = await fetch(`${apiUrl}/api/session/guest?handle=${encodeURIComponent(handle)}`, {
      headers: apiHeaders(),
    });
    if (!resp.ok) return;

    const data = await resp.json();
    if (data.success && Array.isArray(data.messages) && data.messages.length > 0) {
      // Guest messages waiting — emit list_changed to force Claude to refresh
      // getPresenceFooter() will pick them up and inject into context (with ack)
      if (global.vibeNotifier) {
        global.vibeNotifier.emitImmediate();
      }
    }

    // Ordinary DMs: nudge the session when the unread count RISES, so a DM
    // sent from any surface reaches the live session within one poll cycle
    // (getPresenceFooter injects the new bodies, once each). A drop just
    // rebaselines — reading elsewhere shouldn't trigger a refresh here.
    const unread = await store.getUnreadCount(handle).catch(() => null);
    if (typeof unread === 'number') {
      if (lastSeenUnread !== null && unread > lastSeenUnread && global.vibeNotifier) {
        global.vibeNotifier.emitImmediate();
      }
      lastSeenUnread = unread;
    }
  } catch {
    // Silent fail — guest polling is best-effort
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
  await store.heartbeat(handle, one_liner || '');

  return { success: true, handle };
}

/**
 * Explicit offline beacon — flips presence off now instead of waiting out the
 * last_seen TTL. Used by vibe_bye so "signed off" is true immediately.
 */
async function goOffline() {
  const handle = config.getHandle();
  if (!handle) return;
  const apiUrl = config.getApiUrl?.() || 'https://www.slashvibe.dev';
  try {
    await fetch(`${apiUrl}/api/v2/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiHeaders() },
      body: JSON.stringify({ action: 'offline' }),
    });
  } catch {
    // Best-effort: the TTL still expires us if this doesn't land.
  }
}

module.exports = { start, stop, forceHeartbeat, goOffline };
