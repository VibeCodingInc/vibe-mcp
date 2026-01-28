/**
 * vibe ping — Tap someone on the shoulder
 */

const { requireInit } = require('./_shared');
const config = require('../config');
const store = require('../store');

const definition = {
  name: 'vibe_ping',
  description: 'Send a lightweight nudge to someone. Like a tap on the shoulder.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to ping (e.g., @alex)'
      },
      note: {
        type: 'string',
        description: 'Optional short note'
      }
    },
    required: ['handle']
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const { handle, note } = args;
  const myHandle = config.getHandle();
  const them = handle.toLowerCase().replace('@', '');

  if (them === myHandle) {
    return { display: "You can't ping yourself." };
  }

  // Send as a ping-type message
  const body = note ? `👋 ${note}` : '👋';
  await store.sendMessage(myHandle, them, body, 'ping');

  return {
    display: `Pinged **@${them}**${note ? `: "${note}"` : ''}`
  };
}

module.exports = { definition, handler };
