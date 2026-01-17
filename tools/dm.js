/**
 * vibe dm — Send a direct message
 */

const config = require('../config');
const store = require('../store');
const memory = require('../memory');
const userProfiles = require('../store/profiles');
const patterns = require('../intelligence/patterns');
const { trackMessage, checkBurst } = require('./summarize');
const { requireInit, normalizeHandle, truncate, warning } = require('./_shared');
const { actions, formatActions } = require('./_actions');

const definition = {
  name: 'vibe_dm',
  description: 'Send a direct message to someone. Can include structured payload for games, handoffs, or artifact cards.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to message (e.g., @alex)'
      },
      message: {
        type: 'string',
        description: 'Your message'
      },
      artifact_slug: {
        type: 'string',
        description: 'Optional artifact slug to share (e.g., "pizza-guide-abc123"). The artifact will be shown as a rich card.'
      },
      payload: {
        type: 'object',
        description: 'Optional structured data (game state, code review, handoff, etc.)'
      }
    },
    required: ['handle']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { handle, message, artifact_slug, payload } = args;
  const myHandle = config.getHandle();
  const them = normalizeHandle(handle);

  // Route @echo messages to the echo agent
  if (them === 'echo') {
    const echo = require('./echo');
    return echo.handler({ message, anonymous: false });
  }

  if (them === myHandle) {
    return { display: 'You can\'t DM yourself.' };
  }

  // Handle artifact sharing
  let finalPayload = payload;
  if (artifact_slug) {
    try {
      // Fetch artifact from API
      const { getArtifactBySlug } = require('./artifact-view');
      const artifact = await getArtifactBySlug(artifact_slug);

      if (!artifact) {
        return { display: `Artifact not found: ${artifact_slug}` };
      }

      // Create artifact payload
      const protocol = require('../protocol');
      finalPayload = protocol.createArtifactPayload(artifact);
    } catch (error) {
      console.error('Failed to load artifact:', error);
      return { display: `Failed to load artifact: ${error.message}` };
    }
  }

  // Need either message or payload
  if ((!message || message.trim().length === 0) && !finalPayload) {
    return { display: 'Need either a message, artifact, or payload.' };
  }

  const trimmed = message ? message.trim() : '';
  const MAX_LENGTH = 2000;
  const wasTruncated = trimmed.length > MAX_LENGTH;
  const finalMessage = wasTruncated ? trimmed.substring(0, MAX_LENGTH) : trimmed;

  const result = await store.sendMessage(myHandle, them, finalMessage || null, 'dm', finalPayload);

  // Check for errors
  if (result && result.error) {
    return {
      display: `❌ **Failed to send message**\n\n${result.message}\n\n_Please try again. If the problem persists, check your connection._`
    };
  }

  // Log social pattern (quietly, in background)
  patterns.logMessageSent(them);

  // Record connection in profiles (if first time messaging)
  try {
    const hasConnected = await userProfiles.hasBeenConnected(myHandle, them);
    if (!hasConnected) {
      await userProfiles.recordConnection(myHandle, them, 'first_message');
    }
  } catch (error) {
    // Don't fail the message if profile update fails
    console.warn('Failed to update profile connection:', error);
  }

  // Track for session summary
  const activity = trackMessage(myHandle, them, 'sent');

  // Check for burst (5+ messages in thread)
  const burst = checkBurst();

  let display = `Sent to **@${them}**`;
  if (wasTruncated) {
    display += ` ${warning(`truncated to ${MAX_LENGTH} chars`)}`;
  }

  // Show message preview or payload type
  if (finalMessage) {
    display += `\n\n"${truncate(finalMessage, 100)}"`;
  }
  if (finalPayload) {
    const payloadType = finalPayload.type || 'data';
    if (payloadType === 'artifact') {
      const icon = finalPayload.template === 'guide' ? '📘' : finalPayload.template === 'learning' ? '💡' : finalPayload.template === 'workspace' ? '🗂️' : '📦';
      display += `\n\n${icon} _Shared artifact: ${finalPayload.title}_`;
    } else {
      display += `\n\n📦 _Includes ${payloadType} payload_`;
    }
  }

  // Burst notification (5+ messages in one thread)
  if (burst.triggered && burst.thread === them) {
    display += `\n\n💬 _${burst.count} messages with @${them} — say "summarize" when done_`;
  }

  // Build response with optional hints for structured flows
  const response = { display };

  // Check if we have any memories for this person
  const memoryCount = memory.count(them);

  // Suggest saving a memory if we don't have any
  if (memoryCount === 0) {
    response.hint = 'offer_memory_save';
    response.for_handle = them;
    response.suggestion = `Remember something about @${them} for next time?`;
  }
  // Suggest a follow-up after burst of messages
  else if (burst.triggered && burst.thread === them) {
    response.hint = 'suggest_followup';
    response.for_handle = them;
    response.message_count = burst.count;
  }

  // Add guided mode actions
  response.actions = formatActions(actions.afterDm(them));

  return response;
}

module.exports = { definition, handler };