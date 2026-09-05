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
const { isHereNow, normalizeHandle } = require('./_shared');
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
  // Step 0: signed out? Go straight to the (non-blocking) sign-in. The
  // auto-update git work below can take tens of seconds and must never sit
  // between a stranger and their first actionable output (review P1).
  if (!config.hasOAuth()) {
    return init.handler({
      handle: args.handle,
      one_liner: args.building
    });
  }

  // Step 1: Auto-update check (runs git pull if behind) — signed-in only
  const updateResult = await autoUpdate();

  // Step 2: User is authenticated - show dashboard
  const myHandle = config.getHandle();
  let updateNotice = '';

  // If we just updated, show a notice
  if (updateResult?.updated) {
    updateNotice = `\n\n⬆️ **Updated v${updateResult.from} → v${updateResult.to}** — restart your coding agent to apply`;
  }

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

  // Step 2: Get who's around
  // A presence request that FAILED is not an empty room (round-7 review):
  // getActiveUsers flattens transport failure to [], so without this outcome
  // "0 others here" is a claim nobody verified.
  const presence = await store.getActiveUsersResult();
  const presenceRead = presence.ok;
  const users = presence.users;
  // Compared normalized: an exact !== lets a differently-cased or @-prefixed
  // copy of your own handle through, and then "N others here" counts you.
  const me = normalizeHandle(myHandle || '');
  const others = users.filter(u => normalizeHandle(u.handle || '') !== me);
  // GREEN MEANS A RECENT CONFIRMED HEARTBEAT — the same isHereNow gate who and
  // dm use. getActiveUsers returns active+away merged; rendering that union
  // under 🟢 told users someone was live who last breathed 25 minutes ago.
  const hereNow = others.filter(isHereNow);

  // Step 3: Check inbox. A FAILED read is not an empty inbox (review P1):
  // getInbox swallows transport errors into [], so without this flag a
  // network failure renders as "0 unread" and as "no messages yet" — two
  // claims nothing supports.
  let unreadCount = 0;
  let inboxThreads = [];
  let inboxRead = false;
  try {
    // getInboxResult keeps the outcome that getInbox() flattens away.
    const read = await store.getInboxResult(myHandle);
    inboxRead = read.ok === true;
    inboxThreads = read.threads || [];
    unreadCount = inboxThreads.reduce((sum, t) => sum + (t.unread || 0), 0);
  } catch (e) {
    inboxThreads = [];
  }

  // Step 3b removed with the first-screen rewrite: the guest/pair fetches
  // cost two HTTP round trips on every start and fed blocks this screen no
  // longer renders. vibe_guest still owns that surface.

  // Step 4 used to fetch /api/suggestions and render "Suggested connections" — three
  // strangers proposed on every session start, in the DEFAULT surface rather than behind
  // VIBE_EXTRAS. Removed 2026-08-01 (Seth) with the automated cold intros in
  // api/lib/board-service.js.
  //
  // Proposing people you do not know is the retired public-network product. A private
  // fabric shows you the people you already work with, and says nothing when there is
  // nobody to say anything about. NOTE: `workContext.suggestions` elsewhere in this file
  // is unrelated — that is local work context, not people.

  // ── THE FIRST SCREEN ────────────────────────────────────────────────
  // One authoritative count, no message bodies, no chosen person, and the
  // three things a person can actually do. Everything that used to live here
  // — the presence list, message previews, the ambient footer's copy of the
  // same messages, rotating tips, weave/guest/pair/memory blocks — either
  // duplicated a fact stated elsewhere or made a claim this screen cannot
  // verify. What a person needs on arrival is: who am I, what is waiting,
  // and what can I say next.
  const hereCount = hereNow.length;
  const unreadSenders = inboxThreads.filter((t) => t.unread > 0);
  // Server-supplied strings on a single line: a long handle or id would wrap
  // and blow the line budget, and a control character would add literal lines
  // (review P2).
  const cell = (v, max) => inertField(String(v || ''), max);

  let display = `/vibe @${cell(myHandle, 39)}`;
  // ONE authoritative live-presence count: store.getActiveUsers(), filtered by
  // the same isHereNow gate who and dm use, EXCLUDING the signed-in person.
  // "N here" could be read as the room including you; "N others here" states
  // exactly what was counted.
  const counts = [
    inboxRead ? `${unreadCount} unread` : "couldn't read your inbox",
    presenceRead
      ? `${hereCount} other${hereCount === 1 ? '' : 's'} here`
      : "couldn't see who's here",
  ];
  display += `\n${counts.join(' · ')}`;

  if (unreadSenders.length > 0) {
    // Handle, count, and the STABLE id of the newest message — enough to
    // reply to exactly that message. The words themselves stay in the thread
    // until the person opens it.
    display += '\n';
    unreadSenders.slice(0, 5).forEach((t) => {
      const id = t.lastMessageId ? ` · #${cell(t.lastMessageId, 40)}` : '';
      // A reply to what you sent from a piece of work is news beside that
      // work (private binding; verified only when their message carries
      // reply_to = the id you sent).
      let back = '';
      try {
        const { getReturnBinding } = require('./moves');
        const b = getReturnBinding(t.handle);
        // Explicit linkage first (when the list serves reply_to), then time.
        // Only THEIR newest message is news; an outgoing tail (a follow-up
        // sent from another client) is not (codex P2).
        const theirs = t.lastFrom === t.handle;
        if (theirs && b && b.messageId && t.lastReplyTo && t.lastReplyTo === b.messageId) back = ` · ↩ answered what you asked${b.project ? ` from ${b.project}` : ''}`;
        else if (theirs && b && t.lastTimestamp && t.lastTimestamp > b.sentAt) back = ` · ↩ after what you sent${b.project ? ` from ${b.project}` : ''}`;
      } catch {}
      display += `\n@${cell(t.handle, 39)} (${t.unread})${id}${back}`;
    });
    if (unreadSenders.length > 5) {
      display += `\n_+${unreadSenders.length - 5} more_`;
    }
  } else if (inboxRead && inboxThreads.length === 0) {
    // Only a PROVEN-empty inbox may be called a fresh arrival. Land them on
    // whoever brought them here; no randomly chosen stranger, ever.
    display += '\n\n_no messages yet — whoever invited you is the place to start_';
  }

  if (updateNotice) display += updateNotice;

  display += `\n\nvibe inbox · vibe people · vibe dm @handle "…"`;

  // ── THE RESPONSE ────────────────────────────────────────────────────
  // The payload obeys the SAME contracts as the screen (review P1): a host
  // and a model read this, so a body withheld from the display but shipped
  // here is not withheld at all, and a handle chosen here is still a chosen
  // handle. What ships is what the screen states — counts, and the threads
  // waiting with the id needed to answer one exactly. Whoever is online is
  // vibe_who's answer; whoever to talk to is the person's decision.
  const response = { display };

  response.unread = inboxRead ? unreadCount : null;   // null = not read, never 0
  response.here = presenceRead ? hereCount : null;   // null = not read, never 0
  response.waiting = unreadSenders.slice(0, 5).map((t) => ({
    handle: t.handle,
    unread: t.unread,
    lastMessageId: t.lastMessageId || null,
  }));

  // Work context is deliberately NOT returned here (review P1): the response
  // is exactly what the screen states. The local context still does its real
  // job above — it sets this session's presence note so other people see what
  // you are working on — which is a side effect, not a payload.

  return response;
}

module.exports = { definition, handler };
