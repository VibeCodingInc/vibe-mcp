/**
 * Shared utilities for MCP tools
 *
 * Consolidates common patterns:
 * - Init checking
 * - Handle normalization
 * - Time formatting
 * - Display formatting
 * - Error handling
 */

const config = require('../../config');

// ============ INIT CHECK ============

/**
 * Check if user is initialized, return early display if not
 * @returns {Object|null} - Display object if not initialized, null if OK
 */
function requireInit() {
  if (!config.isInitialized()) {
    return {
      display: 'Run `vibe init` first to set your identity.'
    };
  }
  return null;
}

/**
 * Wrapper that checks init before running handler
 * @param {Function} handler - The tool handler function
 * @returns {Function} - Wrapped handler
 */
function withInit(handler) {
  return async function(args) {
    const initCheck = requireInit();
    if (initCheck) return initCheck;
    return handler(args);
  };
}

// ============ HANDLE NORMALIZATION ============

/**
 * Normalize a handle (lowercase, no @)
 * @param {string} handle - Raw handle input
 * @returns {string} - Normalized handle
 */
function normalizeHandle(handle) {
  if (!handle) return '';
  return handle.toLowerCase().replace(/^@/, '').trim();
}

/**
 * Format a handle for display (with @)
 * @param {string} handle - Raw or normalized handle
 * @returns {string} - Display handle
 */
function displayHandle(handle) {
  const normalized = normalizeHandle(handle);
  return normalized ? `@${normalized}` : '';
}

// ============ TIME FORMATTING ============

/**
 * Format a timestamp as relative time
 * @param {number|Date|string} timestamp - Timestamp to format
 * @returns {string} - Relative time string
 */
function formatTimeAgo(timestamp) {
  if (timestamp === undefined || timestamp === null) return 'unknown';

  const now = Date.now();
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  if (isNaN(time)) return 'unknown';

  const seconds = Math.floor((now - time) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format a duration in milliseconds
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ============ DISPLAY FORMATTING ============

/**
 * Truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Max length (default 100)
 * @returns {string} - Truncated text
 */
function truncate(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Create a markdown header
 * @param {string} title - Header title
 * @param {number} level - Header level (1-6)
 * @returns {string} - Markdown header
 */
function header(title, level = 2) {
  return '#'.repeat(level) + ' ' + title;
}

/**
 * Create a markdown divider
 * @returns {string} - Markdown divider
 */
function divider() {
  return '\n---\n';
}

/**
 * Format an empty state message
 * @param {string} message - Empty state message
 * @param {string} hint - Optional hint/CTA
 * @returns {string} - Formatted empty state
 */
function emptyState(message, hint = null) {
  let display = `_${message}_`;
  if (hint) {
    display += `\n\n${hint}`;
  }
  return display;
}

/**
 * Format a success message
 * @param {string} action - What was done
 * @param {string} target - What it was done to
 * @returns {string} - Formatted success
 */
function success(action, target = null) {
  if (target) {
    return `✅ ${action} **${target}**`;
  }
  return `✅ ${action}`;
}

/**
 * Format a warning message
 * @param {string} message - Warning message
 * @returns {string} - Formatted warning
 */
function warning(message) {
  return `⚠️ ${message}`;
}

/**
 * Format an error message
 * @param {string} message - Error message
 * @returns {string} - Formatted error
 */
function error(message) {
  return `❌ ${message}`;
}

// ============ ERROR HANDLING ============

/**
 * Wrap a handler with error handling
 * @param {Function} handler - The tool handler function
 * @returns {Function} - Wrapped handler with try/catch
 */
function withErrorHandling(handler) {
  return async function(args) {
    try {
      return await handler(args);
    } catch (e) {
      return {
        display: error(`Something went wrong: ${e.message}`)
      };
    }
  };
}

/**
 * Combine multiple wrappers
 * @param  {...Function} wrappers - Wrapper functions to apply
 * @returns {Function} - Combined wrapper
 */
function compose(...wrappers) {
  return function(handler) {
    return wrappers.reduceRight((h, wrapper) => wrapper(h), handler);
  };
}

/**
 * Standard tool wrapper: init check + error handling
 */
const withDefaults = compose(withErrorHandling, withInit);

// ============ VALIDATION ============

/**
 * Validate required fields
 * @param {Object} args - Arguments object
 * @param {string[]} required - Required field names
 * @returns {Object|null} - Error display if validation fails, null if OK
 */
function validateRequired(args, required) {
  for (const field of required) {
    if (!args[field]) {
      return {
        display: error(`Missing required field: ${field}`)
      };
    }
  }
  return null;
}

module.exports = {
  // Init
  requireInit,
  withInit,

  // Handles
  normalizeHandle,
  displayHandle,

  // Time
  formatTimeAgo,
  formatDuration,

  // Display
  truncate,
  header,
  divider,
  emptyState,
  success,
  warning,
  error,

  // Error handling
  withErrorHandling,
  compose,
  withDefaults,

  // Validation
  validateRequired
};
