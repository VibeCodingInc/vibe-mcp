/**
 * vibe capabilities — the one truthful local capability manifest.
 *
 * Reports what THIS install can do right now: remember · reflect · message ·
 * call, each exactly granted / available / off / unavailable. Discovery is
 * existence-only (no private data read, nothing executed, nothing installed).
 * Install once is not consent once: each capability is separately visible
 * here and separately revocable where its grant lives.
 */

const capabilities = require('../capabilities');

const definition = {
  name: 'vibe_capabilities',
  description:
    'Report the local capability manifest for this runtime: remember, reflect, message, call — each as granted, available, off, or unavailable, with the honest reason. Read-only; reads no private data; installs nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

async function handler() {
  const m = capabilities.manifest();
  return {
    display: `**runtime capabilities**\n${capabilities.render(m)}`,
    data: m,
  };
}

module.exports = { definition, handler };
