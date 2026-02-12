/**
 * vibe session-resume — Load prior session context
 *
 * Loads the most recent completed session (or a specific one by ID)
 * from local SQLite. Displays time range, repo/branch, machine,
 * tool activity summary, last journal entries, and summary text.
 * Links current session via parent_id.
 *
 * Local-only, no API calls.
 */

const config = require('../config');
const getSessions = require('../store/sessions');

const definition = {
  name: 'vibe_session_resume',
  description:
    'Resume context from a prior session. Shows what happened last time — tools used, messages sent, repo/branch, and summary. Local-only.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Specific session ID to load. If omitted, loads most recent completed session.'
      },
      repo: {
        type: 'string',
        description: 'Filter by git repo path. Useful when resuming work on a specific project.'
      },
      limit: {
        type: 'number',
        description: 'Max journal entries to show (default: 10)'
      }
    }
  }
};

function formatDuration(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const ms = end - start;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTime(isoStr) {
  if (!isoStr) return '?';
  return new Date(isoStr).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatDate(isoStr) {
  if (!isoStr) return '?';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function handler(args) {
  const { session_id, repo = null, limit = 10 } = args;
  const sessions = getSessions();

  let session;

  if (session_id) {
    session = sessions.getSession(session_id);
    if (!session) {
      return { display: `No session found with ID: ${session_id}` };
    }
  } else {
    const handle = config.getHandle();
    if (!handle) {
      return { display: 'Not initialized. Run `vibe init` first.' };
    }
    session = sessions.getLastSession(handle, { repo });
    if (!session) {
      const qualifier = repo ? ` in ${repo}` : '';
      return { display: `No prior sessions found${qualifier}. This is your first!` };
    }
  }

  // Get journal entries
  const journal = sessions.getSessionJournal(session.session_id, { limit });

  // Build tool activity summary from journal
  const toolCounts = {};
  let messagesSent = 0;
  let messagesReceived = 0;
  const participants = new Set();

  for (const entry of journal) {
    if (entry.event_type === 'tool_call' && entry.tool_name) {
      const name = entry.tool_name.replace('vibe_', '');
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
    if (entry.event_type === 'message_sent') {
      messagesSent++;
      if (entry.target) participants.add(entry.target);
    }
    if (entry.event_type === 'message_received') {
      messagesReceived++;
      if (entry.target) participants.add(entry.target);
    }
  }

  // Build display
  let display = `## Prior Session Context\n\n`;

  // Time range
  const dateStr = formatDate(session.started_at);
  const startTime = formatTime(session.started_at);
  const endTime = session.ended_at ? formatTime(session.ended_at) : 'ongoing';
  const duration = session.ended_at ? ` (${formatDuration(session.started_at, session.ended_at)})` : '';
  display += `**When:** ${dateStr} ${startTime}–${endTime}${duration}\n`;

  // Machine + repo
  if (session.machine_id) {
    display += `**Machine:** ${session.machine_id}\n`;
  }
  if (session.git_repo) {
    const repoName = session.git_repo.split('/').pop();
    const branch = session.git_branch ? ` (${session.git_branch})` : '';
    display += `**Repo:** ${repoName}${branch}\n`;
  }

  // Participants
  if (participants.size > 0) {
    display += `**Participants:** ${Array.from(participants).map(p => `@${p}`).join(', ')}\n`;
  }

  // Summary
  if (session.summary) {
    display += `\n**Summary:** ${session.summary}\n`;
  }

  // Tool activity
  const toolEntries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0 || messagesSent > 0 || messagesReceived > 0) {
    display += `\n### Activity\n`;
    if (messagesSent > 0 || messagesReceived > 0) {
      display += `- Messages: ${messagesSent} sent, ${messagesReceived} received\n`;
    }
    for (const [tool, count] of toolEntries.slice(0, 8)) {
      display += `- ${tool}: ${count}x\n`;
    }
  }

  // Recent journal entries
  const recentEntries = journal.slice(-limit);
  if (recentEntries.length > 0) {
    display += `\n### Last ${recentEntries.length} Events\n`;
    for (const entry of recentEntries) {
      const time = formatTime(entry.timestamp);
      const type = entry.event_type.replace('_', ' ');
      const detail = entry.summary || entry.tool_name || '';
      const target = entry.target ? ` → @${entry.target}` : '';
      display += `- \`${time}\` ${type}${target} ${detail}\n`;
    }
  }

  // Link current session as child
  const currentSessionId = config.getSessionId();
  if (currentSessionId && session.session_id !== currentSessionId) {
    try {
      // Update current session's parent_id
      const db = sessions.db || null;
      if (db) {
        db.prepare('UPDATE sessions SET parent_id = ? WHERE session_id = ?')
          .run(session.session_id, currentSessionId);
      }
    } catch (e) {
      // Non-critical, skip silently
    }
  }

  display += `\n---\n_Session ${session.session_id.slice(0, 8)}… loaded. You're continuing where you left off._`;

  return { display };
}

module.exports = { definition, handler };
