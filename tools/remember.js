/**
 * vibe remember — the private-memory verb.
 *
 * With a Personal Mind grant this is the existing pre-send thinking pass
 * (one sourced offer or honest silence; never sends, never retains). Without
 * a grant it answers with the capability's truthful state instead of
 * pretending: available-but-ungranted, off, or unavailable — never a guess,
 * never a silent probe of private data.
 */

const capabilities = require('../capabilities');
const mind = require('./mind');

const definition = {
  name: 'vibe_remember',
  description:
    'Privately consult the user’s own local memory (Personal Mind over VibeCheck) while drafting a consequential /vibe message. One sourced offer or silence; never sends; raw drafts and history never leave this machine. Without an activated grant, reports the capability state honestly instead.',
  inputSchema: mind.definition.inputSchema,
};

async function handler(args) {
  const cap = capabilities.manifest().remember;
  if (cap.state === 'granted') {
    return mind.handler(args);
  }
  return {
    display: `remember — ${cap.state} · ${cap.why}`,
    data: { silence: true, capability: cap },
  };
}

module.exports = { definition, handler };
