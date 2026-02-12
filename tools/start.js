/**
 * vibe start — "let's vibe" entry point
 *
 * 1. Init if needed (prompts for handle)
 * 2. Show who's around
 * 3. Check inbox
 */

const config = require('../config');
const store = require('../store');
const notify = require('../notify');
const { actions, formatActions } = require('./_actions');
const init = require('./init');

/**
 * Generate ASCII welcome card
 */
function generateWelcomeCard({ handle, onlineCount, unreadCount }) {
  const handleCol = `@${handle}`.padEnd(16);
  const unreadCol = unreadCount > 0 ? `📬 ${unreadCount} unread`.padEnd(14) : `📬 0 messages`.padEnd(14);

  return `  █░█ █ █▄▄ █▀▀   ${handleCol}  🚀 ship together
  ▀▄▀ █ █▄█ ██▄   ${unreadCol}  🟢 ${onlineCount} online
  ──────────────────────────────────────────────────`;
}

const definition = {
  name: 'vibe_start',
  description: 'Start socializing on /vibe. Use when user says "let\'s vibe", "start vibing", "who\'s around", or wants to connect with others.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Your handle (use your X/Twitter handle). Only needed if not already initialized.'
      },
      building: {
        type: 'string',
        description: 'What you\'re working on (one line). Only needed if not already initialized.'
      }
    }
  }
};

async function handler(args) {
  // If not authenticated, redirect to init for GitHub auth flow
  if (!config.hasPrivyAuth()) {
    return init.handler({
      handle: args.handle,
      one_liner: args.building
    });
  }

  const myHandle = config.getHandle();

  // Get who's around
  const users = await store.getActiveUsers();
  const others = users.filter(u => u.handle !== myHandle);

  // Check inbox + trigger notifications
  let unreadCount = 0;
  try {
    unreadCount = await store.getUnreadCount(myHandle);
    if (unreadCount > 0) {
      const rawInbox = await store.getRawInbox(myHandle).catch(() => []);
      if (rawInbox.length > 0) {
        notify.checkAndNotify(rawInbox);
      }
    }
  } catch (e) {}

  const display = generateWelcomeCard({
    handle: myHandle,
    onlineCount: others.length,
    unreadCount
  });

  const response = { display };

  // Suggest someone to connect with
  let suggestion = null;
  const interesting = others.find(u => {
    return u.lastSeen && Date.now() - u.lastSeen < 5 * 60 * 1000;
  });
  if (interesting) {
    suggestion = {
      handle: interesting.handle,
      reason: 'active_now',
      context: interesting.note || interesting.one_liner || 'Building something'
    };
  }

  // Add guided mode actions
  const onlineHandles = others.map(u => u.handle);
  const actionList = (others.length === 0 && unreadCount === 0)
    ? actions.emptyRoom()
    : actions.dashboard({ unreadCount, onlineUsers: onlineHandles, suggestion });

  response.actions = formatActions(actionList);

  return response;
}

module.exports = { definition, handler };
