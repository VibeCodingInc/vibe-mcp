/**
 * vibe start — "let's vibe" entry point
 *
 * Single command to enter the social space:
 * 1. Init if needed (prompts for handle)
 * 2. Show who's around
 * 3. Check inbox
 * 4. Suggest someone to connect with
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');
const { apiHeaders } = require('../api-auth');
const { inertField } = require('../incoming');
const store = require('../store');
const memory = require('../memory');
const patterns = require('../intelligence/patterns');
const { actions, formatActions } = require('./_actions');
const { firstDmNudge } = require('./_shared');
const { weaveMoment } = require('./weave');
const init = require('./init');
const { gatherWithTimeout } = require('./_work-context');

const REPO_DIR = path.join(process.env.HOME, '.vibe', 'vibe-repo');

/**
 * Auto-update on session start
 * Checks for updates and applies them automatically via git pull
 * Returns update info if an update was applied, null otherwise
 */
async function autoUpdate() {
  try {
    // Check if we're in a git repo
    const gitDir = path.join(REPO_DIR, '.git');
    if (!fs.existsSync(gitDir)) {
      return null; // Not a git install, skip
    }

    // Check last update time (don't check more than once per hour)
    const lastCheck = config.get('lastAutoUpdateCheck');
    if (lastCheck && Date.now() - lastCheck < 60 * 60 * 1000) {
      return null; // Checked recently
    }

    // Fetch latest from remote (without merging)
    execSync('git fetch origin main', { cwd: REPO_DIR, stdio: 'ignore', timeout: 10000 });

    // Check if we're behind
    const localHead = execSync('git rev-parse HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
    const remoteHead = execSync('git rev-parse origin/main', { cwd: REPO_DIR, encoding: 'utf8' }).trim();

    if (localHead === remoteHead) {
      config.set('lastAutoUpdateCheck', Date.now());
      return null; // Already up to date
    }

    // Get current version before update
    const versionPath = path.join(REPO_DIR, 'mcp-server', 'version.json');
    let oldVersion = 'unknown';
    try {
      oldVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8')).version;
    } catch (e) {}

    // Pull the update
    execSync('git pull origin main', { cwd: REPO_DIR, stdio: 'ignore', timeout: 30000 });

    // Get new version
    let newVersion = 'unknown';
    try {
      newVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8')).version;
    } catch (e) {}

    config.set('lastAutoUpdateCheck', Date.now());

    return {
      updated: true,
      from: oldVersion,
      to: newVersion
    };
  } catch (e) {
    // Silent fail - don't block startup
    return null;
  }
}

/**
 * Check for version updates (cached for the session)
 * Non-blocking - returns null on any error
 */
async function getVersionInfo() {
  // Check cache first (avoid repeated API calls)
  const cached = config.get('versionInfo');
  if (cached && cached.checkedAt > Date.now() - 5 * 60 * 1000) {
    return cached;
  }

  try {
    // Read local version
    const versionPath = path.join(__dirname, '..', 'version.json');
    const localVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    const current = localVersion.version;

    // Fetch remote version (with timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${config.getApiUrl()}/api/version`, {
      headers: { 'User-Agent': 'vibe-mcp-client' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      // Cache failure to avoid retrying
      const result = { current, latest: null, hasUpdate: false, checkedAt: Date.now() };
      config.set('versionInfo', result);
      return result;
    }

    const remoteVersion = await response.json();
    const latest = remoteVersion.version;
    const hasUpdate = compareVersions(latest, current) > 0;

    const result = { current, latest, hasUpdate, checkedAt: Date.now() };
    config.set('versionInfo', result);
    return result;
  } catch (e) {
    // Silent fail - return local version only
    try {
      const versionPath = path.join(__dirname, '..', 'version.json');
      const localVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      return { current: localVersion.version, latest: null, hasUpdate: false, checkedAt: Date.now() };
    } catch {
      return null;
    }
  }
}

/**
 * Compare semver versions: returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  return 0;
}

/**
 * Generate ASCII welcome card - matches init.js format
 * Format: logo | handle + unread | tagline + online
 */
function generateWelcomeCard({ handle, onlineCount, unreadCount, versionInfo }) {
  // Match init.js generateAuthBanner format for consistency
  const handleCol = `@${handle}`.padEnd(16);
  const unreadCol = unreadCount > 0 ? `📬 ${unreadCount} unread`.padEnd(14) : `📬 0 messages`.padEnd(14);

  // Add version badge if available
  let versionSuffix = '';
  if (versionInfo?.hasUpdate) {
    versionSuffix = ' ⬆️';
  }

  return `  █░█ █ █▄▄ █▀▀   ${handleCol}  ask here · answer there
  ▀▄▀ █ █▄█ ██▄   ${unreadCol}  🟢 ${onlineCount} online${versionSuffix}
  ──────────────────────────────────────────────────`;
}

const definition = {
  name: 'vibe_start',
  description: 'Start socializing on /vibe. Use when user says "let\'s vibe", "start vibing", "who\'s around", or wants to connect with others.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Your handle (use your X/Twitter handle). Only needed if not already initialized.'
      },
      building: {
        type: 'string',
        description: 'What you\'re working on (one line). Only needed if not already initialized.'
      }
    }
  }
};

