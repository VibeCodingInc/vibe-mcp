/**
 * vibe watch/live — Watch broadcasts and see who's live
 *
 * vibe_watch: Watch a specific user's broadcast
 * vibe_live: List all active broadcasts with viewer counts
 */

const { requireInit, normalizeHandle, formatTimeAgo } = require('./_shared');
const config = require('../config');
const store = require('../store');

const watchDefinition = {
  name: 'vibe_watch',
  description: "Check if someone is broadcasting live and get their stream info. If they're live, returns a watch link and engagement stats.",
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to watch (e.g., @stan)'
      }
    },
    required: ['handle']
  }
};

const liveDefinition = {
  name: 'vibe_live',
  description: 'List all active broadcasts with viewer counts. See who is live right now.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

async function watchHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const them = normalizeHandle(args.handle);

  // Get all live broadcasts and find this user
  const result = await store.getLiveBroadcasts();

  if (result.success === false) {
    return { display: `Failed to check live status: ${result.error || 'Unknown error'}` };
  }

  const broadcasts = result.broadcasts || [];
  const broadcast = broadcasts.find(b => b.handle === them);

  if (!broadcast) {
    // Not live — check if they have an upcoming session
    const upcoming = (result.upcoming || []).find(u => u.handle === them);

    let display = `**@${them}** is not broadcasting right now.`;

    if (upcoming) {
      const when = new Date(upcoming.scheduledFor);
      const rsvp = upcoming.rsvpCount || 0;
      display += `\n\nNext scheduled session: **${upcoming.title || 'Untitled'}**`;
      display += `\nWhen: ${when.toLocaleString()}`;
      if (rsvp > 0) display += ` (${rsvp} RSVPs)`;
    }

    display += `\n\nTry \`vibe live\` to see who's broadcasting now.`;
    return { display };
  }

  // They're live — get metrics for richer display
  let metrics = null;
  try {
    metrics = await store.getBroadcastMetrics(broadcast.roomId);
  } catch (e) {
    // Metrics are best-effort
  }

  const duration = broadcast.duration || 0;
  const durationMin = Math.floor(duration / 60);
  const viewers = broadcast.viewers || broadcast.viewerCount || 0;
  const watchUrl = `https://slashvibe.dev/watch/${broadcast.roomId}`;

  let display = `## @${them} is LIVE\n\n`;
  display += `**Watch:** ${watchUrl}\n\n`;
  display += `Viewers: **${viewers}**`;
  if (durationMin > 0) {
    display += ` | Duration: ${durationMin}m`;
  }

  // Add engagement metrics if available
  if (metrics && metrics.success !== false) {
    const engagement = metrics.engagement || {};
    const chat = metrics.chat || {};
    const reactions = metrics.reactions || {};

    if (engagement.score) {
      display += ` | Engagement: ${engagement.score}/100`;
    }
    if (chat.total > 0) {
      display += `\nChat: ${chat.total} messages`;
    }
    if (reactions.total > 0) {
      display += `\nReactions: ${reactions.total}`;
      // Show top reactions
      const breakdown = reactions.breakdown || {};
      const topReactions = Object.entries(breakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ');
      if (topReactions) display += ` (${topReactions})`;
    }
  }

  display += `\n\nOpen the link above to watch their terminal live.`;

  return { display };
}

async function liveHandler() {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const result = await store.getLiveBroadcasts();

  if (result.success === false) {
    return { display: `Failed to get live broadcasts: ${result.error || 'Unknown error'}` };
  }

  const broadcasts = result.broadcasts || [];
  const upcoming = result.upcoming || [];

  if (broadcasts.length === 0 && upcoming.length === 0) {
    return {
      display: `## Live Now\n\n_No one is broadcasting right now._\n\nStart your own: The terminal app (vibe-terminal) supports broadcasting.\nOr check back later — builders come and go.`
    };
  }

  let display = `## Live Now\n\n`;

  if (broadcasts.length === 0) {
    display += `_No active broadcasts._\n\n`;
  } else {
    for (const b of broadcasts) {
      const viewers = b.viewers || b.viewerCount || 0;
      const durationMin = Math.floor((b.duration || 0) / 60);
      const watchUrl = `https://slashvibe.dev/watch/${b.roomId}`;

      display += `**@${b.handle}** — ${viewers} viewer${viewers !== 1 ? 's' : ''}`;
      if (durationMin > 0) display += ` | ${durationMin}m`;
      display += `\n`;
      display += `Watch: ${watchUrl}\n\n`;
    }
  }

  if (upcoming.length > 0) {
    display += `---\n\n**Upcoming:**\n\n`;
    for (const u of upcoming) {
      const when = new Date(u.scheduledFor);
      const rsvp = u.rsvpCount || 0;
      display += `**@${u.handle}** — ${u.title || 'Untitled'}`;
      display += `\n${when.toLocaleString()}`;
      if (rsvp > 0) display += ` (${rsvp} RSVPs)`;
      display += `\n\n`;
    }
  }

  display += `---\n`;
  display += `Watch someone: \`vibe watch @handle\``;

  return { display };
}

module.exports = {
  watch: { definition: watchDefinition, handler: watchHandler },
  live: { definition: liveDefinition, handler: liveHandler }
};
