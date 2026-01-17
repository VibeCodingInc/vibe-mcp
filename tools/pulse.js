/**
 * vibe pulse — Lightweight presence check for inline display
 *
 * Returns a compact "mini card" showing who's online.
 * Designed to be called periodically by Claude based on CLAUDE.md instructions.
 *
 * Unlike vibe_who (full presence), this is:
 * - Faster (minimal data)
 * - Compact (fits in a response footer)
 * - Suggestive (gentle nudges to connect)
 */

const config = require('../config');
const store = require('../store');

const definition = {
  name: 'vibe_pulse',
  description: 'Quick presence check for inline display. Returns compact mini card showing who\'s online. Call periodically (~every 5 messages) to maintain ambient awareness.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Gentle nudge templates
const NUDGES = {
  just_joined: [
    "{handle} just joined — say hi?",
    "{handle} is here! Quick wave?",
    "New face: {handle} just arrived"
  ],
  shipping: [
    "{handle} is shipping — cheer them on?",
    "{handle} in flow mode 🔥"
  ],
  debugging: [
    "{handle} debugging — maybe you can help?",
    "{handle} stuck on something"
  ],
  active: [
    "{handle} is around",
    "{handle} building right now"
  ],
  multiple: [
    "{count} builders online — you're not alone",
    "{count} people vibing right now",
    "Room's alive: {count} online"
  ]
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatNudge(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(`{${key}}`, value);
  }
  return result;
}

function getStatusEmoji(user) {
  // Explicit mood takes priority
  if (user.mood === '🔥' || user.mood === 'shipping') return '🔥';
  if (user.mood === '🐛' || user.mood === 'debugging') return '🐛';
  if (user.mood === '🧠' || user.mood === 'thinking') return '🧠';
  if (user.mood === '🎉' || user.mood === 'celebrating') return '🎉';
  if (user.mood === '🎧') return '🎧';
  if (user.mood === '☕') return '☕';

  // Infer from what they're building (one_liner)
  const workingOn = (user.one_liner || '').toLowerCase();
  if (workingOn.includes('ai') || workingOn.includes('agent') || workingOn.includes('llm')) return '🤖';
  if (workingOn.includes('creative') || workingOn.includes('art') || workingOn.includes('design')) return '🎨';
  if (workingOn.includes('game') || workingOn.includes('chess') || workingOn.includes('play')) return '🎮';
  if (workingOn.includes('social') || workingOn.includes('chat') || workingOn.includes('message')) return '💬';
  if (workingOn.includes('crypto') || workingOn.includes('web3') || workingOn.includes('token')) return '⛓️';
  if (workingOn.includes('tool') || workingOn.includes('platform') || workingOn.includes('infra')) return '🛠️';
  if (workingOn.includes('mobile') || workingOn.includes('app')) return '📱';
  if (workingOn.includes('data') || workingOn.includes('analytics')) return '📊';

  // Infer from builderMode
  if (user.builderMode === 'deep-focus') return '🧘';
  if (user.builderMode === 'shipping') return '🚀';
  if (user.builderMode === 'exploring') return '🔍';
  if (user.builderMode === 'focused') return '💻';

  // Fallback to recency
  const age = Date.now() - user.lastSeen;
  if (age < 2 * 60 * 1000) return '⚡'; // Active < 2min
  if (age < 5 * 60 * 1000) return '●';  // Recent < 5min
  return '○'; // Idle
}

function getUserState(user) {
  const age = Date.now() - user.lastSeen;

  // Check for just joined (< 2 min session)
  if (user.firstSeen) {
    const sessionDuration = (user.lastSeen - new Date(user.firstSeen).getTime()) / 60000;
    if (sessionDuration < 2 && age < 2 * 60 * 1000) {
      return 'just_joined';
    }
  }

  if (user.mood === '🔥' || user.mood === 'shipping') return 'shipping';
  if (user.mood === '🐛' || user.mood === 'debugging') return 'debugging';

  return 'active';
}

async function handler(args) {
  // Check if initialized
  if (!config.isInitialized()) {
    return {
      display: null,
      empty: true,
      reason: 'not_initialized'
    };
  }

  const myHandle = config.getHandle();

  // Fetch presence and unread (wrap in Promise.resolve for local store compat)
  const [users, unreadCount] = await Promise.all([
    Promise.resolve(store.getActiveUsers()).catch(() => []),
    Promise.resolve(store.getUnreadCount(myHandle)).catch(() => 0)
  ]);

  const others = users.filter(u => u.handle !== myHandle);

  // Empty room
  if (others.length === 0 && unreadCount === 0) {
    return {
      display: null,
      empty: true,
      reason: 'no_one_online'
    };
  }

  // Smart truncate: break at word boundary, add ellipsis if truncated
  function smartTruncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    // Find last space before maxLen
    const truncated = text.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.6) {
      // Break at word if we're not losing too much
      return truncated.slice(0, lastSpace) + '…';
    }
    return truncated.slice(0, maxLen - 1) + '…';
  }

  // Get short status label from what they're working on
  function getStatusLabel(user) {
    if (user.mood === '🔥' || user.mood === 'shipping') return 'shipping';
    if (user.mood === '🐛' || user.mood === 'debugging') return 'debugging';
    if (user.mood === '🧠' || user.mood === 'thinking') return 'thinking';
    if (user.mood === '🎉' || user.mood === 'celebrating') return 'shipped!';
    if (user.mood === '👥' || user.mood === 'pairing') return 'pairing';
    if (user.mood === '🎧') return 'vibing';
    if (user.note) return smartTruncate(user.note, 28);
    if (user.one_liner) return smartTruncate(user.one_liner, 28);
    return '';
  }

  // Build compact single-line summary optimized for collapsed view
  // This ONE line must contain all key info since details get hidden
  const topUsers = others.slice(0, 4);
  const userChips = topUsers.map(u => `${getStatusEmoji(u)} ${u.handle}`).join(' · ');
  const moreCount = others.length > 4 ? ` +${others.length - 4}` : '';
  const dmsBadge = unreadCount > 0 ? `📬 ${unreadCount} · ` : '';

  // Single summary line with all key info
  let display = `${dmsBadge}☕ ${others.length} online — ${userChips}${moreCount}`;

  // Generate nudge
  let nudge = null;
  if (others.length > 0) {
    // Find most interesting user for nudge
    const states = others.map(u => ({ user: u, state: getUserState(u) }));

    // Priority: just_joined > shipping > debugging > active
    const priority = ['just_joined', 'shipping', 'debugging', 'active'];
    let picked = null;

    for (const state of priority) {
      picked = states.find(s => s.state === state);
      if (picked) break;
    }

    if (picked) {
      const templates = NUDGES[picked.state] || NUDGES.active;
      nudge = formatNudge(pickRandom(templates), {
        handle: `@${picked.user.handle}`,
        count: others.length
      });
    } else if (others.length >= 2) {
      nudge = formatNudge(pickRandom(NUDGES.multiple), { count: others.length });
    }
  }

  // Add nudge after details
  if (nudge) {
    display += `\n\n_${nudge}_`;
  }

  return {
    display,
    online_count: others.length,
    unread_count: unreadCount,
    nudge,
    handles: others.slice(0, 5).map(u => u.handle)
  };
}

module.exports = { definition, handler };
