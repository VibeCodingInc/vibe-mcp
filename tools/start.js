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
const store = require('../store');
const memory = require('../memory');
const notify = require('../notify');
const patterns = require('../intelligence/patterns');
const { actions, formatActions } = require('./_actions');
const init = require('./init');

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

  return `  █░█ █ █▄▄ █▀▀   ${handleCol}  🚀 ship together
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
  if (!config.hasPrivyAuth()) {
    return init.handler({
      handle: args.handle,
      one_liner: args.building
    });
  }

  // Step 2: User is authenticated - show dashboard
  let myHandle = config.getHandle();
  let threads = [];
  let updateNotice = '';

  // If we just updated, show a notice
  if (updateResult?.updated) {
    updateNotice = `\n\n⬆️ **Updated v${updateResult.from} → v${updateResult.to}** — restart Claude Code to apply`;
  }

  // Fetch version info early (non-blocking, cached)
  const versionInfo = await getVersionInfo().catch(() => null);

  // Log session start for patterns
  patterns.logSessionStart(myHandle);

  // Get threads for memory context
  try {
    threads = memory.listThreads();
  } catch (e) {}

  // Step 2: Get who's around
  const users = await store.getActiveUsers();
  const others = users.filter(u => u.handle !== myHandle);

  // Step 3: Check inbox + trigger notifications
  let unreadCount = 0;
  try {
    unreadCount = await store.getUnreadCount(myHandle);
    if (unreadCount > 0) {
      // Check for messages needing desktop notification escalation
      const rawInbox = await store.getRawInbox(myHandle).catch(() => []);
      if (rawInbox.length > 0) {
        notify.checkAndNotify(rawInbox);
      }
    }
  } catch (e) {}

  // Generate the ASCII welcome card (matches init.js format)
  const welcomeCard = generateWelcomeCard({
    handle: myHandle,
    onlineCount: others.length,
    unreadCount,
    versionInfo
  });

  // Build display with card + any additional info
  let display = welcomeCard;

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

  // Step 6: Suggest background presence monitor (if not running)
  const presenceAgentEnabled = config.get('presenceAgentEnabled', true);
  const presenceAgentRunning = config.get('presenceAgentRunning');

  if (presenceAgentEnabled && !presenceAgentRunning && others.length > 0) {
    display += `\n\n---\n💡 **Tip:** Say "start presence monitor" for real-time alerts when interesting people come online.`;
  }

  // Build response with hints for structured dashboard flow
  const response = { display };

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
    actionList = actions.emptyRoom();
  } else {
    // Normal dashboard
    actionList = actions.dashboard({
      unreadCount,
      onlineUsers: onlineHandles,
      suggestion
    });
  }

  response.actions = formatActions(actionList);

  return response;
}

module.exports = { definition, handler };
