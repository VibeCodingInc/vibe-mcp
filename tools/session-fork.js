/**
 * vibe session-fork — Fork someone else's session
 *
 * Creates a fork of an existing session, giving you a copy to build on.
 * Supports 3 temporal destinations: session (replay), branch (code), or live (broadcast).
 *
 * Part of the core demo loop:
 * Code with AI -> Session captured -> Replayable -> Discoverable -> Forkable -> Reputation accrues
 *
 * API: POST /api/sessions/fork
 */

const config = require('../config');
const { requireInit } = require('./_shared');

const definition = {
  name: 'vibe_session_fork',
  description: 'Fork an existing session to build on it. Creates a copy you can extend.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID to fork (e.g., ses_xxx)'
      },
      fork_to: {
        type: 'string',
        enum: ['session', 'branch', 'live'],
        description: 'Fork destination: session (replay copy), branch (code copy), live (start broadcast from fork)'
      }
    },
    required: ['session_id']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { session_id, fork_to } = args;
  const myHandle = config.getHandle();
  const apiUrl = config.getApiUrl();

  try {
    const body = {
      parentSessionId: session_id,
      forkerHandle: myHandle,
      forkTo: fork_to || 'session'
    };

    const response = await fetch(`${apiUrl}/api/sessions/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return {
        display: `## Fork Failed\n\n${data.error || `HTTP ${response.status}`}\n\nMake sure the session ID is valid. Try \`vibe feed\` to browse sessions.`
      };
    }

    const forkId = data.forkId || data.id || 'unknown';
    const destination = data.destination || fork_to || 'session';
    const forkUrl = data.url || `https://slashvibe.dev/sessions/${forkId}`;

    let display = `## Session Forked\n\n`;
    display += `**Forked from:** \`${session_id}\`\n`;
    display += `**Fork ID:** \`${forkId}\`\n`;
    display += `**Destination:** ${destination}\n`;
    display += `**URL:** ${forkUrl}\n\n`;

    switch (destination) {
      case 'session':
        display += `Your fork is saved as a new session. You can replay or extend it.`;
        break;
      case 'branch':
        display += `Code copy created. Start building on top of the original session.`;
        break;
      case 'live':
        display += `Live broadcast started from fork. Others can watch you build on this.`;
        break;
    }

    display += `\n\nThe original author gets credit — fork lineage is tracked.`;

    return { display };

  } catch (error) {
    return {
      display: `## Fork Error\n\n${error.message}\n\nRun \`vibe doctor\` to diagnose connectivity issues.`
    };
  }
}

module.exports = { definition, handler };
