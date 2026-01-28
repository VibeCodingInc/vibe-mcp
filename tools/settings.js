/**
 * vibe settings — Configure /vibe preferences
 *
 * Currently supports:
 * - notifications: all | mentions | off
 * - guided: on | off (dashboard mode)
 * - github_activity: on | off (show GitHub shipping status)
 * - github_activity_privacy: full | status_only | off
 */

const config = require('../config');

const definition = {
  name: 'vibe_settings',
  description:
    'Configure /vibe preferences. Set notification level, toggle guided mode, or enable GitHub activity signals.',
  inputSchema: {
    type: 'object',
    properties: {
      notifications: {
        type: 'string',
        enum: ['all', 'mentions', 'off'],
        description: 'Notification level: all (default), mentions only, or off'
      },
      guided: {
        type: 'boolean',
        description: 'Enable/disable guided dashboard mode'
      },
      github_activity: {
        type: 'boolean',
        description: 'Enable GitHub activity signals (shows shipping status based on commits)'
      },
      github_activity_privacy: {
        type: 'string',
        enum: ['full', 'status_only', 'off'],
        description: 'Privacy level: full (repos/commits), status_only (just badge), off'
      }
    }
  }
};

async function handler(args) {
  const changes = [];

  // Update notifications if provided
  if (args.notifications) {
    config.setNotifications(args.notifications);
    changes.push('notifications → **' + args.notifications + '**');
  }

  // Update guided mode if provided
  if (args.guided !== undefined) {
    config.setGuidedMode(args.guided);
    changes.push('guided mode → **' + (args.guided ? 'on' : 'off') + '**');
  }

  // Update GitHub activity if provided
  if (args.github_activity !== undefined) {
    config.setGithubActivityEnabled(args.github_activity);
    changes.push('github activity → **' + (args.github_activity ? 'on' : 'off') + '**');
  }

  // Update GitHub activity privacy if provided
  if (args.github_activity_privacy) {
    config.setGithubActivityPrivacy(args.github_activity_privacy);
    changes.push('github activity privacy → **' + args.github_activity_privacy + '**');
  }

  // If no args, show current settings
  if (changes.length === 0) {
    const notifications = config.getNotifications();
    const guided = config.getGuidedMode();
    const githubActivity = config.getGithubActivityEnabled();
    const githubPrivacy = config.getGithubActivityPrivacy();

    const notifyDesc = {
      all: 'All notifications (messages, mentions, presence)',
      mentions: 'Only @mentions',
      off: 'No notifications'
    };

    const privacyDesc = {
      full: 'Show repos, commits, tech stack',
      status_only: 'Just show shipping badge (🔥/⚡)',
      off: 'Disabled'
    };

    return {
      display:
        '## /vibe Settings\n\n' +
        '**Notifications:** ' +
        notifications +
        '\n' +
        '_' +
        notifyDesc[notifications] +
        '_\n\n' +
        '**Guided Mode:** ' +
        (guided ? 'on' : 'off') +
        '\n' +
        '_' +
        (guided ? 'Shows dashboard menus' : 'Freeform mode') +
        '_\n\n' +
        '**GitHub Activity:** ' +
        (githubActivity ? 'on' : 'off') +
        '\n' +
        '_' +
        (githubActivity ? 'Shows shipping status from your GitHub commits' : 'Not sharing GitHub activity') +
        '_\n\n' +
        (githubActivity ? '**GitHub Privacy:** ' + githubPrivacy + '\n_' + privacyDesc[githubPrivacy] + '_\n\n' : '') +
        '---\n\n' +
        '**Change settings:**\n' +
        '• "set notifications to mentions" — less noisy\n' +
        '• "turn off guided mode" — no menus\n' +
        '• "enable github activity" — show when you\'re shipping\n' +
        '• "set github privacy to status_only" — just badge, no details'
    };
  }

  return {
    display:
      '## Settings Updated\n\n' +
      changes
        .map(function (c) {
          return '✓ ' + c;
        })
        .join('\n') +
      '\n\n_Changes take effect immediately._'
  };
}

module.exports = { definition, handler };
