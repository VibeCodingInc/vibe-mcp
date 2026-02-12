/**
 * vibe who — See who's around
 *
 * Shows who's online with activity heat and context.
 * Intelligence layer infers builder states from signals.
 */

const config = require('../config');
const store = require('../store');
const notify = require('../notify');
const { formatTimeAgo, requireInit } = require('./_shared');
const { actions, formatActions } = require('./_actions');
const { enhanceUsersWithInference } = require('../intelligence/infer');
const { getTopSerendipity } = require('../intelligence/serendipity');

const definition = {
  name: 'vibe_who',
  description: 'See who\'s online and what they\'re building.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Activity heat based on session signals + GitHub activity
function getHeat(user) {
  const now = Date.now();
  const minutesAgo = (now - user.lastSeen) / 60000;

  // Just joined
  if (user.firstSeen) {
    const sessionDuration = (user.lastSeen - new Date(user.firstSeen).getTime()) / 60000;
    if (sessionDuration < 5 && minutesAgo < 2) {
      return { icon: '✨', label: 'just joined' };
    }
  }

  // GitHub activity signals
  if (user.github?.shipping_mode === 'hot') {
    const commits = user.github.total_commits || 0;
    return { icon: '🔥', label: commits > 0 ? `shipping code (${commits} commits)` : 'shipping code' };
  }
  if (user.github?.shipping_mode === 'active') {
    return { icon: '⚡', label: 'pushing commits' };
  }

  // Inferred state from smart detection
  if (user.mood_inferred && user.mood) {
    return { icon: user.mood, label: user.inferred_state?.replace('-', ' ') || 'active' };
  }

  // Explicit mood
  if (user.mood === '🔥' || user.mood === '🚀') return { icon: '🔥', label: 'shipping' };
  if (user.mood === '🐛') return { icon: '🐛', label: 'debugging' };
  if (user.mood === '🌙') return { icon: '🌙', label: 'late night' };
  if (user.mood === '🧠') return { icon: '🧠', label: 'deep work' };

  // Builder mode
  if (user.builderMode === 'deep-focus') return { icon: '🧠', label: 'deep focus' };
  if (user.builderMode === 'shipping') return { icon: '🔥', label: 'shipping' };

  // GitHub building
  if (user.github?.shipping_mode === 'building') return { icon: '🔨', label: 'building' };

  // Default based on recency
  if (minutesAgo < 2) return { icon: '⚡', label: 'active' };
  if (minutesAgo < 10) return { icon: '●', label: null };
  return { icon: '○', label: 'idle' };
}

// Format user's current activity
function formatActivity(user) {
  const parts = [];
  if (user.file) parts.push(user.file);
  if (user.branch && user.branch !== 'main' && user.branch !== 'master') {
    parts.push(`(${user.branch})`);
  }

  if (user.error) {
    return `⚠️ _stuck on: ${user.error.slice(0, 50)}${user.error.length > 50 ? '...' : ''}_`;
  }
  if (user.note && parts.length > 0) return `${parts.join(' ')} — _"${user.note}"_`;
  if (user.note) return `_"${user.note}"_`;
  if (parts.length > 0) return parts.join(' ');

  if (user.github?.active_repos?.length > 0) {
    const repoNames = user.github.active_repos.slice(0, 2).map(r => r.split('/').pop());
    return `pushing to ${repoNames.join(', ')}`;
  }

  return user.one_liner || 'Building something';
}

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const rawUsers = await store.getActiveUsers({ includeRecent: true });
  const recentUsers = rawUsers._recent || [];
  const users = enhanceUsersWithInference(rawUsers);
  const myHandle = config.getHandle();

  notify.checkAll(store);

  if (users.length === 0 && recentUsers.length === 0) {
    return { display: `## Who's Around\n\n_No one's here right now. Check back later._` };
  }

  const sorted = [...users].sort((a, b) => b.lastSeen - a.lastSeen);
  const active = sorted.filter(u => u.status === 'active');
  const away = sorted.filter(u => u.status !== 'active');

  let display = `## Who's Around\n\n`;

  for (const u of active) {
    const isMe = u.handle === myHandle;
    const tag = isMe ? ' _(you)_' : '';
    const agentBadge = u.is_agent ? ' 🤖' : '';
    const heat = getHeat(u);
    const heatLabel = heat.label ? ` ${heat.label}` : '';

    display += `${heat.icon} **@${u.handle}**${agentBadge}${tag}${heatLabel}\n`;
    if (u.is_agent && u.operator) display += `   _(op: @${u.operator})_\n`;
    display += `   ${formatActivity(u)}\n`;
    display += `   _${formatTimeAgo(u.lastSeen)}_\n\n`;
  }

  if (away.length > 0) {
    display += `---\n\n**Away:**\n`;
    for (const u of away) {
      const tag = u.handle === myHandle ? ' _(you)_' : '';
      if (u.awayMessage) {
        display += `☕ **@${u.handle}**${tag} — _"${u.awayMessage}"_\n`;
      } else {
        display += `💤 **@${u.handle}**${tag} _(auto-away)_\n`;
      }
      display += `   _${formatTimeAgo(u.lastSeen)}_\n\n`;
    }
  }

  // Recently active (2h-24h window) — so the room never feels empty
  const recentOthers = recentUsers.filter(u => u.handle !== myHandle);
  if (recentOthers.length > 0) {
    display += `---\n\n**Recently Active:**\n`;
    for (const u of recentOthers.slice(0, 5)) {
      display += `○ **@${u.handle}** — ${u.one_liner || 'Building something'}\n`;
      display += `   _${formatTimeAgo(u.lastSeen)}_\n\n`;
    }
  }

  display += `---\nSay "message @handle" to reach someone`;

  // Unread notice
  try {
    const unread = await store.getUnreadCount(myHandle);
    if (unread > 0) {
      display += `\n\n📬 **${unread} UNREAD** — \`vibe inbox\``;
    }
  } catch (e) {}

  const response = { display };

  // Serendipity — quiet awareness of interesting overlaps
  const myUser = users.find(u => u.handle === myHandle);
  if (myUser && active.length > 1) {
    const serendipity = getTopSerendipity(myUser, active);
    if (serendipity && serendipity.relevance > 0.75) {
      response.serendipity = serendipity;
    }
  }

  // Guided mode actions
  const onlineHandles = active.filter(u => u.handle !== myHandle).map(u => u.handle);
  const unreadCount = await store.getUnreadCount(myHandle).catch(() => 0);

  if (active.length === 0 || (active.length === 1 && active[0].handle === myHandle)) {
    response.actions = formatActions(actions.emptyRoom());
  } else {
    response.actions = formatActions(actions.dashboard({ unreadCount, onlineUsers: onlineHandles }));
  }

  return response;
}

module.exports = { definition, handler };
