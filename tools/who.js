/**
 * vibe who — See who's around with activity feed
 *
 * Shows not just who's online, but what's happening:
 * - Activity heat (how engaged they are)
 * - Recent actions ("just joined", "sent you a DM")
 * - Context (file, branch, what they're stuck on)
 */

const config = require('../config');
const store = require('../store');
const { formatTimeAgo, requireInit, firstDmNudge, isHereNow } = require('./_shared');
const memory = require('../memory');
const { actions, formatActions } = require('./_actions');
const { enhanceUsersWithInference } = require('../intelligence/infer');
const { inertField } = require('../incoming');
const { getTopSerendipity, getAllSerendipity } = require('../intelligence/serendipity');

const definition = {
  name: 'vibe_who',
  description: 'See who\'s online and what they\'re building.',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  // MCP Apps: hosts supporting io.modelcontextprotocol/ui render this tool's
  // result as the live presence board (resources/presence-board.js); text-only
  // hosts ignore _meta and keep the markdown display.
  _meta: { ui: { resourceUri: 'ui://vibe/presence-board' } }
};

// What someone is doing, as a lowercase WORD. ROOM TONE (docs/ROOM-TONE.md):
// emoji is the only color a terminal gives us and that budget is spent on presence, so
// activity is never a glyph. The row's single glyph comes from presence, not from here.
function getHeat(user) {
  const lastSeenMs = user.lastSeen;
  const now = Date.now();
  const minutesAgo = (now - lastSeenMs) / 60000;

  // Just joined (within 5 min of session start)
  if (user.firstSeen) {
    const sessionDuration = (lastSeenMs - new Date(user.firstSeen).getTime()) / 60000;
    if (sessionDuration < 5 && minutesAgo < 2) {
      return { label: 'just joined', inferred: false };
    }
  }

  // GitHub activity signals — real commits are high-confidence
  if (user.github?.shipping_mode === 'hot') {
    const commits = user.github.total_commits || 0;
    const label = commits > 0 ? `shipping code (${commits} commits)` : 'shipping code';
    return { label, inferred: false, source: 'github' };
  }
  if (user.github?.shipping_mode === 'active') {
    return { label: 'shipping', inferred: false, source: 'github' };
  }

  // Check for inferred state from smart detection
  if (user.mood_inferred && user.mood) {
    const inferredLabel = user.inferred_state
      ? `${user.inferred_state.replace('-', ' ')}`
      : 'active';
    return {
      label: inferredLabel,
      inferred: true,
      reason: user.mood_reason
    };
  }

  // Explicit mood takes priority
  if (user.mood === '🔥' || user.mood === '🚀') {
    return { label: 'shipping', inferred: false };
  }
  if (user.mood === '🐛') {
    return { label: 'debugging', inferred: false };
  }
  if (user.mood === '🌙') {
    return { label: 'late night', inferred: false };
  }
  if (user.mood === '🧠') {
    return { label: 'deep focus', inferred: false };
  }

  // Infer from builderMode
  if (user.builderMode === 'deep-focus') {
    return { label: 'deep focus', inferred: false };
  }
  if (user.builderMode === 'shipping') {
    return { label: 'shipping', inferred: false };
  }

  // GitHub building mode (lower activity but still coding)
  if (user.github?.shipping_mode === 'building') {
    return { label: 'building', inferred: false, source: 'github' };
  }

  // Default based on recency. No 'active' label here: the row's green glyph
  // already says active, and a word that repeats the glyph rendered on some rows
  // and not others, which read as a difference that wasn't one.
  if (minutesAgo < 10) {
    return { label: null, inferred: false };
  }
  return { label: 'idle', inferred: false };
}

