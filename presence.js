/**
 * Presence — Heartbeat loop
 *
 * Sends heartbeat every 30 seconds while MCP server is running.
 * Uses session tokens for per-session identity.
 * Users become "idle" after 5 minutes of no heartbeat.
 *
 * Also polls for DMs and guest messages on an idle-aware cadence. When they
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
let unreadPollTimer = null;
let guestPollTimer = null;
let sessionInitialized = false;

// ---- Poll cadence (2026-09-02 audit) -------------------------------------
// One idle signed-in client made 2 inbox reads every 15s forever — session/guest
// (6 KV commands) + the full threads list (1) — and the fleet's long-lived
// sessions (9-hour and 9-day-old windows) added up to ~7 inbox polls/sec at
// the KV. Replies must still land fast, so the DM check stays at 15s while the
// person is ACTIVE (any tool call in the last ACTIVE_WINDOW_MS) and backs off
// to 60s when idle; the guest-session poll, a pairing feature almost nobody is
// in, runs at 60s active / 300s idle. Any tool call snaps both back to fast.
// Worst-case DM latency: 15s active, 60s idle.
const ACTIVE_WINDOW_MS = Number(process.env.VIBE_POLL_ACTIVE_WINDOW_MS) || 10 * 60 * 1000;
const CADENCE = {
  active: { unread: 15 * 1000, guest: 60 * 1000 },
  idle:   { unread: 60 * 1000, guest: 300 * 1000 },
};
let lastActivityAt = Date.now(); // the session starting is activity

function noteActivity() {
  const wasIdle = cadenceFor(Date.now() - lastActivityAt) === CADENCE.idle;
  lastActivityAt = Date.now();
  // A pending idle timer would still fire on the slow cadence (codex P2 on #37):
  // re-arm both polls on the fast cadence the moment the person is back.
  if (wasIdle) {
    if (unreadPollTimer) { clearTimeout(unreadPollTimer); schedule('unread'); }
    if (guestPollTimer) { clearTimeout(guestPollTimer); schedule('guest'); }
  }
}

/** Pure: which cadence applies after `idleMs` without a tool call. */
function cadenceFor(idleMs) {
  return idleMs < ACTIVE_WINDOW_MS ? CADENCE.active : CADENCE.idle;
}

function schedule(kind) {
  const ms = cadenceFor(Date.now() - lastActivityAt)[kind];
  const run = async () => {
    if (kind === 'unread') await pollUnread(); else await pollGuestMessages();
    // Re-arm only while start() is in effect (stop() clears the timers).
    if (kind === 'unread' ? unreadPollTimer : guestPollTimer) schedule(kind);
  };
  const t = setTimeout(run, ms);
  t.unref?.();
  if (kind === 'unread') unreadPollTimer = t; else guestPollTimer = t;
}

function start() {
  if (heartbeatInterval) return;

  // Initial heartbeat (with session setup)
  initSession();

  // Then every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30 * 1000);

  // Inbox polls on the idle-aware cadence above (see CADENCE).
  if (!unreadPollTimer) schedule('unread');
  if (!guestPollTimer) schedule('guest');
}

function stop() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (unreadPollTimer) {
    clearTimeout(unreadPollTimer);
    unreadPollTimer = null;
  }
  if (guestPollTimer) {
    clearTimeout(guestPollTimer);
    guestPollTimer = null;
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
  } catch {
    // Silent fail — guest polling is best-effort
  }
}

/**
 * Ordinary DMs: nudge the session when the unread count RISES, so a DM sent
 * from any surface reaches the live session within one poll cycle
 * (getPresenceFooter injects the new bodies, once each). A drop just
 * rebaselines — reading elsewhere shouldn't trigger a refresh here.
 */
async function pollUnread() {
  try {
    // The CREDENTIAL says who this is; a handle in a file is not a principal.
    const handle = authStore.getHandle() || config.getHandle();
    if (!handle) return;
    // One request serves both jobs: the unread count (as before) and the
    // arrivals — the same /threads read getUnreadCount made, with the rows kept.
    const read = await store.getInboxResult(handle).catch(() => null);
    if (!read || read.ok !== true) return;
    const threads = read.threads || [];
    const unread = threads.reduce((sum, t) => sum + (t.unread || 0), 0);
    if (lastSeenUnread !== null && unread > lastSeenUnread && global.vibeNotifier) {
      global.vibeNotifier.emitImmediate();
    }
    lastSeenUnread = unread;
    await noteArrivals(handle, threads);
  } catch {
    // Silent fail — best-effort
  }
}

/**
 * Someone wrote while the person was working: spool it for the arrival hook
 * and, where the host listens, push it through the channel (arrival.js).
 * Only for a VERIFIED session — an arrival names a sender to a person, and
 * that is not something to do on the strength of an unverified credential.
 */
const startedAt = Date.now();
let lastPruneAt = 0;
let waitingAtStart = null;
async function noteArrivals(handle, threads) {
  if (!authStore.isVerified?.()) return;
  if (['0', 'off', 'false'].includes(String(process.env.VIBE_ARRIVALS || '').toLowerCase())) return;
  const arrival = require('./arrival');
  if (Date.now() - lastPruneAt > 60 * 60 * 1000) { lastPruneAt = Date.now(); arrival.prune(handle); }
  // What was already unread on the FIRST look is "waiting" (the SessionStart
  // hook's to show), not an arrival. It is remembered by message id, so after
  // that first look a new id is an arrival whatever the two clocks say; only
  // the first look itself leans on timestamps, to catch a message that landed
  // between launch and the first poll.
  if (waitingAtStart === null) {
    const early = new Set(arrival.pickArrivals(threads, handle, { since: startedAt }).map((t) => t.lastMessageId));
    waitingAtStart = new Set(threads.filter((t) => t.unread > 0 && t.lastMessageId && !early.has(t.lastMessageId))
      .map((t) => t.lastMessageId));
  }
  const live = threads.filter((t) => !waitingAtStart.has(t.lastMessageId));
  const candidates = arrival.pickArrivals(live, handle)
    .filter((t) => !arrival.isClaimed(t.lastMessageId) && !arrival.isSpooled(t.lastMessageId));
  if (candidates.length === 0) return;
  const roster = await store.getActiveUsers().catch(() => []);
  let bindingFor = null;
  try { bindingFor = require('./tools/moves').getReturnBinding; } catch {}
  const rows = arrival.record(live, handle, { roster, bindingFor });
  if (rows.length && typeof global.vibeArrivalPush === 'function') global.vibeArrivalPush(rows);
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

module.exports = { start, stop, forceHeartbeat, goOffline, noteActivity, noteArrivals, cadenceFor, CADENCE, ACTIVE_WINDOW_MS,
  // test seams — read the armed delays, and age the session without waiting
  _pollDelaysForTest: () => ({ unread: unreadPollTimer?._idleTimeout ?? null, guest: guestPollTimer?._idleTimeout ?? null }),
  _setLastActivityForTest: (ts) => { lastActivityAt = ts; },
};
