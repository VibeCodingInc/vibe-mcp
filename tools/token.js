/**
 * vibe token — Set auth token after GitHub OAuth
 *
 * Usage:
 *   vibe token <paste-token-here>
 *
 * After authenticating via GitHub in browser, paste the token here
 * to complete authentication.
 */

const config = require('../config');
const store = require('../store');
const authStore = require('../auth-store');

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

If you haven't signed in yet:
1. Run \`vibe init\` — GitHub opens in your browser (your username becomes your @handle)
2. Finish the GitHub sign-in
3. If the browser hands you a token, paste it here`
    };
  }

  // Verify token with server
  const verification = await store.verifyAuthToken(token.trim());

  // UNREACHABLE IS NOT INVALID (#320 sweep). `{valid:false, definitive:false}`
  // is what a network timeout looks like, and this branch turned that into
  // "verification failed" plus an instruction to sign in again — sending a
  // person with a perfectly good token around a loop that cannot help them.
  if (!verification.valid && verification.definitive === false) {
    return {
      display: `⚠️ **Couldn't reach the server to check this token**

${verification.error || 'The check timed out.'}

This says nothing about the token — only that we couldn't ask. Try again when
you're back online. Your existing session is untouched.`
    };
  }

  if (!verification.valid) {
    return {
      display: `❌ **Token verification failed**

${verification.error || 'The token may be expired or invalid.'}

Start a fresh sign-in with \`vibe init\` — GitHub opens in your browser, and if it
hands you a new token, paste it here.`
    };
  }

  // Save token — to BOTH authorities, in one step.
  //
  // This wrote config and session identity but never touched the in-memory store,
  // which is what every outbound Authorization header actually reads. The result:
  // display and routing moved to the new account while requests kept going out as
  // the old one (codex #3). The store is updated first, marked verified because the
  // server just confirmed it above.
  config.saveAuthToken(token.trim());
  authStore.setToken(token.trim(), { verified: true });
  authStore.markVerified(verification.handle);

  // Update session identity with verified handle
  const handle = verification.handle;
  const oneLiner = config.getOneLiner() || 'Building something';
  config.setSessionIdentity(handle, oneLiner);

  // Update shared config
  const cfg = config.load();
  cfg.handle = handle;
  cfg.one_liner = oneLiner;
  config.save(cfg);

  // Remove old keypair (security improvement). Remember whether one existed:
  // the success copy below claims "old local keys removed" and must only say
  // that when it actually happened.
  // Checked AFTER, not before: "they existed and we called remove" is not the
  // same fact as "they are gone", and until this round they were not gone.
  let removedKeypair = false;
  if (config.hasKeypair()) {
    config.removeKeypair();
    removedKeypair = !config.hasKeypair();
  }

  // Send initial heartbeat
  await store.heartbeat(handle, oneLiner);

  return {
    display: `✅ **Authenticated as @${handle}**

GitHub: @${verification.github || 'linked'}
Expires: ${verification.expiresAt ? new Date(verification.expiresAt * 1000).toLocaleString() : 'unknown'}

Your messages are now signed server-side (more secure).
${removedKeypair ? '🔒 Old local keys have been removed.\n' : ''}
You're ready to vibe! Try:
• \`vibe who\` — See who's online
• \`vibe inbox\` — Check messages
• \`vibe dm @someone "hello"\` — Send a message`,
    handle,
    github: verification.github,
    authMethod: 'github'
  };
}

module.exports = { definition, handler };
