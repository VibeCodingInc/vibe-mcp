/**
 * Presence and arrival — the two things this process does between tool calls.
 *
 * While a session is open it says "this person is in a session" (a heartbeat
 * every 30s, only for a credential the server has verified), and it watches
 * the inbox so a message that arrives is put in front of the person while
 * they work (arrival.js).
 */

'use strict';

const config = require('./config');
const authStore = require('./auth-store');
const store = require('./store');
const arrival = require('./arrival');

let heartbeatInterval = null;
let pollTimer = null;
let sessionInitialized = false;

// ---- Poll cadence ---------------------------------------------------------
// One request (the threads list) per poll. Fast while the person is ACTIVE
// (any /vibe tool call in the last ACTIVE_WINDOW_MS), slower when idle: many
// sessions stay open for days, and every one of them polls. Worst-case time
// for a message to be noticed: 15s active, 60s idle.
const ACTIVE_WINDOW_MS = Number(process.env.VIBE_POLL_ACTIVE_WINDOW_MS) || 10 * 60 * 1000;
const CADENCE = { active: 15 * 1000, idle: 60 * 1000 };
let lastActivityAt = Date.now(); // the session starting is activity

/** Pure: the poll interval after `idleMs` without a tool call. */
function cadenceFor(idleMs) {
  return idleMs < ACTIVE_WINDOW_MS ? CADENCE.active : CADENCE.idle;
}

function noteActivity() {
  const wasIdle = cadenceFor(Date.now() - lastActivityAt) === CADENCE.idle;
  lastActivityAt = Date.now();
  // A pending idle timer would still fire on the slow cadence: re-arm on the
  // fast one the moment the person is back.
  if (wasIdle && pollTimer) { clearTimeout(pollTimer); schedule(); }
}

function schedule() {
  const t = setTimeout(async () => {
    await poll();
    if (pollTimer) schedule(); // stop() clears the timer
  }, cadenceFor(Date.now() - lastActivityAt));
  t.unref?.();
  pollTimer = t;
}

function start() {
  if (heartbeatInterval) return;
  initSession();
  heartbeatInterval = setInterval(sendHeartbeat, 30 * 1000);
  heartbeatInterval.unref?.();
  if (!pollTimer) schedule();
}

function stop() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  config.clearSession();
}

// The handle we broadcast is the one the CREDENTIAL names, never one written
// in a config file.
async function initSession() {
  if (!config.isInitialized()) return;
  const handle = authStore.getHandle();
  if (!handle) return;
  const sessionId = config.getSessionId();
  store.setSessionId(sessionId);
  if (!sessionInitialized) {
    const result = await store.registerSession(sessionId, handle);
    sessionInitialized = result.success;
  }
  sendHeartbeat();
}

async function sendHeartbeat() {
  if (!config.isInitialized()) return;
  const handle = authStore.getHandle();
  if (handle) store.heartbeat(handle, config.getOneLiner() || '');
}

async function poll() {
  try {
    const handle = authStore.getHandle();
    if (!handle) return;
    const read = await store.getInboxResult(handle).catch(() => null);
    if (!read || read.ok !== true) return;
    await noteArrivals(handle, read.threads || []);
  } catch {
    // Best-effort: an arrival we missed is still unread in the conversation.
  }
}

/**
 * Someone wrote while the person was working: spool it for the arrival hook
 * and, where the host listens, push it through the channel. Only for a
 * VERIFIED session: an arrival names a sender to a person, and that is not
 * something to do on the strength of an unverified credential.
 */
const startedAt = Date.now();
let lastPruneAt = 0;
let waitingAtStart = null;
async function noteArrivals(handle, threads) {
  if (!authStore.isVerified?.()) return;
  if (['0', 'off', 'false'].includes(String(process.env.VIBE_ARRIVALS || '').toLowerCase())) return;
  if (Date.now() - lastPruneAt > 60 * 60 * 1000) { lastPruneAt = Date.now(); arrival.prune(handle); }
  // What was already unread on the FIRST look is "waiting" (shown when the
  // session opens), not an arrival. It is remembered by message id, so after
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
  try { bindingFor = require('./tools/drafts').getReturnBinding; } catch {}
  const rows = arrival.record(live, handle, { roster, bindingFor });
  if (rows.length && typeof global.vibeArrivalPush === 'function') global.vibeArrivalPush(rows);
}

module.exports = {
  start, stop, noteActivity, noteArrivals, cadenceFor, CADENCE, ACTIVE_WINDOW_MS,
  // test seams
  _pollDelayForTest: () => pollTimer?._idleTimeout ?? null,
  _setLastActivityForTest: (ts) => { lastActivityAt = ts; },
};