// Format user's current activity
// EVERY value below is written by another user (status, file, branch, note,
// one_liner, repo names). This function is the single funnel for the board's
// activity text AND its structured mirror, so inerting here covers both — a
// status can no longer forge a board row or open a code span (codex F8 coverage).
function formatActivity(user) {
  const parts = [];

  // File/branch context
  if (user.file) {
    parts.push(inertField(user.file, 60));
  }
  if (user.branch && user.branch !== 'main' && user.branch !== 'master') {
    parts.push(`(${inertField(user.branch, 40)})`);
  }

  // Error they're stuck on (highest priority - they might need help)
  if (user.error) {
    return `⚠️ _stuck on: ${inertField(user.error, 50)}_`;
  }

  // Combine file + note if both present
  if (user.note && parts.length > 0) {
    return `${parts.join(' ')} — _"${inertField(user.note)}"_`;
  }

  // Just note
  if (user.note) {
    return `_"${inertField(user.note)}"_`;
  }

  // Just file context
  if (parts.length > 0) {
    return parts.join(' ');
  }

  // GitHub active repos (if no other context and GitHub connected)
  if (user.github?.active_repos?.length > 0) {
    const repos = user.github.active_repos.slice(0, 2);
    const repoNames = repos.map(r => inertField(String(r).split('/').pop(), 40));
    return `pushing to ${repoNames.join(', ')}`;
  }

  // Fall back to one_liner
  return user.one_liner ? inertField(user.one_liner) : 'Building something';
}

