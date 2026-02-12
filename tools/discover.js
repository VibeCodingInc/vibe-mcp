/**
 * vibe discover — Find your people
 *
 * Smart matchmaking based on:
 * - What you're building (similar projects)
 * - What you've shipped (complementary skills)
 * - When you're active (timezone overlap)
 * - Shared interests (tags)
 *
 * Commands:
 * - discover suggest — Get personalized recommendations
 * - discover search <query> — Find people building specific things
 * - discover interests — Browse people by interest tags
 * - discover active — Show who's building similar things right now
 * - discover skills — Skills marketplace (absorbed from skills-exchange)
 * - discover partner — Find workshop partner (absorbed from workshop-buddy)
 */

const config = require('../config');
const store = require('../store');
const { formatTimeAgo, requireInit } = require('./_shared');

const definition = {
  name: 'vibe_discover',
  description: 'Find people building similar things. Commands: suggest, search, active.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['suggest', 'search', 'active'],
        description: 'Discovery command to run'
      },
      query: {
        type: 'string',
        description: 'Search query (for search command)'
      }
    }
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const command = args.command || 'suggest';

  let display = '';

  try {
    // Get active users + recently active for richer discovery
    const users = await store.getActiveUsers({ includeRecent: true });
    const recentUsers = users._recent || [];
    const others = users.filter(u => u.handle !== myHandle);
    const recentOthers = recentUsers.filter(u => u.handle !== myHandle);

    switch (command) {
      case 'suggest':
      case 'active': {
        if (others.length === 0 && recentOthers.length === 0) {
          display = `## Discover

_No one's been active recently. Be the first!_`;
        } else {
          if (others.length > 0) {
            display = `## Online Now\n\n`;
            for (const u of others) {
              display += `**@${u.handle}**\n`;
              display += `${u.note || u.one_liner || 'Building something'}\n`;
              display += `_${formatTimeAgo(u.lastSeen)}_\n\n`;
            }
          }
          if (recentOthers.length > 0) {
            display += others.length > 0 ? `---\n\n## Recently Active\n\n` : `## Recently Active\n\n`;
            for (const u of recentOthers.slice(0, 8)) {
              display += `○ **@${u.handle}** — ${u.one_liner || 'Building something'}\n`;
              display += `   _${formatTimeAgo(u.lastSeen)}_\n\n`;
            }
          }
          display += `Say "message @handle" to connect · "follow @handle" to add them`;
        }
        break;
      }

      case 'search': {
        if (!args.query) {
          return { display: 'Provide a search query: discover search "ai"' };
        }
        const q = args.query.toLowerCase();
        const matches = others.filter(u =>
          (u.note || u.one_liner || '').toLowerCase().includes(q) ||
          u.handle.toLowerCase().includes(q)
        );

        if (matches.length === 0) {
          display = `No one building "${args.query}" right now.`;
        } else {
          display = `## Building: "${args.query}"\n\n`;
          for (const u of matches) {
            display += `**@${u.handle}** — ${u.note || u.one_liner || 'Active'}\n`;
          }
        }
        break;
      }

      default:
        display = `## Discover Commands

**\`discover suggest\`** — See who's building right now
**\`discover search <query>\`** — Find people by what they're working on
**\`discover active\`** — Same as suggest`;
    }
  } catch (error) {
    display = `Discovery error: ${error.message}`;
  }

  return { display };
}

module.exports = { definition, handler };
