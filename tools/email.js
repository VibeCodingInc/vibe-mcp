/**
 * vibe_email — Add (or view) the email where /vibe pings you about DMs you miss
 *
 * The return loop: when someone DMs you while you're away from Claude Code,
 * /vibe emails you so you actually come back. That only works if we have your
 * address — GitHub doesn't hand us a verified email, so this is the one-time
 * opt-in that arms it. Offline-only, 6h cooldown, one-click unsubscribe.
 *
 * Examples:
 * - "vibe email me@example.com"   → set it
 * - "vibe email"                  → show what's on file
 */

const config = require('../config');
const { requireInit } = require('./_shared');

// Same shape the server validates with (api/profile/update.js isValidEmail)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const definition = {
  name: 'vibe_email',
  description: "Set the email where /vibe alerts you about DMs you miss while away. No address on file → no offline pings. Call with no args to see what's set.",
  inputSchema: {
    type: 'object',
    properties: {
      email: {
        type: 'string',
        description: 'Your email address. Omit to view the address currently on file.'
      }
    }
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const token = config.getAuthToken();
  if (!token) {
    return {
      display: '❌ **Not authenticated**\n\nRun `vibe init` to sign in with GitHub first.'
    };
  }

  const apiUrl = config.getApiUrl();
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  const { email } = args;

  // ─── No arg: show what's on file ──────────────────────────────────────
  if (!email || !String(email).trim()) {
    try {
      const r = await fetch(`${apiUrl}/api/profile/update`, { headers: authHeaders });
      if (r.ok) {
        const me = await r.json();
        if (me.email) {
          return {
            display: `📧 **Email on file:** ${me.email}\n\n` +
              "You'll get a heads-up here when someone DMs you while you're away from Claude Code.\n\n" +
              '_Change it: `vibe email new@address.com` · stop alerts via the unsubscribe link in any email._'
          };
        }
      }
    } catch (e) {
      // fall through to the prompt
    }
    return {
      display: '📧 **No email on file yet**\n\n' +
        "Add one and /vibe will ping you when someone DMs you while you're away — so you actually come back.\n\n" +
        '`vibe email you@example.com`\n\n' +
        '_Offline DMs only · max one every 6h · one-click unsubscribe in every email._'
    };
  }

  // ─── Arg given: validate + save ───────────────────────────────────────
  const addr = String(email).trim();
  if (!EMAIL_RE.test(addr)) {
    return {
      display: `❌ **That doesn't look like an email**\n\nGot: \`${addr}\`\n\nTry again: \`vibe email you@example.com\``
    };
  }

  try {
    const r = await fetch(`${apiUrl}/api/profile/update`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ email: addr })
    });
    const result = await r.json().catch(() => ({}));

    if (!r.ok) {
      if (r.status === 400 && result.error === 'Invalid email format') {
        return { display: `❌ **Invalid email format**\n\nGot: \`${addr}\`` };
      }
      if (r.status === 401) {
        return { display: '❌ **Session expired**\n\nRun `vibe init` to sign in again, then retry.' };
      }
      return { display: `❌ **Couldn't save email**\n\n${result.error || 'Please try again.'}` };
    }

    return {
      display: `✅ **Email saved:** ${addr}\n\n` +
        "Next time someone DMs you while you're away from Claude Code, you'll get an email so you don't miss it.\n\n" +
        '_Offline DMs only · max one every 6h · one-click unsubscribe in every email._'
    };
  } catch (error) {
    console.error('[email] Error:', error);
    return {
      display: `❌ **Couldn't save email**\n\nError: ${error.message}\n\nPlease try again.`
    };
  }
}

module.exports = { definition, handler };
