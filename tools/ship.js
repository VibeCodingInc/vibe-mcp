/**
 * vibe ship — Announce what you just shipped
 *
 * Share your wins with the community and update your profile.
 * Tracks your shipping history for better discovery matches.
 *
 * Usage:
 * - ship "Built a new feature for my AI chat app"
 * - ship "Deployed my portfolio website"
 * - ship "Published blog post about React patterns"
 */

const config = require('../config');
const { requireInit } = require('./_shared');

const definition = {
  name: 'vibe_ship',
  description: 'Announce something you just shipped to the community board and update your profile.',
  inputSchema: {
    type: 'object',
    properties: {
      what: {
        type: 'string',
        description: 'What you shipped (brief description)'
      },
      url: {
        type: 'string',
        description: 'URL to your ship (deployed site, repo, demo)'
      },
      inspired_by: {
        type: 'string',
        description: 'Handle of person who inspired this (@alice)'
      },
      for_request: {
        type: 'string',
        description: 'Request ID this fulfills (if building for someone)'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for discovery (e.g., ["ai", "mcp", "tools"])'
      }
    },
    required: ['what']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  if (!args.what) {
    return { error: 'Please tell us what you shipped: ship "Built a new feature"' };
  }

  const myHandle = config.getHandle();
  const apiUrl = config.getApiUrl();

  try {
    // Build rich content with metadata
    let content = args.what;
    const metaParts = [];

    if (args.url) {
      metaParts.push(`🔗 ${args.url}`);
    }
    if (args.inspired_by) {
      const inspiree = args.inspired_by.replace('@', '').toLowerCase();
      metaParts.push(`✨ inspired by @${inspiree}`);
    }
    if (args.for_request) {
      metaParts.push(`📋 fulfills ${args.for_request}`);
    }

    if (metaParts.length > 0) {
      content += '\n' + metaParts.join(' | ');
    }

    // Build tags with attribution
    const tags = args.tags || [];
    if (args.inspired_by) {
      tags.push(`inspired:${args.inspired_by.replace('@', '')}`);
    }
    if (args.for_request) {
      tags.push(`fulfills:${args.for_request}`);
    }

    // Post to board
    const response = await fetch(`${apiUrl}/api/board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: myHandle,
        content,
        category: 'shipped',
        tags
      })
    });

    const data = await response.json();

    if (!data.success) {
      return { display: `⚠️ Failed to announce ship: ${data.error}` };
    }

    let display = `🚀 shipped\n\n${args.what}`;

    if (args.url) {
      display += `\n${args.url}`;
    }
    if (args.inspired_by) {
      display += `\n_via @${args.inspired_by.replace('@', '')}_`;
    }

    // Generate share-ready tweet
    const tweetParts = [`Just shipped: ${args.what} 🚀`];
    if (args.url) tweetParts.push(args.url);
    tweetParts.push('#vibecoding');
    const tweet = tweetParts.join(' ');

    display += `\n\n---\n📋 **Share it:**\n\`${tweet}\``;

    return { display };

  } catch (error) {
    return { display: `## Ship Error\n\n${error.message}` };
  }
}

module.exports = { definition, handler };