async function handler(args) {
  // Allow peeking at who's online even without auth (progressive disclosure)
  // If not initialized, show users with a join prompt instead of blocking
  const isInit = config.isInitialized();

  const rawUsers = await store.getActiveUsers();
  // Apply smart detection — infer states from context signals
  const users = enhanceUsersWithInference(rawUsers);
  const myHandle = config.getHandle();
  const apiUrl = config.getApiUrl();

  // Fetch active help requests (non-blocking)
  let helpRequests = [];
  try {
    const helpResponse = await fetch(`${apiUrl}/api/help?limit=5`);
    const helpData = await helpResponse.json();
    if (helpData.success && helpData.requests) {
      helpRequests = helpData.requests;
    }
  } catch (e) {
    // Silent fail - help requests are nice-to-have
  }

  // TWO EMPTY STATES, AND THEY ARE NOT THE SAME FACT.
  //
  // An empty list can mean "nobody is here" or "we cannot see" — and only one of those
  // is about the room. A signed-out session used to get the first message while four
  // people were online, which tells someone the product is dead at the exact moment they
  // are deciding whether it works.
  if (rawUsers.anonymous) {
    // Say the number only when the server gave us one. v1 supplies public counts; v2
    // answers 401 with nothing, and inventing "0 people" there would be the same lie in
    // a different costume.
    const n = rawUsers.counts?.active;
    const line = typeof n === 'number'
      ? `_You're signed out — ${n === 1 ? '1 person is' : `${n} people are`} here right now, but names need a sign-in._`
      : `_You're signed out, so I can't see who's here._`;
    return {
      structured: { generatedAt: Date.now(), users: [], signedOut: true, counts: rawUsers.counts || null },
      display: `## Who's Around

${line}

Run \`vibe init\` and you'll see who, and they'll see you.`
    };
  }

  if (users.length === 0) {
    // Same private-fabric rule as the empty inbox: you're here because a person
    // invited you, so the useful move is reaching them — not a system account.
    // (The old copy suggested "@vibe, always around" — a system account that
    // presence filtering means you can't even see.)
    return {
      structured: { generatedAt: Date.now(), users: [] },
      display: `## Who's Around

_Quiet right now — you're the only one here._

The room fills up through the day. Two things that work:
dm whoever invited you — it'll be waiting on their next turn — or send
\`slashvibe.dev\` to someone you'd actually want to build near.`
    };
  }

  // Sort by activity: most recent first
  const sorted = [...users].sort((a, b) => b.lastSeen - a.lastSeen);

  // GREEN MEANS A RECENT CONFIRMED HEARTBEAT — nothing else. "🟢 @mira · 25m
  // ago" told the reader mira was here, next to the timestamp proving she
  // wasn't. The rule lives in _shared.isHereNow (one definition, shared with
  // dm's away-line); rows past it render as away, whatever the server's
  // 30-minute status bucket said.
  const active = sorted.filter(u => isHereNow(u));
  const away = sorted.filter(u => !isHereNow(u));

  // Structured mirror of the board for MCP Apps / structured-output clients —
  // the same facts the markdown renders, nothing extra.
  const structured = {
    generatedAt: Date.now(),
    users: sorted.map(u => {
      const heat = getHeat(u);
      return {
        handle: u.handle,
        isMe: u.handle === myHandle,
        // The store's normalized shape says `isAgent` — this read `u.is_agent`,
        // a field that never exists, so the structured mirror (and the 🤖 badge
        // below) reported every agent as a person.
        isAgent: !!u.isAgent,
        operator: u.isAgent ? (u.operator || null) : null,
        // Mirror what the board presents, including the heartbeat gate.
        status: isHereNow(u) ? 'active' : 'away',
        heatLabel: heat.label,
        activity: formatActivity(u),
        awayMessage: u.awayMessage ? inertField(u.awayMessage) : null,
        availableFor: (Array.isArray(u.availableFor) ? u.availableFor : []).map((x) => inertField(x, 40)),
        lastSeen: u.lastSeen,
        timeAgo: formatTimeAgo(u.lastSeen)
      };
    })
  };

  let display = `## Who's Around\n\n`;

  // Help requests section (if any)
  if (helpRequests.length > 0) {
    display += `_needs help:_\n`;
    for (const req of helpRequests.slice(0, 3)) {
      // urgency is a word, not a traffic light
      const urgencyWord = req.urgency === 'high' ? 'urgent' : req.urgency === 'low' ? 'whenever' : 'soon';
      display += `   **@${inertField(req.handle, 40)}** (${urgencyWord}): ${inertField(req.problem, 50)}\n`;
    }
    // #9.2: 'vibe stuck' is not a registered tool — point at the DM path
    // that actually exists instead of a command that fails.
    display += `→ message them to help\n\n---\n\n`;
  }

  // Activity section for active users
  if (active.length > 0) {
    // Max 5 rows, then a count. A wall of rows is a log, not a room.
    const shown = active.slice(0, 5);
    shown.forEach(u => {
      const isMe = u.handle === myHandle;
      const tag = isMe ? ' _(you)_' : '';
      const agentBadge = u.isAgent ? ' 🤖' : '';
      const operatorTag = u.isAgent && u.operator ? `_(op: @${u.operator})_` : '';
      const heat = getHeat(u);
      // Keep it clean — state speaks for itself
      const heatLabel = heat.label ? ` ${heat.label}` : '';
      const activity = formatActivity(u);
      const timeAgo = formatTimeAgo(u.lastSeen);

      // Show availability topics if set
      const availableFor = u.availableFor && Array.isArray(u.availableFor) && u.availableFor.length > 0
        ? ` — 🤝 _available for: ${inertField(u.availableFor.join(', '), 60)}_`
        : '';

      display += `🟢 **@${u.handle}**${agentBadge}${tag}${heatLabel}${availableFor}\n`;
      if (operatorTag) {
        display += `   ${operatorTag}\n`;
      }
      display += `   ${activity}\n`;
      // Presence texture: what they last shipped
      if (u.lastShip && u.lastShip.what) {
        display += `   _last shipped: "${inertField(u.lastShip.what, 60)}" ${inertField(u.lastShip.ago, 20)}_\n`;
      }
      display += `   _${timeAgo}_\n\n`;
    });
    if (active.length > shown.length) {
      display += `_+${active.length - shown.length} more here_\n\n`;
    }
  }

  // First-DM activation nudge (dormant users only): if signed in and this user
  // has never sent a DM, point them at a real human who's active right now.
  // firstDmNudge self-gates so people who already message never see it.
  if (isInit) {
    let threads = [];
    try { threads = memory.listThreads(); } catch (e) {}
    const activeOthers = active.filter(u => u.handle !== myHandle);
    const nudge = firstDmNudge(activeOthers, threads);
    if (nudge) display += nudge.replace(/^\n+/, '') + `\n\n`;
  }

  // Away section (expanded with messages if present)
  if (away.length > 0) {
    display += `---\n\n`;
    display += `**Away:**\n`;

    // Split into users with away messages and without
    const withMessage = away.filter(u => u.awayMessage);
    const withoutMessage = away.filter(u => !u.awayMessage);

    // Show users with custom away messages (expanded)
    withMessage.forEach(u => {
      const isMe = u.handle === myHandle;
      const tag = isMe ? ' _(you)_' : '';
      const agentBadge = u.isAgent ? ' 🤖' : '';
      const timeAgo = formatTimeAgo(u.lastSeen);

      display += `💤 **@${u.handle}**${agentBadge}${tag} — _"${inertField(u.awayMessage)}"_\n`;
      display += `   _${timeAgo}_\n\n`;
    });

    // Show auto-away users (collapsed) with 💤
    if (withoutMessage.length > 0) {
      withoutMessage.forEach(u => {
        const isMe = u.handle === myHandle;
        const tag = isMe ? ' _(you)_' : '';
        const agentBadge = u.isAgent ? ' 🤖' : '';
        const timeAgo = formatTimeAgo(u.lastSeen);

        display += `💤 **@${u.handle}**${agentBadge}${tag} _(auto-away)_\n`;
        display += `   _${timeAgo}_\n\n`;
      });
    }
  }

  // One line, and it must name a tool that is ACTUALLY REGISTERED.
  //
  // This rotated three suggestions at random, one of which advertised `play` — a
  // culture-layer tool that 0.8.0 moved behind VIBE_EXTRAS. So the default board
  // routinely told people to use something their session does not have. That is the
  // help-drift class we already have a guard for on `vibe_help`; the board escaped it.
  //
  // Randomness went too: a board that says something different every time reads as
  // decoration. The hint now follows from state — if you have not set a status,
  // that is the useful thing to say.
  display += `---\n`;
  display += config.getOneLiner()
    ? `say "dm @handle" to reach someone`
    : `say "status <what you're on>" so others see what you're building`;

  // Check for unread to add urgency
  try {
    const unread = await store.getUnreadCount(myHandle);
    if (unread > 0) {
      display += `\n\n${unread} unread — \`vibe inbox\``;
    }
  } catch (e) {}

  // Fun flourish when room is lively
  if (active.length >= 3) {
    
  }

  // The scarcity line is gone.
  //
  // "genesis is full — 282 builders" was a growth-era artifact on two counts. It sold
  // scarcity, which docs/PRIVATE-FABRIC.md removed from scope; and the number was a
  // handle count, not people — 282 "builders" on a network where a handful of humans
  // are actually active reads as a claim the room immediately contradicts. Nobody
  // invited into a private fabric needs to be told the list is closed.
  //
  // What the board says about who is here is now only what it can see: the rows above.

  // If not initialized, append join prompt instead of actions/unread
  if (!isInit) {
    display += `\n\n---\n_Want in? Say **"let's vibe"** — GitHub signs you in and your username becomes your @handle._`;
    return { display, structured };
  }

  // Build response with optional hints for structured flows
  const response = { display, structured };

  // Check for surprise suggestion opportunities
  const suggestions = [];
  for (const u of active) {
    if (u.handle === myHandle) continue;

    const heat = getHeat(u);

    // Just joined - highest priority
    if (heat.label === 'just joined') {
      suggestions.push({
        handle: u.handle,
        reason: 'just_joined',
        context: u.one_liner ? inertField(u.one_liner) : 'Building something',
        priority: 1
      });
    }
    // Shipping something - good time to engage
    else if (heat.label === 'shipping') {
      suggestions.push({
        handle: u.handle,
        reason: 'shipping',
        context: inertField(u.note || u.file || u.one_liner || 'Shipping something'),
        priority: 2
      });
    }
    // Has error - might need help
    else if (u.error) {
      suggestions.push({
        handle: u.handle,
        reason: 'needs_help',
        context: u.error.slice(0, 80),
        priority: 3
      });
    }
  }

  // Sort by priority and take top suggestion
  let topSuggestion = null;
  if (suggestions.length > 0) {
    suggestions.sort((a, b) => a.priority - b.priority);
    topSuggestion = suggestions[0];
    response.hint = 'surprise_suggestion';
    response.suggestion = topSuggestion;
  }

  // Serendipity detection — quiet awareness, not loud callouts
  const myUser = users.find(u => u.handle === myHandle);
  if (myUser && active.length > 1) {
    const serendipity = getTopSerendipity(myUser, active);
    if (serendipity && serendipity.relevance > 0.75) {
      // Only surface high-confidence matches, and quietly
      response.serendipity = serendipity;
    }
  }

  // Add guided mode actions
  const onlineHandles = active.filter(u => u.handle !== myHandle).map(u => u.handle);
  const unreadCount = await store.getUnreadCount(myHandle).catch(() => 0);

  if (active.length === 0 || (active.length === 1 && active[0].handle === myHandle)) {
    // Empty room
    response.actions = formatActions(actions.emptyRoom());
  } else {
    // People are here
    response.actions = formatActions(actions.dashboard({
      unreadCount,
      onlineUsers: onlineHandles,
      suggestion: topSuggestion
    }));
  }

  return response;
}

module.exports = { definition, handler };
