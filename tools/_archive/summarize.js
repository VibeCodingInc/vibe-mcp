/**
 * vibe summarize — Generate session summary
 *
 * Smart Summary: Local, copyable, optionally shareable.
 * NOT sent automatically to the room.
 *
 * Now reads from the durable session journal (SQLite) instead of
 * ephemeral PID activity files.
 *
 * Triggers:
 * - Explicit: vibe summarize
 * - Session end: vibe bye (calls this internally)
 * - Burst: 5+ messages in thread (future)
 */

const { requireInit } = require('./_shared');
const config = require('../config');
const store = require('../store');
const getSessions = require('../store/sessions');

const definition = {
  name: 'vibe_summarize',
  description:
    'Generate a session summary. Shows participants, activity, mood, and open threads. Local-first: not sent to the room.',
  inputSchema: {
    type: 'object',
    properties: {
      share: {
        type: 'boolean',
        description: 'If true, offers to share summary with participants (default: false)'
      }
    }
  }
};

async function handler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const { share = false } = args;

  // Get inbox for thread analysis
  const inbox = await store.getInbox(myHandle);

  // Read from session journal
  const sessionId = config.getSessionId();
  const sessions = getSessions();
  const session = sessionId ? sessions.getSession(sessionId) : null;
  const journal = sessionId ? sessions.getSessionJournal(sessionId, { limit: 500 }) : [];

  // Derive activity from journal entries
  let messagesSent = 0;
  let messagesReceived = 0;
  const participants = new Set();
  const toolCounts = {};
  const threads = {};

  for (const entry of journal) {
    if (entry.event_type === 'message_sent') {
      messagesSent++;
      if (entry.target) {
        participants.add(entry.target);
        threads[entry.target] = (threads[entry.target] || 0) + 1;
      }
    } else if (entry.event_type === 'message_received') {
      messagesReceived++;
      if (entry.target) {
        participants.add(entry.target);
        threads[entry.target] = (threads[entry.target] || 0) + 1;
      }
    } else if (entry.event_type === 'tool_call' && entry.tool_name) {
      const name = entry.tool_name.replace('vibe_', '');
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
  }

  // Also add inbox participants
  inbox.forEach(thread => participants.add(thread.handle));

  // Calculate session duration
  const now = Date.now();
  const startTime = session ? new Date(session.started_at).getTime() : now;
  const startStr = new Date(startTime).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const endStr = new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Build participant list
  const participantList =
    Array.from(participants)
      .map(p => `@${p}`)
      .join(', ') || '_none_';

  // Build summary
  let summary = `## Session Summary — ${startStr}–${endStr}\n\n`;
  summary += `• Participants: ${participantList}`;

  // Events
  const events = [];
  if (messagesSent > 0) {
    events.push(`Sent ${messagesSent} message${messagesSent > 1 ? 's' : ''}`);
  }
  if (messagesReceived > 0) {
    events.push(`Received ${messagesReceived} message${messagesReceived > 1 ? 's' : ''}`);
  }

  // Tool activity summary
  const toolEntries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    const topTools = toolEntries.slice(0, 5).map(([t, c]) => `${t} (${c}x)`).join(', ');
    events.push(`Tools: ${topTools}`);
  }

  if (events.length > 0) {
    summary += `\n• Events:\n`;
    events.forEach(e => (summary += `  – ${e}\n`));
  }

  // Open threads with unread
  const openThreads = inbox.filter(t => t.unread > 0).map(t => `@${t.handle} (${t.unread} unread)`);

  if (openThreads.length > 0) {
    summary += `• Open threads:\n`;
    openThreads.forEach(t => (summary += `  – ${t}\n`));
  }

  // Add copy hint
  summary += `\n---\n_This summary is local. Copy it or share with \`vibe summarize --share\`_`;

  if (share) {
    summary += `\n\n⚠️ Sharing not yet implemented. Copy and paste manually.`;
  }

  return { display: summary };
}

// Backward-compatible no-op exports (callers may still reference these)
function trackMessage() {}
function trackMood() {}
function clearActivity() {}
function getActivity() {
  return {
    startTime: Date.now(),
    messagesSent: 0,
    messagesReceived: 0,
    participants: [],
    moodChanges: [],
    threads: {}
  };
}
function checkBurst() {
  return { triggered: false };
}

module.exports = {
  definition,
  handler,
  trackMessage,
  trackMood,
  checkBurst,
  clearActivity,
  getActivity
};
