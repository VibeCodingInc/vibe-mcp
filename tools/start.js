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

  // Get who's around (include recently active so room feels alive)
  const users = await store.getActiveUsers({ includeRecent: true });
  const recentUsers = users._recent || [];
  const others = users.filter(u => u.handle !== myHandle);

  // Check inbox + trigger notifications
  let unreadCount = 0;
  let recentShips = [];
  try {
    unreadCount = await store.getUnreadCount(myHandle);
    if (unreadCount > 0) {
      const rawInbox = await store.getRawInbox(myHandle).catch(() => []);
      if (rawInbox.length > 0) {
        notify.checkAndNotify(rawInbox);
      }
    }
    // Fetch recent ships for display
    recentShips = await store.getRecentShips(5).catch(() => []);
  } catch (e) {}

  // Build display: welcome card + activity
  let display = generateWelcomeCard({
    handle: myHandle,
    onlineCount: others.length,
    unreadCount
  });

  // Show recently active when room is sparse (< 3 online)
  const recentOthers = recentUsers.filter(u => u.handle !== myHandle);
  if (others.length < 3 && recentOthers.length > 0) {
    display += `\n\n**Suggested follows:**`;
    for (const u of recentOthers.slice(0, 3)) {
      display += `\n  ○ @${u.handle} — ${u.one_liner || 'Building something'}`;
    }
    display += `\n  _Say "follow @handle" to add them_`;
  }

  // Show recent ships from the community
  if (recentShips.length > 0) {
    display += `\n\n**Recently shipped:**`;
    for (const ship of recentShips.slice(0, 3)) {
      const what = ship.content?.slice(0, 60) || 'something new';
      display += `\n  🚀 @${ship.author} — ${what}`;
    }
  }

  const response = { display };

  // Suggest someone to connect with
  let suggestion = null;
  const interesting = others.find(u => {
    return u.lastSeen && Date.now() - u.lastSeen < 5 * 60 * 1000;
  });
  if (!interesting && recentOthers.length > 0) {
    // Suggest a recently active user when nobody's online
    suggestion = {
      handle: recentOthers[0].handle,
      reason: 'recently_active',
      context: recentOthers[0].one_liner || 'Building something'
    };
  } else if (interesting) {
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
