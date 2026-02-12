/**
 * vibe onboarding — View your onboarding checklist progress
 *
 * Shows the 5 onboarding tasks and their completion status.
 * Tasks are auto-detected as you use vibe.
 */

const config = require('../config');
const store = require('../store');

const definition = {
  name: 'vibe_onboarding',
  description: 'View your onboarding checklist progress. Shows tasks that help you get started with /vibe.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  }
};

/**
 * Format a single task for display
 */
function formatTask(task, index) {
  const checkbox = task.completed ? '[x]' : '[ ]';
  const status = task.completed ? '✓' : ' ';
  const completedText = task.completed && task.completedAt
    ? ` _(done ${formatTimeAgo(task.completedAt)})_`
    : '';

  return `${checkbox} **${task.title}**${completedText}`;
}

/**
 * Format timestamp to relative time
 */
function formatTimeAgo(timestamp) {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Generate progress bar
 */
function generateProgressBar(completed, total) {
  const percentage = Math.round((completed / total) * 100);
  const filled = Math.round((completed / total) * 10);
  const empty = 10 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${bar} ${percentage}%`;
}

async function handler(args) {
  const handle = config.getHandle();

  if (!handle) {
    return {
      display: `## Not Initialized

Run \`vibe init\` first to set your identity and start onboarding.`
    };
  }

  // Fetch checklist status from API
  try {
    const response = await store.getChecklistStatus(handle);

    if (!response.success) {
      return {
        display: `## Onboarding Checklist

_Unable to load checklist. Try again later._

Error: ${response.error || 'Unknown error'}`
      };
    }

    const { tasks, progress, allComplete } = response;

    // Build display
    let display = `## Onboarding Checklist

`;

    // Progress bar
    display += `**Progress:** ${generateProgressBar(progress.completed, progress.total)} (${progress.completed}/${progress.total})\n\n`;

    // Celebration if complete
    if (allComplete) {
      display += `🎉 **Congratulations!** You've completed onboarding!\n\n`;
    }

    // Tasks
    display += `### Tasks\n\n`;
    tasks.forEach((task, i) => {
      display += formatTask(task, i) + '\n';
    });

    // Next action hints
    if (!allComplete) {
      display += '\n### Quick Actions\n\n';

      const nextTask = tasks.find(t => !t.completed);
      if (nextTask) {
        switch (nextTask.id) {
          case 'read_welcome':
            display += '→ Say **"check my messages"** to read @vibe\'s welcome\n';
            break;
          case 'reply_seth':
            display += '→ Say **"reply to vibe"** or **"dm @vibe hi!"**\n';
            break;
          case 'message_builder':
            display += '→ Say **"who\'s around?"** then message someone\n';
            break;
          case 'first_ship':
            display += '→ Say **"ship something"** or **"I shipped X"**\n';
            break;
          case 'invite_friend':
            display += '→ Say **"invite a friend"** or **"share my invite link"**\n';
            break;
          case 'leave_feedback':
            display += '→ Say **"echo feedback about X"** or **"give feedback"**\n';
            break;
        }
      }
    }

    return { display };

  } catch (e) {
    return {
      display: `## Onboarding Checklist

_Error loading checklist: ${e.message}_

Try running \`vibe test\` to check connectivity.`
    };
  }
}

module.exports = { definition, handler };
