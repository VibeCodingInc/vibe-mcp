/**
 * _shared.js — Common utilities for /vibe MCP tools
 *
 * This module provides shared helpers used across 90+ tools.
 * Import only what you need to keep tool files clean.
 */

const config = require('../config');
const { inertField } = require('../incoming');
const store = require('../store');

// ─────────────────────────────────────────────────────────────
// Authentication & Initialization
// ─────────────────────────────────────────────────────────────

/**
 * Check if user has initialized vibe. Returns error response if not.
 * Use at the top of handler functions:
 *   const initCheck = requireInit();
 *   if (initCheck) return initCheck;
 *
 * @returns {Object|null} Error response object, or null if initialized
 */
function requireInit() {
  if (!config.isInitialized()) {
    return {
      display: "You're not signed in yet. Run `vibe init` — GitHub opens in your browser and your username becomes your @handle.",
      error: 'not_initialized'
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Handle Normalization
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a handle string (remove @, lowercase, trim)
 * @param {string} handle - Raw handle input
 * @returns {string} Normalized handle
 */
function normalizeHandle(handle) {
  if (!handle) return '';
  return handle.toString().replace(/^@/, '').toLowerCase().trim();
}

/**
 * Format handle for display (with @)
 * @param {string} handle - Handle to format
 * @returns {string} Display-formatted handle
 */
function displayHandle(handle) {
  if (!handle) return '@unknown';
  const normalized = normalizeHandle(handle);
  return `@${normalized}`;
}

// ─────────────────────────────────────────────────────────────
// Presence freshness
// ─────────────────────────────────────────────────────────────

/**
 * GREEN MEANS A RECENT CONFIRMED HEARTBEAT — defined once, here.
 *
 * The server files anyone seen in the last 30 minutes under status "active",
 * which is the right retention window for the room but the wrong promise for
 * a green dot. Heartbeats arrive every 30s from a live session (5m from the
 * slowest sources), so ten minutes of silence means the session is gone.
 * Every surface that says "here right now" reads this helper.
 */
const RECENT_HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * Is this presence row a live one — server says active AND the heartbeat is
 * recent enough to believe it?
 * @param {{status?: string, lastSeen?: number}} user
 * @returns {boolean}
 */
function isHereNow(user) {
  return !!user && user.status === 'active'
    && (Date.now() - user.lastSeen) <= RECENT_HEARTBEAT_MS;
}

// ─────────────────────────────────────────────────────────────
// Time Formatting
// ─────────────────────────────────────────────────────────────

/**
 * Format timestamp as relative time (e.g., "5m ago", "2h ago")
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Human-readable relative time
 */
function formatTimeAgo(timestamp) {
  if (timestamp === undefined || timestamp === null || isNaN(timestamp)) return 'unknown';

  const now = Date.now();
  const seconds = Math.floor((now - timestamp) / 1000);

  if (seconds < 0 || isNaN(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format duration in human-readable form
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "5 minutes", "2 hours")
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return 'unknown';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;

  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

// ─────────────────────────────────────────────────────────────
// Text Formatting
// ─────────────────────────────────────────────────────────────

/**
 * Truncate text to max length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: 100)
 * @returns {string} Truncated text
 */
function truncate(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ─────────────────────────────────────────────────────────────
// Display Formatting (headers, dividers, status messages)
// ─────────────────────────────────────────────────────────────

/**
 * Format a section header
 * @param {string} text - Header text
 * @returns {string} Formatted header
 */
function header(text) {
  return `\n## ${text}\n`;
}

/**
 * Horizontal divider
 * @returns {string} Divider string
 */
function divider() {
  return '\n---\n';
}

/**
 * Format empty state message
 * @param {string} message - Message to display
 * @returns {string} Formatted empty state
 */
function emptyState(message) {
  return `\n_${message}_\n`;
}

/**
 * Format success message
 * @param {string} message - Success message
 * @returns {string} Formatted success message
 */
function success(message) {
  return `✓ ${message}`;
}

/**
 * Format warning message
 * @param {string} message - Warning message
 * @returns {string} Formatted warning message
 */
function warning(message) {
  return `⚠️ ${message}`;
}

/**
 * Format error message
 * @param {string} message - Error message
 * @returns {string} Formatted error message
 */
function error(message) {
  return `❌ ${message}`;
}

// ─────────────────────────────────────────────────────────────
// API Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Fetch relevant users for a given context
 * Uses the relevancy API to find people worth connecting with
 *
 * @param {string} handle - Current user's handle
 * @param {string} context - Context type: 'dm_suggest', 'notification', etc.
 * @param {number} limit - Max number of results (default: 5)
 * @returns {Promise<{matches: Array}>} Relevant users with reasons
 */
async function fetchRelevantUsers(handle, context = 'dm_suggest', limit = 5) {
  try {
    const apiUrl = config.getApiUrl();
    const response = await fetch(
      `${apiUrl}/api/relevancy?handle=${encodeURIComponent(handle)}&context=${context}&limit=${limit}`
    );

    if (!response.ok) {
      return { matches: [] };
    }

    return await response.json();
  } catch (e) {
    console.warn('[_shared] fetchRelevantUsers error:', e.message);
    return { matches: [] };
  }
}

// ─────────────────────────────────────────────────────────────
// First-DM activation (dormant users)
// ─────────────────────────────────────────────────────────────

/**
 * Has this user ever sent a DM?
 * Durable signal: a persisted `firstDmSent` flag (set on first successful send
 * via markFirstDmSent), seeded by the presence of any conversation memory —
 * existing messagers almost always have memory threads, so they're pre-excluded
 * and never see the nudge. Self-heals: the moment they send one DM, the flag
 * flips and the nudge is gone for good.
 *
 * @param {Array} threads - result of memory.listThreads()
 * @returns {boolean}
 */
function hasEverMessaged(threads) {
  try {
    const cfg = config.load();
    if (cfg && cfg.firstDmSent) return true;
  } catch (e) {}
  return Array.isArray(threads) && threads.length > 0;
}

/**
 * Persist the "has sent a first DM" flag so the activation nudge stops.
 * Called from dm.js on a successful send. Cheap, idempotent, best-effort.
 */
function markFirstDmSent() {
  try {
    const cfg = config.load();
    if (!cfg || !cfg.firstDmSent) config.save({ firstDmSent: true });
  } catch (e) {}
}

/**
 * Pick the most-recently-active real human from a presence list, with a
 * ready-to-paste opener. Filters out agents (is_agent) and self. Warms the
 * opener from the target's most recent ship (lastShip) when available.
 *
 * @param {Array} others - active users (already excludes self by convention)
 * @returns {{handle: string, opener: string}|null}
 */
function pickDormantTarget(others) {
  // The store's normalized field is `isAgent`; the old `is_agent`-only check was a
  // silent no-op, and the "message a real person" nudge pointed at an agent.
  const humans = (others || []).filter((u) => u && u.handle && !u.isAgent && !u.is_agent);
  if (humans.length === 0) return null;
  humans.sort(
    (a, b) => new Date(b.lastSeen || b.last_seen || 0) - new Date(a.lastSeen || a.last_seen || 0)
  );
  const pick = humans[0];
  // The opener is pasted inside a double-quoted `vibe dm @x "..."` command, so
  // strip any double quotes/backslashes the ship text itself contains (ship
  // content is arbitrary) and single-quote the snippet — otherwise an embedded
  // quote closes the command early and breaks the paste.
  // NO FOREIGN TEXT INSIDE A COMMAND WE ARE SUGGESTING SOMEONE RUN.
  //
  // The opener used to quote another user's ship description inside a ready-to-run
  // `vibe dm @x "..."` line. Inerting it (collapsing newlines, defanging markup) made
  // the injection harder but kept the wrong shape: attacker-authored words sitting in
  // an executable-looking instruction. The fix is not better escaping — it is that
  // the command contains only OUR words. What they shipped is shown separately, as
  // labelled data, where it belongs.
  const rawShip = pick.lastShip && pick.lastShip.what;
  const shippedNote = rawShip ? inertField(rawShip, 48) : '';
  const opener = 'hey! what are you building?';
  return { handle: pick.handle, opener, shippedNote };
}

/**
 * Render the first-DM activation nudge, or '' when it shouldn't show.
 * Shows only for users who have never sent a DM, and only when a real human is
 * around right now to receive it. This is the returning-user twin of the
 * new-user welcome first-message pull — it reaches the dormant existing users
 * where the actual funnel is.
 *
 * @param {Array} others - active users (excludes self)
 * @param {Array} threads - memory.listThreads()
 * @returns {string} markdown block (leading blank line) or ''
 */
function firstDmNudge(others, threads) {
  if (hasEverMessaged(threads)) return '';
  const target = pickDormantTarget(others);
  if (!target) return '';
  // What they shipped is shown as DATA, on its own line, outside the command — the
  // command itself contains only our words.
  const context = target.shippedNote
    ? `\n   _they last shipped:_ "${target.shippedNote}"`
    : '';
  return (
    `\n\n**👋 You haven't messaged anyone yet — @${target.handle} is around right now:**` +
    context +
    `\n   vibe dm @${target.handle} "${target.opener}"`
  );
}

// ─────────────────────────────────────────────────────────────
// Received collaboration (topical intro on onboarding)
// ─────────────────────────────────────────────────────────────

// Words too generic to signal a shared topic. Kept aligned with the
// server-side building-keyword filter in api/lib/relevancy.js.
const INTRO_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'app', 'apps',
  'using', 'your', 'you', 'building', 'build', 'built', 'working', 'work',
  'make', 'making', 'some', 'into', 'just', 'like', 'want', 'need', 'trying',
  'have', 'has', 'been', 'about', 'their', 'they', 'what', 'when', 'code',
  'coding', 'stuff', 'thing', 'things', 'project', 'projects', 'feature',
  'features', 'new', 'around', 'currently', 'right', 'now', 'today', 'session',
]);

/**
 * Extract meaningful, de-duped keywords from free text for topic matching.
 * Mirrors the >3-char + common-word filter used server-side so client and
 * server agree on what "related" means.
 */
function introKeywords(text) {
  return [
    ...new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s+#.-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !INTRO_STOPWORDS.has(w))
    ),
  ];
}

// The topical text we know about an online human: what they're working on
// right now + their most recent ship. Both are already public (presence + board).
function introTopicText(u) {
  const ship = u && u.lastShip && u.lastShip.what ? u.lastShip.what : '';
  return `${(u && u.one_liner) || ''} ${ship}`.trim();
}

// Strip quotes/backslashes and clamp — the opener is pasted inside a
// double-quoted `vibe dm @x "..."` command, so an embedded quote would close
// it early. Same paste-safety rule as pickDormantTarget.
function sanitizeSnippet(text, max = 48) {
  return String(text || '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Compose a two-sided warm opener: references what the newcomer is building AND
 * what the target is on, anchored to the topic they share. This is the whole
 * point of "received collaboration" — the newcomer arrives already in a
 * relevant conversation instead of cold-DMing a stranger.
 */
function composeIntro(building, target, shared) {
  const mine = sanitizeSnippet(building, 60);
  // For DISPLAY use one clean phrase — what they're doing now, else their last
  // ship. (introTopicText concatenates both for MATCHING, which reads badly.)
  const theirRaw =
    (target && target.one_liner) ||
    (target && target.lastShip && target.lastShip.what) ||
    '';
  const theirWork = sanitizeSnippet(theirRaw, 48);
  const topic = shared && shared[0];
  if (theirWork && topic) {
    return `hey! i just jumped into /vibe — i'm working on ${mine} and saw you're on ${theirWork}. we're both deep in ${topic}, want to compare notes?`;
  }
  if (theirWork) {
    return `hey! i just jumped into /vibe — i'm working on ${mine} and saw you're on ${theirWork}. what are you building?`;
  }
  return `hey! i just jumped into /vibe — i'm working on ${mine}. what are you building?`;
}

/**
 * Pick the online human whose current work / recent ship most overlaps with what
 * the newcomer is building this session. Returns a topically-matched target with
 * a composed two-sided opener, or null when nothing lines up (caller should fall
 * back to pickDormantTarget's recency pick). Agents are already excluded upstream
 * (getActiveUsers only returns active+away, never the agents lane) but we guard
 * anyway.
 *
 * @param {Array} others - active users (caller excludes self)
 * @param {string} building - the agent's one-line summary of the user's current work
 * @returns {{handle, opener, shared, related}|null}
 */
function pickRelatedTarget(others, building) {
  const myWords = introKeywords(building);
  if (myWords.length === 0) return null;
  const humans = (others || []).filter((u) => u && u.handle && !u.isAgent && !u.is_agent);
  let best = null;
  for (const u of humans) {
    const theirWords = introKeywords(introTopicText(u));
    const shared = myWords.filter((w) => theirWords.includes(w));
    if (shared.length === 0) continue;
    const recency = new Date(u.lastSeen || u.last_seen || 0).getTime() || 0;
    if (
      !best ||
      shared.length > best.score ||
      (shared.length === best.score && recency > best.recency)
    ) {
      best = { user: u, score: shared.length, shared, recency };
    }
  }
  if (!best) return null;
  return {
    handle: best.user.handle,
    shared: best.shared,
    opener: composeIntro(building, best.user, best.shared),
    related: true,
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Auth
  requireInit,

  // Handles
  normalizeHandle,
  displayHandle,

  // Presence freshness
  RECENT_HEARTBEAT_MS,
  isHereNow,

  // Time
  formatTimeAgo,
  formatDuration,

  // Text
  truncate,

  // Display
  header,
  divider,
  emptyState,
  success,
  warning,
  error,

  // API
  fetchRelevantUsers,

  // First-DM activation (dormant users)
  hasEverMessaged,
  markFirstDmSent,
  pickDormantTarget,
  firstDmNudge,

  // Received collaboration (topical intro on onboarding)
  introKeywords,
  composeIntro,
  pickRelatedTarget
};
