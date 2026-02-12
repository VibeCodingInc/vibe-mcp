/**
 * Shared action definitions for Guided Mode
 *
 * Actions get returned by tools and rendered as AskUserQuestion
 * by Claude Code, giving users a tab-able menu of next steps.
 */

const config = require('../config');

const actions = {
  // After vibe_start or vibe_who
  dashboard: (context = {}) => {
    const { unreadCount = 0, onlineUsers = [], suggestion } = context;
    const result = [];

    if (unreadCount > 0) {
      result.push({
        label: 'Check messages',
        description: `You have ${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`,
        command: 'check my messages'
      });
    }

    if (suggestion) {
      const reason = {
        just_joined: 'just joined',
        shipping: 'is shipping',
        needs_help: 'might need help',
        active_now: 'is active'
      }[suggestion.reason] || 'is around';

      result.push({
        label: `Message @${suggestion.handle}`,
        description: `${suggestion.handle} ${reason}`,
        command: `message @${suggestion.handle}`
      });
    }

    if (!suggestion && onlineUsers.length > 0) {
      result.push({
        label: `Message @${onlineUsers[0]}`,
        description: 'Start a conversation',
        command: `message @${onlineUsers[0]}`
      });
    }

    result.push({
      label: 'Set status',
      description: 'shipping, thinking, debugging, etc.',
      command: 'set my status'
    });

    return result.slice(0, 4);
  },

  // When room is empty
  emptyRoom: () => [
    {
      label: 'Find connections',
      description: 'Discover builders with similar interests',
      command: 'discover suggest'
    },
    {
      label: 'Ship something',
      description: 'Share what you built',
      command: 'ship something'
    }
  ]
};

// Format actions for the response object
function formatActions(actionList) {
  if (!config.getGuidedMode()) return null;
  if (!actionList || actionList.length === 0) return null;

  return {
    guided_mode: true,
    question: 'What do you want to do?',
    options: actionList.map(a => ({
      label: a.label,
      description: a.description,
      command: a.command
    }))
  };
}

module.exports = { actions, formatActions };
