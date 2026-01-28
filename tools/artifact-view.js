/**
 * vibe_view_artifact - View or list artifacts
 *
 * View specific artifacts or list artifacts you created or that were created for you
 */

const config = require('../config');
const store = require('../store');
const { requireInit } = require('./_shared');

/**
 * Helper function to get artifact by slug (for use in other tools)
 * @param {string} slug - Artifact slug
 * @returns {Promise<Object|null>} - Artifact object or null if not found
 */
async function getArtifactBySlug(slug) {
  try {
    // Try to get artifact from store
    const result = await store.getArtifact(slug);
    if (result.success && result.artifact) {
      return result.artifact;
    }

    // Fallback: search through network artifacts
    const myHandle = config.getHandle();
    const artifacts = await store.getArtifacts('network', myHandle, 50);
    if (artifacts.success && artifacts.artifacts) {
      const found = artifacts.artifacts.find(a => a.slug === slug);
      if (found) {
        return found;
      }
    }

    return null;
  } catch (error) {
    console.error('Error fetching artifact:', error);
    return null;
  }
}

const definition = {
  name: 'vibe_view_artifact',
  description: 'View a specific artifact or list artifacts (mine, for-me, network)',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Artifact slug to view (e.g., "pizza-for-stan")'
      },
      list: {
        type: 'string',
        enum: ['mine', 'for-me', 'network'],
        description: 'List artifacts: mine (created by you), for-me (created for you), network (visible to you)'
      },
      limit: {
        type: 'number',
        description: 'Max number of artifacts to show when listing (default: 10)'
      }
    }
  }
};

function formatArtifact(artifact) {
  let output = `\n**${artifact.title}**\n`;
  output += `📦 ${artifact.template} artifact\n`;
  output += `👤 Created by @${artifact.created_by}`;
  if (artifact.created_for) {
    output += ` for @${artifact.created_for}`;
  }
  output += `\n`;
  output += `🔗 https://slashvibe.dev/a/${artifact.slug}\n`;
  output += `📅 ${new Date(artifact.created_at).toLocaleString()}\n`;

  if (artifact.expires_at) {
    const expiryDate = new Date(artifact.expires_at);
    const now = new Date();
    const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    output += `⏰ Expires in ${daysLeft} days\n`;
  }

  output += `\n**Content Preview:**\n`;
  const firstBlocks = artifact.content.blocks.slice(0, 3);
  for (const block of firstBlocks) {
    if (block.type === 'heading') {
      output += `\n## ${block.text}\n`;
    } else if (block.type === 'paragraph') {
      output += `${block.markdown.substring(0, 150)}${block.markdown.length > 150 ? '...' : ''}\n`;
    } else if (block.type === 'places' && block.items) {
      output += `\n📍 ${block.items.length} places\n`;
    } else if (block.type === 'checklist' && block.items) {
      output += `\n☑️  ${block.items.length} action items\n`;
    }
  }

  return output;
}

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { slug, list, limit = 10 } = args;
  const myHandle = config.getHandle();

  // View specific artifact
  if (slug) {
    const result = await store.getArtifact(slug);

    if (!result.success) {
      return {
        display: `❌ Artifact not found: ${slug}`
      };
    }

    const artifact = result.artifact;

    // Check permissions
    if (artifact.visibility === 'unlisted' && !artifact.audience.includes(myHandle)) {
      return {
        display: `❌ You don't have permission to view this artifact`
      };
    }

    return {
      display: formatArtifact(artifact)
    };
  }

  // List artifacts
  if (list) {
    const result = await store.listArtifacts({
      scope: list,
      handle: myHandle,
      limit
    });

    if (!result.success) {
      return {
        display: `❌ Failed to list artifacts: ${result.error}`
      };
    }

    const artifacts = result.artifacts;

    if (artifacts.length === 0) {
      const messages = {
        mine: "You haven't created any artifacts yet.",
        'for-me': 'No artifacts have been created for you yet.',
        network: 'No artifacts visible in your network yet.'
      };
      return {
        display: `📦 ${messages[list]}\n\nCreate one with \`vibe_create_artifact\``
      };
    }

    let display = `📦 **${list === 'mine' ? 'Your Artifacts' : list === 'for-me' ? 'Artifacts for You' : 'Network Artifacts'}**\n`;
    display += `Found ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}\n`;
    display += `\n${'─'.repeat(50)}\n`;

    for (const artifact of artifacts) {
      display += formatArtifact(artifact);
      display += `\n${'─'.repeat(50)}\n`;
    }

    return { display };
  }

  return {
    display: '❌ Must provide either `slug` to view or `list` to browse artifacts'
  };
}

module.exports = { definition, handler, getArtifactBySlug };
