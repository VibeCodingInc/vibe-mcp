/**
 * vibe inbox — See your messages
 */

const config = require('../config');
const store = require('../store');
const notify = require('../notify');
const analytics = require('../analytics');
const { requireInit, header, emptyState, formatTimeAgo, truncate, divider } = require('./_shared');
const { actions, formatActions } = require('./_actions');

// Helper: Fetch recent ships for social proof (FOMO)
async function getRecentShips(limit = 2) {
  try {
    const apiUrl = config.getApiUrl();
    const response = await fetch(`${apiUrl}/api/board?limit=${limit}&category=shipped`);
    const data = await response.json();
    return (data.entries || []).map(e => ({
      author: e.author,
      content: e.content?.slice(0, 50)
    }));
  } catch (e) {
    return [];
  }
}

// Helper: Get next incomplete onboarding task
async function getNextOnboardingTask(handle) {
  try {
    const checklist = await store.getChecklistStatus(handle);
    if (checklist.success && checklist.tasks) {
      const nextTask = checklist.tasks.find(t => !t.done);
      if (nextTask) {
        // Map task IDs to user-friendly actions
        const taskActions = {
          'read_welcome': { shortLabel: 'Read welcome', command: 'check my messages', description: 'See your welcome message' },
          'reply_seth': { shortLabel: 'Reply to @vibe', command: 'message @vibe', description: 'Say hi back!' },
          'message_builder': { shortLabel: 'Message a builder', command: 'discover suggest', description: 'Find someone to connect with' },
          'post_ship': { shortLabel: 'Ship something', command: 'ship what I built', description: 'Share what you\'re building' },
          'leave_feedback': { shortLabel: 'Give feedback', command: 'talk to @echo', description: 'Help improve /vibe' }
        };
        return taskActions[nextTask.id] || null;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

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
    // Fetch context for retention-optimized actions (parallel for speed)
    const [recentShips, onboardingTask] = await Promise.all([
      getRecentShips(2),
      getNextOnboardingTask(myHandle)
    ]);

    // Build social proof line
    let socialProof = '';
    if (recentShips.length > 0) {
      socialProof = `\n   💫 @${recentShips[0].author} just shipped`;
    }

    // Build CTA based on onboarding state
    let cta = onboardingTask
      ? `→ ${onboardingTask.shortLabel}: "${onboardingTask.command}"`
      : 'Say "dm @someone" to start';

    // Track empty inbox state for retention analytics
    analytics.trackEmptyInbox('none', {
      recentThreads: [],
      recentShips,
      onboardingTask,
      state: 'no_messages'
    });

    return {
      display: `── 📭 Inbox ──────────────────────────
   No messages yet${socialProof}
   ${cta}
──────────────────────────────────────`,
      hint: 'suggest_compose',
      actions: formatActions(actions.emptyInbox({
        recentThreads: [],
        recentShips,
        onboardingTask
      }))
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

  // Handle case where all messages are read (no unread)
  if (totalUnread === 0) {
    const recentHandles = sorted.slice(0, 3).map(t => t.handle);
    const recentDisplay = recentHandles.map(h => `@${h}`).join(', ');

    // Fetch context for retention-optimized actions (parallel for speed)
    const [recentShips, onboardingTask] = await Promise.all([
      getRecentShips(2),
      getNextOnboardingTask(myHandle)
    ]);

    // Build social proof line
    let socialProof = '';
    if (recentShips.length > 0) {
      socialProof = `\n   💫 @${recentShips[0].author} just shipped`;
    }

    // Track empty inbox state for retention analytics
    analytics.trackEmptyInbox('none', {
      recentThreads: recentHandles,
      recentShips,
      onboardingTask,
      state: 'all_caught_up'
    });

    return {
      display: `── 📭 Inbox ──────────────────────────
   All caught up! Recent: ${recentDisplay}${socialProof}
──────────────────────────────────────`,
      hint: 'suggest_compose',
      actions: formatActions(actions.emptyInbox({
        recentThreads: recentHandles,
        recentShips,
        onboardingTask
      }))
    };
  }

  // Auto-open single unread message (skip inbox view to reduce friction)
  if (totalUnread === 1 && unreadSenders.length === 1) {
    const singleSender = unreadSenders[0];
    return {
      hint: 'auto_open_single_thread',
      handle: singleSender.handle,
      preview: truncate(singleSender.lastMessage || '', 60),
      display: `📬 Opening thread with @${singleSender.handle}...`
    };
  }

  // Build compact display (3 lines above the fold)
  // Line 1: Total count
  let display = `📬 ${totalUnread} unread message${totalUnread > 1 ? 's' : ''}\n`;

  // Line 2: Top 3 senders + overflow
  const top3Names = unreadSenders.slice(0, 3).map(t => `@${t.handle}`);
  const overflow = unreadSenders.length > 3 ? ` (+${unreadSenders.length - 3} more)` : '';
  display += `from ${top3Names.join(', ')}${overflow}\n`;

  // Line 3: Divider
  display += '───────────────────────────────────\n';

  // Line 4+: Expanded list with counts and badges
  const expanded = unreadSenders.map(t => {
    const agent = t.isAgent ? ' 🤖' : '';
    return `@${t.handle} (${t.unread})${agent}`;
  }).join(' • ');
  display += expanded;

  // Build response with optional hints for structured flows
  const response = { display };

  // Trigger triage flow when 5+ unread messages
  if (totalUnread >= 5) {
    response.hint = 'structured_triage_recommended';
    response.unread_count = totalUnread;
    response.threads = unreadSenders.map(t => ({
      handle: t.handle,
      unread: t.unread,
      preview: truncate(t.lastMessage || '', 40)
    }));
  }

  // Add guided mode actions with compact format
  const senderSummaries = unreadSenders.map(t => ({
    handle: t.handle,
    unread: t.unread || 0
  }));
  response.actions = formatActions(actions.afterInboxCompact(senderSummaries));

  return response;
}

module.exports = { definition, handler };
