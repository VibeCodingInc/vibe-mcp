/**
 * vibe dm — Send a direct message
 */

const config = require('../config');
const store = require('../store');
const { requireInit, normalizeHandle, truncate, warning } = require('./_shared');

const definition = {
  name: 'vibe_dm',
  description: 'Send a direct message to someone.',
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
      }
    },
    required: ['handle', 'message']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { handle, message } = args;
  const myHandle = config.getHandle();
  const them = normalizeHandle(handle);

  if (them === myHandle) {
    return { display: 'You can\'t DM yourself.' };
  }

  if (!message || message.trim().length === 0) {
    return { display: 'Need a message to send.' };
  }

  const trimmed = message.trim();
  const MAX_LENGTH = 2000;
  const wasTruncated = trimmed.length > MAX_LENGTH;
  const finalMessage = wasTruncated ? trimmed.substring(0, MAX_LENGTH) : trimmed;

  const result = await store.sendMessage(myHandle, them, finalMessage, 'dm');

  if (result && result.error) {
    return {
      display: `Failed to send message: ${result.message}`
    };
  }

  let display = `Sent to **@${them}**`;
  if (wasTruncated) {
    display += ` ${warning(`truncated to ${MAX_LENGTH} chars`)}`;
  }
  display += `\n\n"${truncate(finalMessage, 100)}"`;

  return { display };
}

module.exports = { definition, handler };