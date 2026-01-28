/**
 * vibe bye — End session with summary
 *
 * Triggers Smart Summary, then cleans up session state.
 * The summary appears locally before sign-off.
 */

const { requireInit } = require('./_shared');
const config = require('../config');
const store = require('../store');
const summarize = require('./summarize');
const patterns = require('../intelligence/patterns');

const definition = {
  name: 'vibe_bye',
  description: 'End your /vibe session. Shows a summary of activity before signing off.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();

  // Generate summary first
  const summaryResult = await summarize.handler({});
  let display = summaryResult.display;

  // Clear activity tracking
  summarize.clearActivity();

  // Log session end for patterns
  patterns.logSessionEnd();

  // Clear session identity (but keep shared config)
  config.clearSession();

  // Sign-off message
  display += `\n\n---\n`;
  display += `**Signed off as @${myHandle}**\n\n`;
  display += `💡 _How was your session? Say "message @echo" next time to share feedback!_`;

  return { display };
}

module.exports = { definition, handler };
