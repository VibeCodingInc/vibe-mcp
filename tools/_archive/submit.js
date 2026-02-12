/**
 * vibe submit — Submit a project to vibecodings directory
 */

const config = require('../config');

const VIBECODINGS_API = 'https://vibecodings.vercel.app/api/projects';

const CATEGORIES = ['agents', 'platform', 'art', 'tools', 'infrastructure', 'culture', 'education'];

const definition = {
  name: 'vibe_submit',
  description: 'Submit a project to the vibecodings directory. Auto-approved for Vercel deployments.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name'
      },
      url: {
        type: 'string',
        description: 'Live deployment URL (e.g., https://my-project.vercel.app)'
      },
      description: {
        type: 'string',
        description: 'What it does (2-3 sentences)'
      },
      category: {
        type: 'string',
        enum: CATEGORIES,
        description: 'Project category'
      }
    },
    required: ['name', 'url', 'description', 'category']
  }
};

async function handler(args) {
  const { name, url, description, category } = args;

  // Validate category
  if (!CATEGORIES.includes(category)) {
    return {
      display: `Invalid category. Choose from: ${CATEGORIES.join(', ')}`
    };
  }

  // Get creator from config if initialized
  const creator = config.isInitialized() ? config.getHandle() : 'anonymous';

  try {
    const response = await fetch(VIBECODINGS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        url,
        description,
        category,
        creator
      })
    });

    const result = await response.json();

    if (result.success) {
      const isAutoApproved = result.data?.autoApproved;
      const projectId = result.data?.project?.id;

      if (isAutoApproved) {
        return {
          display: `**Project submitted!**\n\n` +
            `**${name}** is now live in the directory.\n` +
            `Reason: ${result.data.reason}\n\n` +
            `View: https://vibecodings.vercel.app/new`
        };
      } else {
        return {
          display: `**Project submitted for review!**\n\n` +
            `**${name}** has been added to the curator queue.\n` +
            `Position: #${result.data?.position || '?'}\n\n` +
            `Tip: ${result.data?.tip || 'Deploy to Vercel for instant approval!'}`
        };
      }
    } else {
      return {
        display: `Submission failed: ${result.error}`
      };
    }
  } catch (err) {
    return {
      display: `Error submitting project: ${err.message}`
    };
  }
}

module.exports = { definition, handler };
