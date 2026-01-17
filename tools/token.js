/**
 * vibe token — Set Privy auth token after browser OAuth
 *
 * Usage:
 *   vibe token <paste-token-here>
 *
 * After authenticating via GitHub in browser, paste the token here
 * to complete authentication.
 */

const config = require('../config');
const store = require('../store');

const definition = {
  name: 'vibe_token',
  description: 'Set your auth token after browser authentication. Use after completing GitHub OAuth in browser.',
  inputSchema: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'The auth token from browser authentication'
      }
    },
    required: ['token']
  }
};

async function handler(args) {
  const { token } = args;

  if (!token || token.trim().length < 10) {
    return {
      display: `❌ **Invalid token**

Please paste the full token from your browser authentication.

If you haven't authenticated yet:
1. Run \`vibe init @yourhandle\` to start
2. Open the auth URL in your browser
3. Complete GitHub authentication
4. Paste the token here`
    };
  }

  // Verify token with server
  const verification = await store.verifyPrivyToken(token.trim());

  if (!verification.valid) {
    return {
      display: `❌ **Token verification failed**

Error: ${verification.error}

The token may be expired or invalid. Try authenticating again:
1. Visit: ${config.getApiUrl()}/api/auth/github?handle=${config.getHandle() || 'yourhandle'}
2. Complete GitHub authentication
3. Paste the new token here`
    };
  }

  // Save token
  config.savePrivyToken(token.trim());

  // Update session identity with verified handle
  const handle = verification.handle;
  const oneLiner = config.getOneLiner() || 'Building something';
  config.setSessionIdentity(handle, oneLiner);

  // Update shared config
  const cfg = config.load();
  cfg.handle = handle;
  cfg.one_liner = oneLiner;
  config.save(cfg);

  // Remove old keypair (security improvement)
  if (config.hasKeypair()) {
    config.removeKeypair();
  }

  // Send initial heartbeat
  await store.heartbeat(handle, oneLiner);

  return {
    display: `✅ **Authenticated as @${handle}**

GitHub: @${verification.github || 'linked'}
Expires: ${verification.expiresAt ? new Date(verification.expiresAt * 1000).toLocaleString() : 'unknown'}

Your messages are now signed server-side (more secure).
${config.hasKeypair() ? '' : '🔒 Old local keys have been removed.'}

You're ready to vibe! Try:
• \`vibe who\` — See who's online
• \`vibe inbox\` — Check messages
• \`vibe dm @someone "hello"\` — Send a message`,
    handle,
    github: verification.github,
    authMethod: 'privy'
  };
}

module.exports = { definition, handler };
