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
const reach = require('./reach');
const line = require('./line');

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

// With an open line, someone's agent may be waiting on this one: look every
// 10s however idle the person is.
function pollDelay() {
  const base = cadenceFor(Date.now() - lastActivityAt);
  try { return require('./line').list().length ? Math.min(base, 10 * 1000) : base; } catch { return base; }
}

function schedule() {
  const t = setTimeout(async () => {
    await poll();
    if (pollTimer) schedule(); // stop() clears the timer
  }, pollDelay());
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
  // Invisible (reach.js): nothing here may say "this person is in a session".
  // Registering is such a statement, so it waits until they are visible.
  if (reach.isInvisible()) return;
  await register(sessionId, handle);
  beat(handle);
}

async function register(sessionId, handle) {
  if (sessionInitialized) return;
  // An agent's session is the one its credential minted (agent-auth.js).
  // Registering here answers with a second token and saves it over the first,
  // and that one carries no agent identity. The heartbeat alone says "here".
  if (require('./agent-auth').isAgent()) { sessionInitialized = true; return; }
  const result = await store.registerSession(sessionId, handle);
  sessionInitialized = Boolean(result && result.success);
}

function beat(handle) {
  store.heartbeat(handle, config.getOneLiner() || '');
}

async function sendHeartbeat() {
  if (!config.isInitialized()) return;
  // Read on every beat, so `invisible` and `visible` take effect in open
  // sessions without a restart. The inbox poll is separate and keeps running:
  // being unseen must not make someone unreachable.
  if (reach.isInvisible()) return;
  const handle = authStore.getHandle();
  if (!handle) return;
  // Became visible in a session that started invisible: register once, then
  // beat as always (a failed registration never stopped the heartbeat before).
  if (!sessionInitialized) await register(config.getSessionId(), handle);
  beat(handle);
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
/**
 * Known = an open line, a send recorded on this machine, or (checked once and
 * then remembered) any message of yours in the conversation, so someone you
 * wrote to from another device still reaches you here. Reading the
 * conversation does not mark it read. A failed read is "not known yet".
 */
async function knows(me, them) {
  if (line.isOpen(them) || reach.isKnown(them)) return true;
  try {
    const thread = await store.getThread(me, them);
    const mine = String(me).toLowerCase();
    if ((thread || []).some((m) => String(m.from || '').toLowerCase() === mine)) { reach.know(them); return true; }
  } catch {}
  return false;
}

const startedAt = Date.now();
let lastPruneAt = 0;
let waitingAtStart = null;
async function noteArrivals(handle, threads) {
  if (!authStore.isVerified?.()) return;
  if (['0', 'off', 'false'].includes(String(process.env.VIBE_ARRIVALS || '').toLowerCase())) return;
  if (Date.now() - lastPruneAt > 60 * 60 * 1000) { lastPruneAt = Date.now(); arrival.prune(handle); }
  // Quiet: nothing surfaces. What comes in meanwhile is remembered as waiting,
  // so turning quiet off does not release a burst of old arrivals.
  if (reach.isQuiet()) {
    if (waitingAtStart === null) waitingAtStart = new Set();
    for (const t of threads) if (t.unread > 0 && t.lastMessageId) waitingAtStart.add(t.lastMessageId);
    return;
  }
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
  const fresh = threads.filter((t) => !waitingAtStart.has(t.lastMessageId));
  const wanted = arrival.pickArrivals(fresh, handle)
    .filter((t) => !arrival.isClaimed(t.lastMessageId) && !arrival.isSpooled(t.lastMessageId));
  // Only someone you know reaches you mid-work (reach.js). A muted person, or
  // someone you have never written to, stays waiting: remembered here so the
  // question is asked once per message, not once per poll.
  const candidates = [];
  for (const t of wanted) {
    if (!reach.isMuted(t.lastFrom) && await knows(handle, t.lastFrom)) candidates.push(t);
    else waitingAtStart.add(t.lastMessageId);
  }
  if (candidates.length === 0) return;
  const allowed = new Set(candidates.map((t) => t.lastMessageId));
  const live = fresh.filter((t) => allowed.has(t.lastMessageId));
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
  _sendHeartbeatForTest: sendHeartbeat,
};