async function handler(args) {
  // Step 0: Auto-update check (runs git pull if behind)
  const updateResult = await autoUpdate();

  // Step 1: Check if properly authenticated with OAuth
  // If not, redirect to init for GitHub auth flow (shows pre-auth banner + OAuth)
  if (!config.hasOAuth()) {
    return init.handler({
      handle: args.handle,
      one_liner: args.building
    });
  }

  // Step 2: User is authenticated - show dashboard
  const myHandle = config.getHandle();
  let threads = [];
  let updateNotice = '';

  // If we just updated, show a notice
  if (updateResult?.updated) {
    updateNotice = `\n\n⬆️ **Updated v${updateResult.from} → v${updateResult.to}** — restart your coding agent to apply`;
  }

  // Fetch version info early (non-blocking, cached)
  const versionInfo = await getVersionInfo().catch(() => null);

  // ═══════════════════════════════════════════════════════════════════════
  // AMBIENT CONTEXT: Gather work context and auto-set presence
  // ═══════════════════════════════════════════════════════════════════════
  let workContext = null;
  const autoContextEnabled = config.get('autoContext', true); // Opt-out via settings

  if (autoContextEnabled) {
    try {
      // Gather context with timeout (won't block startup)
      workContext = await gatherWithTimeout(2000);

      // Auto-set presence so others see what we're working on (silent, non-blocking)
      if (workContext?.suggestions?.brief) {
        // Use store.heartbeat directly instead of importing context tool
        // This avoids circular dependencies and is simpler
        store.heartbeat(myHandle, config.getOneLiner(), {
          note: workContext.suggestions.brief,
          branch: workContext.git?.branch || null
        }).catch(() => {}); // Silent fail - don't block
      }
    } catch (e) {
      // Silent fail - context is nice-to-have, not required
      workContext = null;
    }
  }

  // Log session start for patterns
  patterns.logSessionStart(myHandle);

  // Get threads for memory context
  try {
    threads = memory.listThreads();
  } catch (e) {}

  // Step 2: Get who's around
  const users = await store.getActiveUsers();
  const others = users.filter(u => u.handle !== myHandle);

  // Step 3: Check inbox
  let unreadCount = 0;
  let inboxThreads = [];
  try {
    // Fetch full inbox (not just count) so we can include summaries
    inboxThreads = await store.getInbox(myHandle);
    unreadCount = inboxThreads.reduce((sum, t) => sum + (t.unread || 0), 0);
  } catch (e) {}

  // Step 3b: Check for guest session messages + pair status (multiplayer)
  let guestMessages = [];
  let pairStatus = null;
  try {
    const apiUrl = config.getApiUrl();
    const headers = apiHeaders();
    const [guestResp, pairResp] = await Promise.all([
      fetch(`${apiUrl}/api/session/guest?handle=${encodeURIComponent(myHandle)}`, { headers }),
      fetch(`${apiUrl}/api/pair?handle=${encodeURIComponent(myHandle)}`, { headers }),
    ]);
    const guestData = await guestResp.json();
    if (guestData.success && guestData.messages && guestData.messages.length > 0) {
      guestMessages = guestData.messages;
    }
    const pairData = await pairResp.json();
    if (pairData.success && pairData.paired) {
      pairStatus = pairData;
    }
  } catch (e) {}

  // Step 4 used to fetch /api/suggestions and render "Suggested connections" — three
  // strangers proposed on every session start, in the DEFAULT surface rather than behind
  // VIBE_EXTRAS. Removed 2026-08-01 (Seth) with the automated cold intros in
  // api/lib/board-service.js.
  //
  // Proposing people you do not know is the retired public-network product. A private
  // fabric shows you the people you already work with, and says nothing when there is
  // nobody to say anything about. NOTE: `workContext.suggestions` elsewhere in this file
  // is unrelated — that is local work context, not people.

  // Generate the ASCII welcome card (matches init.js format)
  const welcomeCard = generateWelcomeCard({
    handle: myHandle,
    onlineCount: others.length,
    unreadCount,
    versionInfo
  });

  // Build display with card + any additional info
  let display = welcomeCard;

  // Add who's online section (top 5 with what they're building)
  if (others.length > 0) {
    const top5 = others.slice(0, 5);
    display += `\n\n**🟢 Online now:**`;
    top5.forEach(u => {
      // status/one_liner/note are written by other users — inert before they
      // land in this session's context (codex F8 coverage).
      const status = u.status ? ` (${inertField(u.status, 30)})` : '';
      const truncated = inertField(u.one_liner || u.note || '', 40);
      display += `\n• @${u.handle}${status}${truncated ? ' — ' + truncated : ''}`;
    });
    if (others.length > 5) {
      display += `\n• _+${others.length - 5} more..._`;
    }
  }

  // First-DM activation nudge (dormant users only): if this user has never sent
  // a DM, point them at a real human who's around right now with a ready opener.
  // Gated inside firstDmNudge so we never nag people who already message.
  display += firstDmNudge(others, threads);

  // Add unread messages section (if any)
  if (unreadCount > 0) {
    const unreadSenders = inboxThreads.filter(t => t.unread > 0);
    display += `\n\n**📬 Unread (${unreadCount}):**`;
    unreadSenders.slice(0, 3).forEach(t => {
      const truncated = inertField(t.lastMessage || '', 50);
      display += `\n• @${t.handle} (${t.unread}) — "${truncated}"`;
    });
    if (unreadSenders.length > 3) {
      display += `\n• _+${unreadSenders.length - 3} more threads..._`;
    }
  }

  // The Weave — "Fable holds your half": if someone replied to a thread and you
  // haven't answered, surface the moment so the in-session model can draft your
  // reply in your voice and send it with one word. Best-effort, never blocks start.
  try {
    display += await weaveMoment(myHandle);
  } catch (e) {
    // weave is additive magic — a failure here must never break vibe_start
  }

  // Add guest session messages (multiplayer — someone typed into your session)
  if (guestMessages.length > 0) {
    display += `\n\n**🎤 ${guestMessages.length} guest message${guestMessages.length > 1 ? 's' : ''} in your session:**`;
    guestMessages.forEach(m => {
      const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      display += `\n• [${time}] @${inertField(m.from, 40)}: ${inertField(m.message, 80)}`;
    });
    display += `\n_Use vibe_guest with action "ack" to clear after reading._`;
  }

  // Show pair status if paired with someone
  if (pairStatus) {
    const mode = pairStatus.mode || 'coding';
    display += `\n\n**🔗 Paired with @${pairStatus.partner}** (${mode})`;
    display += `\n_Session sharing active. Use vibe_guest to exchange messages._`;
  }

  // Add memory context for returning users
  if (threads.length > 0) {
    const recentThreads = threads.slice(0, 3);
    const names = recentThreads.map(t => `@${t.handle}`).join(', ');
    display += `\n\n💭 **${threads.length}** people in memory · ${names}`;
  }

  // Add update notice if we just auto-updated
  if (updateNotice) {
    display += updateNotice;
  }

  // Step 6: Show rotating tips about features.
  // A tip may only name a tool REGISTERED in a default session (#9.2) — the
  // old set advertised "vibe stuck" / "vibe available" / "vibe context" /
  // "start presence monitor", none of which exist, so every rotating tip
  // told users to run a command that fails. If a tip's tool ever moves
  // behind VIBE_EXTRAS, the tip moves with it.
  const tips = [
    '💡 **Tip:** Say "who\'s around?" — vibe_who shows who has a live heartbeat right now.',
    '💡 **Tip:** Say "message @handle ..." to DM someone — replies land in your inbox across sessions.',
    '💡 **Tip:** Say "check my vibe inbox" any time — messages wait for you between sessions.',
    '💡 **Tip:** Run "npx slashvibe-mcp hook install" so waiting messages appear when your next Claude session starts.'
  ];
  const tipIndex = Math.floor(Date.now() / 60000) % tips.length; // Rotate every minute
  display += `\n\n---\n${tips[tipIndex]}`;

  // Build response with hints for structured dashboard flow
  const response = { display };

  // === ENRICHED DATA ===
  // Include full online users list so Claude doesn't need to call vibe_who
  response.onlineUsers = others.map(u => ({
    handle: u.handle,
    building: (u.one_liner || u.note) ? inertField(u.one_liner || u.note) : null,
    status: u.status ? inertField(u.status, 30) : null,
    lastActive: u.lastSeen ? new Date(u.lastSeen).toISOString() : null
  }));

  // Include unread thread summaries so Claude doesn't need to call vibe_inbox
  const unreadSenders = inboxThreads.filter(t => t.unread > 0);
  response.unreadThreads = unreadSenders.map(t => ({
    handle: t.handle,
    unread: t.unread,
    preview: t.lastMessage ? t.lastMessage.slice(0, 80) : null,
    isAgent: t.isAgent || false
  }));

  // Include guest session messages (multiplayer)
  if (guestMessages.length > 0) {
    response.guestMessages = guestMessages.map(m => ({
      from: m.from,
      message: m.message,
      timestamp: m.timestamp,
      id: m.id
    }));
  }

  // Include pair status if paired
  if (pairStatus) {
    response.pairStatus = {
      paired: true,
      partner: pairStatus.partner,
      mode: pairStatus.mode,
      startedAt: pairStatus.startedAt
    };
  }


  // Determine session state and suggest appropriate flow
  let suggestion = null;

  if (unreadCount >= 5) {
    // Many unread - suggest triage
    response.hint = 'structured_triage_recommended';
    response.unread_count = unreadCount;
  } else if (others.length === 0 && unreadCount === 0) {
    // Empty room - suggest discovery or invite
    response.hint = 'suggest_discovery';
    response.reason = 'empty_room';
  } else if (others.length > 0) {
    // People around - check for interesting ones
    const interesting = others.find(u => {
      const age = Date.now() - u.lastSeen;
      return age < 5 * 60 * 1000; // Active in last 5 min
    });
    if (interesting) {
      suggestion = {
        handle: interesting.handle,
        reason: 'active_now',
        context: interesting.note || interesting.one_liner || 'Building something'
      };
      response.hint = 'surprise_suggestion';
      response.suggestion = suggestion;
    }
  }

  // Add guided mode actions for AskUserQuestion rendering
  const onlineHandles = others.map(u => u.handle);
  let actionList;

  if (others.length === 0 && unreadCount === 0) {
    // Empty room
    actionList = actions.emptyRoom({ workContext });
  } else {
    // Normal dashboard
    actionList = actions.dashboard({
      unreadCount,
      onlineUsers: onlineHandles,
      suggestion,
      workContext
    });
  }

  response.actions = formatActions(actionList);

  // ═══════════════════════════════════════════════════════════════════════
  // WORK CONTEXT: Include in response for Claude to use
  // ═══════════════════════════════════════════════════════════════════════
  if (workContext?.suggestions?.brief) {
    response.workContext = {
      summary: workContext.suggestions.brief,
      detailed: workContext.suggestions.detailed,
      project: workContext.project?.name,
      branch: workContext.git?.branch,
      recentCommit: workContext.git?.recentCommits?.[0]?.message || null,
      hasUncommitted: workContext.git?.hasUncommitted || false
    };
  }

  return response;
}

module.exports = { definition, handler };
