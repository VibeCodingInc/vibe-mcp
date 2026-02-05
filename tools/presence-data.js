/**
 * vibe_presence_data — Structured presence data for MCP Apps widget
 *
 * App-only tool (visibility: ['app']) — the LLM never sees this.
 * Returns JSON that the presence widget polls every 30s.
 */

const config = require('../config');
const store = require('../store');
const { enhanceUsersWithInference } = require('../intelligence/infer');

const definition = {
  name: 'vibe_presence_data',
  description: 'Structured presence data for the presence widget.',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  _meta: {
    ui: { visibility: ['app'] }
  }
};

// Activity heat — same logic as who.js but returns a simple label
function getHeatLabel(user) {
  const now = Date.now();
  const minutesAgo = (now - user.lastSeen) / 60000;

  if (user.github?.shipping_mode === 'hot') {
    const commits = user.github.total_commits || 0;
    return commits > 0 ? `shipping code (${commits} commits)` : 'shipping code';
  }
  if (user.github?.shipping_mode === 'active') return 'pushing commits';
  if (user.mood === '🔥' || user.mood === '🚀') return 'shipping';
  if (user.mood === '🐛') return 'debugging';
  if (user.mood === '🌙') return 'late night';
  if (user.mood === '🧠') return 'deep work';
  if (user.builderMode === 'deep-focus') return 'deep focus';
  if (user.builderMode === 'shipping') return 'shipping';
  if (user.github?.shipping_mode === 'building') return 'building';
  if (minutesAgo < 2) return 'active';
  if (minutesAgo < 10) return 'online';
  return 'idle';
}

function formatActivity(user) {
  if (user.error) return user.error.slice(0, 80);
  const parts = [];
  if (user.file) parts.push(user.file);
  if (user.branch && user.branch !== 'main' && user.branch !== 'master') {
    parts.push(`(${user.branch})`);
  }
  if (user.note && parts.length > 0) return `${parts.join(' ')} — ${user.note}`;
  if (user.note) return user.note;
  if (parts.length > 0) return parts.join(' ');
  if (user.github?.active_repos?.length > 0) {
    const repos = user.github.active_repos.slice(0, 2).map(r => r.split('/').pop());
    return `pushing to ${repos.join(', ')}`;
  }
  return user.one_liner || '';
}

async function handler() {
  const isAuthed = config.isInitialized();
  const myHandle = isAuthed ? config.getHandle() : null;

  const rawUsers = await store.getActiveUsers();
  const users = enhanceUsersWithInference(rawUsers);

  const sorted = [...users].sort((a, b) => b.lastSeen - a.lastSeen);

  let unreadCount = 0;
  if (myHandle) {
    try {
      unreadCount = await store.getUnreadCount(myHandle);
    } catch (e) { /* best-effort */ }
  }

  const structured = {
    users: sorted.map(u => ({
      handle: u.handle,
      status: u.status || 'active',
      mood: u.mood || null,
      activity: formatActivity(u),
      heat: getHeatLabel(u),
      file: u.file || null,
      branch: u.branch || null,
      lastSeen: u.lastSeen,
      isAgent: !!u.is_agent,
      awayMessage: u.awayMessage || null
    })),
    unreadCount,
    myHandle
  };

  return {
    display: JSON.stringify(structured),
    _structured: structured
  };
}

module.exports = { definition, handler };
