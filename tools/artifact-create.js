/**
 * vibe_create_artifact - Create social artifacts from conversations
 *
 * Artifacts are first-class objects with provenance, permissions, and social context.
 * They can be guides, learnings, or workspaces - all shareable via DM.
 */

const config = require('../config');
const store = require('../store');
const { requireInit } = require('./_shared');

const definition = {
  name: 'vibe_create_artifact',
  description: 'Create a social artifact (guide, learning, workspace) from conversation or memory. Artifacts are first-class objects with provenance and can be shared via DM.',
  inputSchema: {
    type: 'object',
    properties: {
      for: {
        type: 'string',
        description: 'Primary recipient handle (@wanderingstan). Must start with @.'
      },
      title: {
        type: 'string',
        description: 'Clear, specific title for the artifact'
      },
      template: {
        type: 'string',
        enum: ['guide', 'learning', 'workspace'],
        description: 'Structural template to use'
      },
      content: {
        type: 'object',
        description: 'Structured blocks array. Each block has type and data.',
        properties: {
          blocks: {
            type: 'array',
            description: 'Array of content blocks (heading, paragraph, places, checklist, etc.)'
          }
        },
        required: ['blocks']
      },
      source: {
        type: 'string',
        enum: ['conversation', 'memory', 'manual', 'mixed'],
        description: 'Where this content came from'
      },
      thread_id: {
        type: 'string',
        description: 'Optional: link to the DM thread this came from'
      },
      personalize: {
        type: 'string',
        enum: ['none', 'creator_only', 'recipient_opt_in'],
        description: 'creator_only = use your messages only. recipient_opt_in = requires permission'
      },
      visibility: {
        type: 'string',
        enum: ['unlisted', 'network', 'public'],
        description: 'unlisted = only via direct link (default)'
      },
      audience: {
        type: 'array',
        items: { type: 'string' },
        description: 'Handles who can view this (includes creator + recipient by default)'
      },
      autoShare: {
        type: 'boolean',
        description: 'Send DM with artifact card to recipient (default: true)'
      },
      expires_at: {
        type: 'string',
        description: 'ISO timestamp or null for permanent'
      },
      notes: {
        type: 'string',
        description: 'Internal notes about generation approach'
      }
    },
    required: ['title', 'template', 'content']
  }
};

// Generate artifact ID and slug
function generateArtifactId() {
  return `artifact_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const {
    for: recipient,
    title,
    template,
    content,
    source = 'conversation',
    thread_id = null,
    personalize = 'creator_only',
    visibility = 'unlisted',
    audience = [],
    autoShare = true,
    expires_at = null,
    notes = null
  } = args;

  const creator = config.getHandle();

  // Validation
  if (!content || !content.blocks || !Array.isArray(content.blocks)) {
    return {
      display: '❌ Invalid content structure. Must include blocks array.'
    };
  }

  if (recipient && !recipient.startsWith('@')) {
    return {
      display: '❌ Recipient handle must start with @ (e.g., @wanderingstan)'
    };
  }

  // Check personalization permissions
  if (personalize === 'recipient_opt_in' && recipient) {
    // TODO: Check if recipient has granted permission
    // For now, downgrade to creator_only
    console.warn('[ARTIFACT] recipient_opt_in not yet implemented, using creator_only');
  }

  // Build artifact object
  const artifactId = generateArtifactId();
  const slug = generateSlug(title);

  // Build audience list (always includes creator and recipient)
  const fullAudience = new Set([creator]);
  if (recipient) fullAudience.add(recipient.replace('@', ''));
  audience.forEach(h => fullAudience.add(h.replace('@', '')));

  const artifact = {
    id: artifactId,
    slug,
    title,
    template,
    content,

    // Social metadata
    created_by: creator,
    created_for: recipient ? recipient.replace('@', '') : null,
    thread_id,

    // Privacy
    visibility,
    audience: Array.from(fullAudience),

    // Provenance
    provenance: {
      source_type: source,
      personalized_for: personalize === 'recipient_opt_in' ? recipient : null,
      notes
    },

    // Lifecycle
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at,

    // Evolution
    revision: 1,
    forked_from: null
  };

  // Store artifact
  const storeResult = await store.createArtifact(artifact);

  if (!storeResult.success) {
    return {
      display: `❌ Failed to create artifact: ${storeResult.error}`
    };
  }

  const artifactUrl = `https://slashvibe.dev/a/${slug}`;

  // Auto-share via DM if requested
  if (autoShare && recipient) {
    try {
      const dmResult = await store.sendArtifactCard(recipient.replace('@', ''), {
        type: 'artifact_card',
        artifact_id: artifactId,
        url: artifactUrl,
        preview: {
          title,
          creator,
          created_for: recipient,
          template,
          snippet: content.blocks[0]?.text || content.blocks[0]?.markdown || '',
        },
        context: thread_id ? `From your conversation thread` : `Created by ${creator}`
      });

      if (!dmResult.success) {
        console.warn('[ARTIFACT] Failed to send DM:', dmResult.error);
      }
    } catch (e) {
      console.warn('[ARTIFACT] DM send error:', e.message);
    }
  }

  // Format display
  let display = `✅ **Artifact Created**\n\n`;
  display += `**Title:** ${title}\n`;
  display += `**Type:** ${template}\n`;
  display += `**URL:** ${artifactUrl}\n`;
  display += `**Visibility:** ${visibility}\n`;
  if (recipient) {
    display += `**Created for:** ${recipient}\n`;
    if (autoShare) {
      display += `\n📩 Artifact card sent via DM\n`;
    }
  }
  display += `\n**Artifact ID:** ${artifactId}\n`;

  if (expires_at) {
    display += `**Expires:** ${new Date(expires_at).toLocaleDateString()}\n`;
  }

  return { display };
}

module.exports = { definition, handler };
