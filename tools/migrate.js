/**
 * vibe migrate — Migrate existing handle to GitHub auth
 *
 * For users who have existing handles with local keypairs,
 * this command helps them migrate to the new Privy/GitHub auth.
 *
 * Flow:
 * 1. Check if user has existing handle and keys
 * 2. Sign migration request with old key (proves ownership)
 * 3. Get migration URL from server
 * 4. User completes GitHub auth in browser
 * 5. Token pasted via `vibe token`
 */

const config = require('../config');
const crypto = require('../crypto');

const definition = {
  name: 'vibe_migrate',
  description: 'Migrate your existing handle to GitHub authentication. Use this if you have an existing handle with local keys.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

async function handler(args) {
  const handle = config.getHandle();

  if (!handle) {
    return {
      display: `❌ **No handle found**

You need to have an existing handle to migrate.
If you're new, use \`vibe init @yourhandle "what you're building"\` instead.`
    };
  }

  // Check if already using Privy auth
  if (config.hasPrivyAuth()) {
    return {
      display: `✅ **Already using GitHub auth**

@${handle} is already authenticated via GitHub.
No migration needed!`
    };
  }

  // Check if we have a keypair to sign with
  const keypair = config.getKeypair();

  // Build migration request
  const https = require('https');
  const apiUrl = config.getApiUrl();

  try {
    const timestamp = Date.now();
    let signature = null;

    // If we have a keypair, sign the migration request
    if (keypair) {
      const messageToSign = {
        action: 'migrate',
        handle: handle,
        timestamp: timestamp
      };
      signature = crypto.sign(messageToSign, keypair.privateKey);
    }

    // Request migration token from server
    const result = await new Promise((resolve, reject) => {
      const url = new URL('/api/auth/migrate', apiUrl);
      const data = JSON.stringify({
        handle,
        legacy_signature: signature,
        timestamp
      });

      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ success: false, error: body });
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });

    if (!result.success) {
      return {
        display: `❌ **Migration failed**

Error: ${result.error}
${result.message || ''}

If you're having trouble, try:
1. Make sure your handle is registered
2. Check that your local keys match what's on the server
3. Contact support if the issue persists`
      };
    }

    // Success - show auth URL
    return {
      display: `## Migrate @${handle} to GitHub Auth

${result.verified ? '✅ **Ownership verified** via signature' : '⚠️ **Unverified** — GitHub auth will claim this handle'}

🔐 **Open this URL in your browser:**

${result.authUrl}

After authenticating:
\`vibe token <paste-token-here>\`

---

**Why migrate?**
• Your identity is verified via GitHub (no impersonation)
• Messages are signed server-side (more secure)
• No private keys stored locally

_Migration token expires in 1 hour._`,
      authUrl: result.authUrl,
      verified: result.verified,
      migrationToken: result.migrationToken
    };

  } catch (e) {
    return {
      display: `❌ **Migration request failed**

Error: ${e.message}

Make sure you have internet connectivity and try again.`
    };
  }
}

module.exports = { definition, handler };
