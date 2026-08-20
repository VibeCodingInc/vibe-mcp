/**
 * vibe bye — End session with summary
 *
 * Triggers Smart Summary, then cleans up session state.
 * The summary appears locally before sign-off.
 */

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
  if (!config.isInitialized()) {
    return {
      display: 'No active session to end.'
    };
  }

  const myHandle = config.getHandle();

  // Generate summary first
  const summaryResult = await summarize.handler({});
  let display = summaryResult.display;

  // Clear activity tracking
  summarize.clearActivity();

  // Log session end for patterns
  patterns.logSessionEnd();

  // Actually stop broadcasting. Clearing the session file alone did NOT:
  // identity falls straight back to the shared ~/.vibe config, and the 30s
  // heartbeat interval kept running for the life of the agent process — so
  // the advertised stop command printed "Signed off" while the user stayed
  // visibly online indefinitely. Stop the loop, then tell the server we're
  // gone rather than waiting out the presence TTL.
  const presence = require('../presence');
  presence.stop();
  await presence.goOffline().catch(() => {});

  // Clear session identity (but keep shared config)
  config.clearSession();

  // Sign-off message
  display += `\n\n---\n`;
  display += `**@${myHandle}, presence ended for this session.** Your identity's saved — next time, just say "vibe" and you're back in the room.\n\n`;
  display += `💡 _How was your session? Say "message @echo" next time to share feedback!_`;

  return { display };
}

module.exports = { definition, handler };
