/**
 * Analytics — Retention event tracking from MCP server
 *
 * Logs events to the /api/analytics/event endpoint for measuring
 * user engagement and retention funnel performance.
 *
 * Usage:
 *   const analytics = require('./analytics');
 *   analytics.track('empty_inbox_action', { action: 'discover', source: 'inbox' });
 */

const config = require('./config');

const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

/**
 * Track an analytics event (fire and forget)
 * @param {string} eventType - Event type (from valid types in api/lib/events.js)
 * @param {object} data - Additional event data
 */
async function track(eventType, data = {}) {
  const handle = config.getHandle();
  if (!handle) return; // Skip if not initialized

  try {
    // Fire and forget - don't await or block
    fetch(`${API_URL}/api/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: eventType,
        handle,
        data: {
          ...data,
          client: 'mcp-server',
          timestamp: Date.now()
        }
      })
    }).catch(() => {}); // Silently ignore errors
  } catch (e) {
    // Analytics should never block or fail user flows
  }
}

/**
 * Track empty inbox interaction
 * @param {string} action - Which action was taken (or 'none' if user closed)
 * @param {object} context - Context about the state (hadOnboardingTask, hadRecentShips, etc.)
 */
function trackEmptyInbox(action, context = {}) {
  // Track that user reached empty inbox state
  track('empty_inbox_reached', {
    hadRecentThreads: context.recentThreads?.length > 0,
    hadOnboardingTask: !!context.onboardingTask,
    hadRecentShips: context.recentShips?.length > 0
  });

  // If an action was taken, track it
  if (action && action !== 'none') {
    track('empty_inbox_action', {
      action,
      ...context
    });
  }
}

/**
 * Track lurk mode state change
 * @param {boolean} enabled - Whether lurk mode was enabled or disabled
 */
function trackLurkMode(enabled) {
  track(enabled ? 'lurk_mode_enabled' : 'lurk_mode_disabled', {});
}

/**
 * Track onboarding task completion
 * @param {string} taskId - The task that was completed
 */
function trackOnboardingTask(taskId) {
  track('onboarding_task_completed', { taskId });
}

/**
 * Track discovery initiation
 * @param {string} source - Where discovery was initiated from (inbox, start, etc.)
 */
function trackDiscovery(source) {
  track('discovery_initiated', { source });
}

/**
 * Track session lifecycle
 * @param {string} event - 'started' or 'ended'
 * @param {object} sessionData - Session metrics (duration, actions, etc.)
 */
function trackSession(event, sessionData = {}) {
  track(event === 'started' ? 'session_started' : 'session_ended', sessionData);
}

/**
 * Track editor install via universal installer
 * @param {string} editor - Editor name configured
 * @param {string} status - 'configured', 'exists', 'error'
 */
function trackInstall(editor, status) {
  track('editor_install', {
    editor,
    status,
    platform: process.platform,
    node: process.version
  });
}

/**
 * Track tool usage distribution (called per tool invocation)
 * @param {string} toolName - Tool name (vibe_*)
 */
function trackToolUsage(toolName) {
  track('tool_call', { tool: toolName });
}

module.exports = {
  track,
  trackEmptyInbox,
  trackLurkMode,
  trackOnboardingTask,
  trackDiscovery,
  trackSession,
  trackInstall,
  trackToolUsage
};
