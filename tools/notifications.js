/**
 * vibe notifications — Configure external notification channels
 *
 * Manage where you receive DM alerts: Telegram, Discord, Slack, or webhooks.
 *
 * Usage:
 * - vibe notifications              → View current configuration
 * - vibe notifications add telegram → Start Telegram linking flow
 * - vibe notifications test         → Send test notification
 * - vibe notifications disable      → Disable notifications
 * - vibe notifications enable       → Re-enable notifications
 */

const config = require('../config');
const api = require('../store/api');

const definition = {
  name: 'vibe_notifications',
  description: 'Configure external notification channels (Telegram, Discord, etc.) for DM alerts.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'add', 'test', 'enable', 'disable', 'remove', 'verify'],
        description: 'Action to perform (default: view)'
      },
      channel: {
        type: 'string',
        enum: ['telegram', 'discord', 'slack', 'webhook'],
        description: 'Channel type for add/remove actions'
      },
      code: {
        type: 'string',
        description: 'Verification code for Telegram linking'
      },
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (provided by bot after /link command)'
      }
    }
  }
};

async function handler(args) {
  const handle = config.getHandle();
  if (!handle) {
    return {
      display: '❌ Not logged in. Run `vibe init` first.'
    };
  }

  const action = args.action || 'view';

  // ─────────────────────────────────────────────────────────
  // VIEW - Show current configuration
  // ─────────────────────────────────────────────────────────
  if (action === 'view') {
    try {
      const result = await api.request('GET', `/api/settings/notifications?handle=${handle}`);

      if (!result.success) {
        return {
          display: `❌ Failed to get notification settings: ${result.error}`
        };
      }

      const prefs = result.preferences;
      const channels = prefs.channels || [];

      // Build display
      let display = '## 🔔 Notification Settings\n\n';

      if (channels.length === 0) {
        display += '**No notification channels configured.**\n\n';
        display += 'Add a channel to receive DM alerts outside Claude Code:\n\n';
        display += '```\nvibe notifications add telegram\n```\n\n';

        if (result.telegram_available) {
          display += '_Telegram is available and recommended for mobile notifications._\n';
        }
      } else {
        display += '**Active Channels:**\n\n';

        for (const ch of channels) {
          const status = ch.enabled
            ? (ch.verified ? '✅' : '⚠️ Unverified')
            : '⏸️ Disabled';

          display += `• **${ch.name}** (${ch.type})\n`;
          display += `  Status: ${status}\n`;
          if (ch.lastUsedAt) {
            display += `  Last notification: ${timeAgo(ch.lastUsedAt)}\n`;
          }
          display += '\n';
        }

        display += '---\n\n';
        display += '**Commands:**\n';
        display += '• `vibe notifications test` — Send test notification\n';
        display += '• `vibe notifications disable` — Pause notifications\n';
        display += '• `vibe notifications remove telegram` — Remove channel\n';
      }

      // Show filter settings
      display += '\n---\n\n';
      display += '**Filter Mode:** ' + (prefs.filters?.mode || 'all') + '\n';
      const modeDesc = {
        all: '_Notify for all DMs_',
        mentions: '_Only notify when mentioned_',
        selected: '_Only notify from allow list_'
      };
      display += modeDesc[prefs.filters?.mode || 'all'] + '\n';

      return { display };

    } catch (e) {
      return {
        display: `❌ Error: ${e.message}`
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // ADD - Add a new notification channel
  // ─────────────────────────────────────────────────────────
  if (action === 'add') {
    const channel = args.channel;

    if (!channel) {
      return {
        display: '## Add Notification Channel\n\n' +
          'Choose a channel type:\n\n' +
          '• `vibe notifications add telegram` — Mobile-friendly, recommended\n' +
          '• `vibe notifications add discord` — Discord webhook\n' +
          '• `vibe notifications add slack` — Slack webhook\n' +
          '• `vibe notifications add webhook` — Generic webhook (Zapier, n8n, etc.)\n'
      };
    }

    if (channel === 'telegram') {
      // Start Telegram linking flow
      try {
        const result = await api.request('POST', '/api/settings/notifications', {
          action: 'link_telegram'
        }, {
          headers: { 'Authorization': `Bearer ${config.getAuthToken()}` }
        });

        if (!result.success) {
          return {
            display: `❌ Failed to start Telegram linking: ${result.error}`
          };
        }

        return {
          display: '## 📱 Link Telegram\n\n' +
            '**Step 1:** Open Telegram and find **@vibecodings_bot**\n\n' +
            '**Step 2:** Send this command to the bot:\n\n' +
            '```\n/link ' + result.code + '\n```\n\n' +
            '**Step 3:** The bot will confirm and you\'ll start receiving notifications!\n\n' +
            '_Code expires in 10 minutes._\n\n' +
            '---\n\n' +
            'After linking, run `vibe notifications` to verify it worked.'
        };

      } catch (e) {
        return {
          display: `❌ Error: ${e.message}`
        };
      }
    }

    // Discord/Slack/Webhook - show instructions
    if (channel === 'discord') {
      return {
        display: '## Add Discord Webhook\n\n' +
          '**Step 1:** In Discord, go to Server Settings → Integrations → Webhooks\n\n' +
          '**Step 2:** Create a new webhook and copy the URL\n\n' +
          '**Step 3:** Run:\n\n' +
          '```\ncurl -X POST "https://www.slashvibe.dev/api/settings/notifications" \\\n' +
          '  -H "Authorization: Bearer YOUR_TOKEN" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          '  -d \'{"action":"add_channel","type":"discord_webhook","config":{"webhookUrl":"YOUR_URL"}}\'\n```\n\n' +
          '_Discord webhook support coming to this CLI soon!_'
      };
    }

    if (channel === 'slack') {
      return {
        display: '## Add Slack Webhook\n\n' +
          '**Step 1:** Go to api.slack.com/apps and create an app\n\n' +
          '**Step 2:** Enable Incoming Webhooks and create one for your channel\n\n' +
          '**Step 3:** Copy the webhook URL and add via API\n\n' +
          '_Slack webhook support coming to this CLI soon!_'
      };
    }

    return {
      display: `❌ Unknown channel type: ${channel}\n\n` +
        'Valid types: telegram, discord, slack, webhook'
    };
  }

  // ─────────────────────────────────────────────────────────
  // VERIFY - Complete Telegram verification (called by webhook)
  // ─────────────────────────────────────────────────────────
  if (action === 'verify') {
    const { code, chat_id } = args;

    if (!code || !chat_id) {
      return {
        display: '❌ Code and chat_id are required for verification'
      };
    }

    try {
      const result = await api.request('POST', '/api/settings/notifications', {
        action: 'verify_telegram',
        code,
        chat_id
      });

      if (!result.success) {
        return {
          display: `❌ Verification failed: ${result.error}`
        };
      }

      return {
        display: '## ✅ Telegram Linked!\n\n' +
          'You\'ll now receive DM notifications on Telegram.\n\n' +
          'Test it by having someone message you, or run:\n\n' +
          '```\nvibe notifications test\n```'
      };

    } catch (e) {
      return {
        display: `❌ Error: ${e.message}`
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // TEST - Send a test notification
  // ─────────────────────────────────────────────────────────
  if (action === 'test') {
    try {
      // First get channels to find one to test
      const prefs = await api.request('GET', `/api/settings/notifications?handle=${handle}`, null);

      if (!prefs.success || !prefs.preferences.channels?.length) {
        return {
          display: '❌ No notification channels configured.\n\n' +
            'Add one first: `vibe notifications add telegram`'
        };
      }

      // Test the first enabled channel
      const channel = prefs.preferences.channels.find(ch => ch.enabled);
      if (!channel) {
        return {
          display: '❌ All channels are disabled.\n\n' +
            'Enable one: `vibe notifications enable`'
        };
      }

      const result = await api.request('POST', '/api/settings/notifications', {
        action: 'test_channel',
        channel_id: channel.id
      });

      if (!result.success) {
        return {
          display: `❌ Test failed: ${result.error}\n\n` +
            (result.failCount ? `Fail count: ${result.failCount}/5` : '') +
            (result.disabled ? '\n\n⚠️ Channel has been auto-disabled due to repeated failures.' : '')
        };
      }

      return {
        display: '## ✅ Test Notification Sent!\n\n' +
          `Channel: **${channel.name}** (${channel.type})\n\n` +
          'Check your ' + channel.type + ' for the test message.'
      };

    } catch (e) {
      return {
        display: `❌ Error: ${e.message}`
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // ENABLE/DISABLE - Toggle notifications
  // ─────────────────────────────────────────────────────────
  if (action === 'enable' || action === 'disable') {
    try {
      const prefs = await api.request('GET', `/api/settings/notifications?handle=${handle}`, null);

      if (!prefs.success || !prefs.preferences.channels?.length) {
        return {
          display: '❌ No notification channels configured.\n\n' +
            'Add one first: `vibe notifications add telegram`'
        };
      }

      // Update all channels
      const enabled = action === 'enable';
      let updated = 0;

      for (const channel of prefs.preferences.channels) {
        const result = await api.request('POST', '/api/settings/notifications', {
          action: 'update_channel',
          channel_id: channel.id,
          enabled
        }, {
          headers: { 'Authorization': `Bearer ${config.getAuthToken()}` }
        });

        if (result.success) updated++;
      }

      return {
        display: `## ${enabled ? '✅ Notifications Enabled' : '⏸️ Notifications Paused'}\n\n` +
          `Updated ${updated} channel(s).\n\n` +
          (enabled
            ? 'You\'ll now receive DM alerts on your configured channels.'
            : 'You won\'t receive external notifications until you enable them again.')
      };

    } catch (e) {
      return {
        display: `❌ Error: ${e.message}`
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // REMOVE - Remove a channel
  // ─────────────────────────────────────────────────────────
  if (action === 'remove') {
    const channel = args.channel;

    if (!channel) {
      return {
        display: '❌ Specify channel to remove: `vibe notifications remove telegram`'
      };
    }

    try {
      const prefs = await api.request('GET', `/api/settings/notifications?handle=${handle}`, null);

      if (!prefs.success) {
        return {
          display: `❌ Failed to get settings: ${prefs.error}`
        };
      }

      // Find channel by type
      const channelToRemove = prefs.preferences.channels?.find(ch =>
        ch.type === channel || ch.type === `${channel}_webhook`
      );

      if (!channelToRemove) {
        return {
          display: `❌ No ${channel} channel found to remove.`
        };
      }

      const result = await api.request('POST', '/api/settings/notifications', {
        action: 'remove_channel',
        channel_id: channelToRemove.id
      });

      if (!result.success) {
        return {
          display: `❌ Failed to remove channel: ${result.error}`
        };
      }

      return {
        display: `## ✅ Channel Removed\n\n` +
          `**${channelToRemove.name}** (${channelToRemove.type}) has been removed.\n\n` +
          'You will no longer receive notifications on this channel.'
      };

    } catch (e) {
      return {
        display: `❌ Error: ${e.message}`
      };
    }
  }

  return {
    display: `❌ Unknown action: ${action}\n\n` +
      'Valid actions: view, add, test, enable, disable, remove'
  };
}

/**
 * Format relative time
 */
function timeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

module.exports = { definition, handler };
