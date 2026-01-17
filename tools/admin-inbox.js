/**
 * vibe admin-inbox — View and respond to messages sent to @vibe
 *
 * Admin-only tool for managing system account inboxes.
 *
 * Commands:
 * - vibe admin-inbox — View messages to @vibe
 * - vibe admin-inbox --account=echo — View messages to @echo
 * - vibe admin-inbox --reply --to=user --text="response" — Reply as yourself
 * - vibe admin-inbox --reply --to=user --text="response" --as=vibe — Reply as @vibe
 */

const config = require('../config');
const { header, divider, formatTimeAgo, truncate } = require('./_shared');

const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

const definition = {
  name: 'vibe_admin_inbox',
  description: 'View messages sent to @vibe and reply (admin only). Requires VIBE_ADMIN_TOKEN.',
  inputSchema: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        description: 'System account to view (default: vibe)',
        enum: ['vibe', 'echo', 'system']
      },
      reply: {
        type: 'boolean',
        description: 'Set to true to send a reply'
      },
      to: {
        type: 'string',
        description: 'Handle to reply to (required for reply)'
      },
      text: {
        type: 'string',
        description: 'Reply message text (required for reply)'
      },
      as: {
        type: 'string',
        description: 'Reply as: "self" (your handle) or "vibe" (system account)',
        enum: ['self', 'vibe']
      },
      limit: {
        type: 'number',
        description: 'Number of messages to show (default: 20)'
      }
    }
  }
};

async function handler(args) {
  const { account = 'vibe', reply = false, to, text, as = 'self', limit = 20 } = args;

  // Check for admin token
  const adminToken = process.env.VIBE_ADMIN_TOKEN;
  if (!adminToken) {
    return {
      display: `## Admin Access Required

⚠️ **VIBE_ADMIN_TOKEN** environment variable not set.

This tool is for admins only. Set the token in your environment:
\`\`\`
export VIBE_ADMIN_TOKEN="your-admin-token"
\`\`\``
    };
  }

  // Get admin's handle for replies
  const adminHandle = config.getHandle();
  if (!adminHandle) {
    return {
      display: `## Not Initialized

Run \`vibe init\` first to set your handle.`
    };
  }

  // Handle reply mode
  if (reply) {
    return await handleReply({ to, text, as, adminHandle, adminToken });
  }

  // Default: view inbox
  return await viewInbox({ account, limit, adminToken });
}

async function viewInbox({ account, limit, adminToken }) {
  try {
    const response = await fetch(
      `${API_URL}/api/admin/system-inbox?account=${account}&limit=${limit}`,
      {
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return {
        display: `## Admin Inbox Error

${response.status === 401 ? '⚠️ Invalid admin token' : error.error || 'Failed to fetch inbox'}`
      };
    }

    const data = await response.json();
    const messages = data.messages || [];

    if (messages.length === 0) {
      return {
        display: `${header(`@${account} Inbox`)}

_No messages yet._

When users reply to @${account}, they'll appear here.`
      };
    }

    let display = header(`@${account} Inbox — ${data.unread} unread`);
    display += '\n\n';

    messages.forEach(msg => {
      const unreadBadge = !msg.read ? ' 📬 NEW' : '';
      const timeAgo = formatTimeAgo(new Date(msg.createdAt).getTime());
      const preview = truncate(msg.text || '', 80);

      display += `**@${msg.from}**${unreadBadge}\n`;
      display += `  "${preview}"\n`;
      display += `  _${timeAgo}_\n\n`;
    });

    display += divider();
    display += `**Reply:** \`vibe admin-inbox --reply --to=handle --text="your message"\`\n`;
    display += `**Reply as @${account}:** Add \`--as=${account}\``;

    return { display };

  } catch (error) {
    console.error('[admin-inbox] Error:', error);
    return {
      display: `## Error

Failed to fetch inbox: ${error.message}`
    };
  }
}

async function handleReply({ to, text, as, adminHandle, adminToken }) {
  // Validate required fields
  if (!to) {
    return {
      display: `## Missing Recipient

Usage: \`vibe admin-inbox --reply --to=handle --text="your message"\``
    };
  }

  if (!text) {
    return {
      display: `## Missing Message

Usage: \`vibe admin-inbox --reply --to=${to} --text="your message"\``
    };
  }

  try {
    const response = await fetch(`${API_URL}/api/admin/system-reply`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to,
        text,
        replyAs: as,
        adminHandle
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return {
        display: `## Reply Failed

${response.status === 401 ? '⚠️ Invalid admin token' : error.error || 'Failed to send reply'}`
      };
    }

    const data = await response.json();

    let display = `## ✓ Reply Sent\n\n`;
    display += `**To:** @${data.to}\n`;
    display += `**From:** @${data.from}\n`;
    if (data.respondedBy) {
      display += `**Responded by:** @${data.respondedBy} (audit trail)\n`;
    }
    display += `\n_"${truncate(text, 100)}"_`;

    return { display };

  } catch (error) {
    console.error('[admin-inbox] Reply error:', error);
    return {
      display: `## Error

Failed to send reply: ${error.message}`
    };
  }
}

module.exports = { definition, handler };
