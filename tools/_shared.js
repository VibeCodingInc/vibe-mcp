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

module.exports = { requireInit, normalizeHandle, displayHandle, RECENT_HEARTBEAT_MS, isHereNow };
