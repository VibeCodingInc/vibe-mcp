/**
 * vibe session-save — Save your current session
 *
 * Persists a coding session to the platform so it becomes
 * replayable, discoverable, and forkable.
 *
 * Part of the core demo loop:
 * Code with AI -> Session captured -> Replayable -> Discoverable -> Forkable -> Reputation accrues
 *
 * API: POST /api/sessions
 */

const config = require('../config');
const { requireInit } = require('./_shared');

const definition = {
  name: 'vibe_session_save',
  description: 'Save your current coding session. Makes it replayable, discoverable, and forkable on slashvibe.dev.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Session title (e.g., "Building auth with OAuth")'
      },
      description: {
        type: 'string',
        description: 'Brief description of what happened in the session'
      },
      from_broadcast: {
        type: 'string',
        description: 'Room ID if saving from a live broadcast'
      },
      visibility: {
        type: 'string',
        enum: ['public', 'unlisted', 'private'],
        description: 'Session visibility (default: public)'
      }
    },
    required: ['title']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { title, description, from_broadcast, visibility } = args;
  const myHandle = config.getHandle();
  const apiUrl = config.getApiUrl();

  try {
    const body = {
      author_handle: myHandle,
      title,
      visibility: visibility || 'public'
    };

    if (description) {
      body.description = description;
    }

    if (from_broadcast) {
      body.fromBroadcast = from_broadcast;
    }

    const response = await fetch(`${apiUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return {
        display: `## Session Save Failed\n\n${data.error || `HTTP ${response.status}`}\n\nCheck \`vibe doctor\` if this persists.`
      };
    }

    const session = data.session || data;
    const sessionId = session.id || session.sessionId || 'unknown';
    const sessionUrl = session.url || `https://slashvibe.dev/sessions/${sessionId}`;

    let display = `## Session Saved\n\n`;
    display += `**${title}**\n`;
    if (description) {
      display += `${description}\n`;
    }
    display += `\n`;
    display += `**ID:** \`${sessionId}\`\n`;
    display += `**URL:** ${sessionUrl}\n`;
    display += `**Visibility:** ${visibility || 'public'}\n`;
    if (from_broadcast) {
      display += `**From broadcast:** \`${from_broadcast}\`\n`;
    }
    display += `\n`;
    display += `Others can now replay, discover, and fork this session.\n`;
    display += `Share: \`${sessionUrl}\``;

    return { display };

  } catch (error) {
    return {
      display: `## Session Save Error\n\n${error.message}\n\nMake sure you're connected to the internet. Run \`vibe doctor\` to diagnose.`
    };
  }
}

module.exports = { definition, handler };
