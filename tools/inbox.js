/**
 * vibe inbox — See your messages
 */

const config = require('../config');
const store = require('../store');
const { requireInit, truncate } = require('./_shared');

const definition = {
  name: 'vibe_inbox',
  description: 'See your unread messages and recent threads.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const threads = await store.getInbox(myHandle);

  // Check for notifications (will handle deduplication internally)
  notify.checkAll(store);

  if (!threads || threads.length === 0) {
    return {
      display: `No messages yet. Say "dm @someone" to start a conversation.`
    };
  }

  // Sort: unread first, then by most recent
  const sorted = threads.sort((a, b) => {
    if (a.unread > 0 && b.unread === 0) return -1;
    if (b.unread > 0 && a.unread === 0) return 1;
    return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
  });

  const totalUnread = sorted.reduce((sum, t) => sum + (t.unread || 0), 0);
  const unreadSenders = sorted.filter(t => t.unread > 0);

  if (totalUnread === 0) {
    const recentHandles = sorted.slice(0, 3).map(t => `@${t.handle}`).join(', ');
    return {
      display: `All caught up. Recent: ${recentHandles}`
    };
  }

  // Build display
  let display = `📬 ${totalUnread} unread\n`;
  display += '───────────────────────────────────\n';

  for (const t of unreadSenders) {
    const preview = truncate(t.lastMessage || '', 60);
    display += `**@${t.handle}** (${t.unread}) — ${preview}\n`;
  }

  return { display };
}

module.exports = { definition, handler };
