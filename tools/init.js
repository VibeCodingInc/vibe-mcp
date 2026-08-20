/**
 * vibe init — Set your identity
 *
 * Smooth browser-based OAuth flow:
 * 1. Start local callback server on localhost:9876
 * 2. Open browser to login page
 * 3. User authenticates with GitHub/X
 * 4. Browser redirects back to localhost with token
 * 5. Tool WAITS for callback and returns success
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');
const discord = require('../discord');
const authStore = require('../auth-store');
const { beginOAuth } = require('../oauth-callback');
const actorSession = require('../actor-session');

const API_BASE = 'https://www.slashvibe.dev';

// vibe_email is culture-layer: with extras off, nudging someone to say
// "vibe email …" advertises a command their session does not have.
const EXTRAS_ENABLED = ['1', 'true'].includes(String(process.env.VIBE_EXTRAS || '').toLowerCase());

/**
 * Fetch presence from the API, split into humans vs agents.
 * The green dot should mean something — so we count real builders
 * separately from agents and let callers frame each honestly.
 */
async function getPresenceCounts() {
  try {
    const response = await fetch(`${API_BASE}/api/presence`);
    if (!response.ok) return { online: 0, humans: 0, agents: 0 };
    const data = await response.json();
    const everyone = [...(data.active || []), ...(data.away || [])];
    const humans = everyone.filter(u => !u.isAgent).length;
    const agents = everyone.filter(u => u.isAgent).length;
    return { online: everyone.length, humans, agents };
  } catch (e) {
    return { online: 0, humans: 0, agents: 0 };
  }
}

/**
 * Short presence label that distinguishes humans from agents, e.g.
 * "2 builders · 7 agents", "3 builders online", "8 agents online".
 * Returns null when nobody is around (callers pick their own empty copy).
 */
function formatPresenceLabel({ humans = 0, agents = 0 } = {}) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (humans > 0 && agents > 0) return `${plural(humans, 'builder')} · ${plural(agents, 'agent')}`;
  if (humans > 0) return `${plural(humans, 'builder')} online`;
  if (agents > 0) return `${plural(agents, 'agent')} online`;
  return null;
}

/**
 * Generate welcome banner for new users (pre-auth, no handle yet)
 */
function generatePreAuthBanner(presence) {
  const label = formatPresenceLabel(presence);
  const onlineText = label ? `🟢 ${label}` : '🟢 join the crew';
  return `
  █░█ █ █▄▄ █▀▀     ask here · answer there
  ▀▄▀ █ █▄█ ██▄     ${onlineText}
  ──────────────────────────────────────────────────
`;
}

/**
 * Generate welcome banner for authenticated users (with handle + unread)
 */
function generateAuthBanner(handle, unreadCount, presence) {
  // Format: logo | handle + unread | tagline + online
  // Keep alignment consistent with original banner
  const handleCol = `@${handle}`.padEnd(16);
  const unreadCol = unreadCount > 0 ? `📬 ${unreadCount} unread`.padEnd(14) : `📬 0 messages`.padEnd(14);
  const onlineText = formatPresenceLabel(presence) || 'just you so far';

  return `  █░█ █ █▄▄ █▀▀   ${handleCol}  ask here · answer there
  ▀▄▀ █ █▄█ ██▄   ${unreadCol}  🟢 ${onlineText}
  ──────────────────────────────────────────────────`;
}

/**
 * Detect current git repository name
 */
function detectRepoName() {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel 2>/dev/null', {
      encoding: 'utf8',
      timeout: 1000
    }).trim();
    // Split on forward or back slash to get repo name
    const parts = toplevel.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  } catch (e) {
    return null;
  }
}

/**
 * Detect tech stack from package.json or file extensions
 */
function detectTechStack() {
  const techStack = new Set();

  try {
    // Find git root first, fallback to cwd
    let cwd;
    try {
      cwd = execSync('git rev-parse --show-toplevel 2>/dev/null', {
        encoding: 'utf8',
        timeout: 1000
      }).trim();
    } catch (e) {
      cwd = process.cwd();
    }

    // Try reading package.json
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Map common packages to tech names
      const techMap = {
        'react': 'React',
        'next': 'Next.js',
        'vue': 'Vue',
        'svelte': 'Svelte',
        'express': 'Express',
        'fastify': 'Fastify',
        'typescript': 'TypeScript',
        '@anthropic-ai/sdk': 'Claude API',
        'openai': 'OpenAI',
        'langchain': 'LangChain',
        'prisma': 'Prisma',
        '@vercel/kv': 'Vercel KV',
        'tailwindcss': 'Tailwind',
        'electron': 'Electron',
        '@tauri-apps/api': 'Tauri'
      };

      for (const [pkg, tech] of Object.entries(techMap)) {
        if (deps[pkg]) techStack.add(tech);
      }
    }

    // Detect by file extensions in cwd
    const files = fs.readdirSync(cwd).slice(0, 50);  // Limit scan
    for (const f of files) {
      if (f.endsWith('.ts') || f.endsWith('.tsx')) techStack.add('TypeScript');
      if (f.endsWith('.py')) techStack.add('Python');
      if (f.endsWith('.rs')) techStack.add('Rust');
      if (f.endsWith('.go')) techStack.add('Go');
      if (f.endsWith('.sol')) techStack.add('Solidity');
    }

  } catch (e) {
    // Non-fatal - continue without tech detection
  }

  return Array.from(techStack).slice(0, 8);  // Limit to 8 techs
}

/**
 * Fetch GitHub friends who are on /vibe (non-blocking)
 */
async function fetchGitHubFriends(handle) {
  try {
    const response = await fetch(`${API_BASE}/api/github/contacts?handle=${encodeURIComponent(handle)}`);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.success) return null;
    return {
      friendsOnVibe: data.people_you_know?.slice(0, 5) || [],
      inviteSuggestions: data.invite_suggestions?.slice(0, 10) || [],
      totalContacts: data.stats?.total_contacts || 0
    };
  } catch (e) {
    return null;
  }
}

/**
 * Does this freshly-authed user have an email on file?
 *
 * GitHub email capture (callback.js) fills this for most users, but accounts
 * with a private GitHub email come back NULL — and a null-email user is exactly
 * the one we can't reach when a DM lands while they're away. We only nudge that
 * gap population, so people who already gave us an address aren't nagged.
 *
 * Returns true (has email), false (no email → nudge), or null (unknown → stay
 * quiet rather than guess).
 */
async function fetchHasEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${API_BASE}/api/profile/update`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const me = await r.json();
    return !!me.email;
  } catch (e) {
    return null;
  }
}

/**
 * Send personalized welcome from @seth
 * Returns the welcome message content so we can show it inline
 */
async function sendPersonalizedWelcome(handle, oneLiner) {
  try {
    const repoName = detectRepoName();
    const techStack = detectTechStack();

    const response = await fetch(`${API_BASE}/api/onboarding/personalized-welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        oneLiner,
        repoName,
        techStack,
        githubProfile: null
      })
    });

    if (!response.ok) {
      console.error('[vibe_init] Welcome API error:', response.status);
      return null;
    }

    const result = await response.json();
    return result.success ? result : null;
  } catch (e) {
    console.error('[vibe_init] Personalized welcome failed:', e.message);
    return null;
  }
}

const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

/**
 * Send welcome message from @seth (founder)
 */
async function sendWelcomeMessage(handle, one_liner) {
  try {
    const response = await fetch(`${API_URL}/api/onboarding/welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, one_liner })
    });
    const result = await response.json();
    return result.success;
  } catch (e) {
    console.error('[vibe_init] Welcome message failed:', e.message);
    return false;
  }
}

const definition = {
  name: 'vibe_init',
  description: `Join /vibe social network. Opens the browser for GitHub sign-in — NO INPUT NEEDED; the user's GitHub username becomes their handle automatically. This BLOCKS for up to 5 minutes waiting for the browser login to finish, so BEFORE it returns the user sees only a spinner. IMPORTANT: right when you call this, tell the user in your own words that their browser is opening to sign in with GitHub, then finish the login there and come back.`,
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'RARELY NEEDED - Override your handle (defaults to GitHub username, which is usually what you want)'
      },
      one_liner: {
        type: 'string',
        description: 'OPTIONAL - What are you building? Can set this later.'
      }
    },
    required: []
  }
};

/**
 * Open URL in default browser
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.error('[vibe_init] Failed to open browser:', err.message);
    }
  });
}

async function handler(args) {
  const { handle, one_liner, auth_method } = args;

  // Normalize handle if provided
  const h = handle
    ? handle.toLowerCase().replace('@', '').replace(/[^a-z0-9_-]/g, '')
    : null;

  // Validate if custom handle provided
  if (h && h.length < 2) {
    return {
      display: 'Handle must be at least 2 characters (letters, numbers, - or _)'
    };
  }

  // Check if already authenticated.
  //
  // ONE definition of "authenticated": the server's. A token file on disk is a claim,
  // not a fact — issue #91 was vibe_dm saying "session expired" while this branch said
  // "already signed in", and `vibe init` (the fix dm prescribes) bounced off this very
  // check, looping the user. Only a DEFINITIVE server rejection falls through to
  // re-auth below; a timeout or network failure keeps the signed-in short-circuit,
  // because unreachable is not invalid and offline must never force a sign-in loop.
  if (config.hasOAuth()) {
    const existingHandle = config.getHandle();
    let sessionDead = false;
    if (existingHandle) {
      try {
        const verification = await Promise.race([
          store.verifyAuthToken(config.getAuthToken()),
          new Promise(resolve => setTimeout(() => resolve(null), 2500))
        ]);
        sessionDead = !!(verification && verification.definitive && !verification.valid);
      } catch (e) {}
      if (sessionDead) {
        console.error(`[vibe] Saved session for @${existingHandle} was rejected by the server — reconnecting.`);
      }
    }
    if (existingHandle && !sessionDead) {
      // Enrich the returning-user surface — this fires on every `vibe` for an
      // already-authed user, so it's our highest-frequency touchpoint. Surface
      // unread (the reason to come back) and, if we have no email on file, nudge
      // the return loop right at the teachable moment. Both are best-effort with
      // tight timeouts — never hold up the response; degrade to the plain message.
      let unreadCount = 0;
      let hasEmail = null;
      try {
        [unreadCount, hasEmail] = await Promise.all([
          Promise.race([
            store.getUnreadCount(existingHandle),
            new Promise(resolve => setTimeout(() => resolve(0), 1500))
          ]).catch(() => 0),
          Promise.race([
            fetchHasEmail(config.getAuthToken()),
            new Promise(resolve => setTimeout(() => resolve(null), 1500))
          ]).catch(() => null)
        ]);
      } catch (e) {}

      const unreadLine = unreadCount > 0
        ? `\n\n📬 **${unreadCount} unread** — say \`vibe inbox\` to read ${unreadCount > 1 ? 'them' : 'it'}.`
        : '';

      // Only nudge when we genuinely can't reach them out-of-band. If they have
      // unread right now, the value is concrete: "these landed while you were
      // away — next time we'll email you." Otherwise it's a gentle one-liner.
      const emailNudge = (EXTRAS_ENABLED && hasEmail === false)
        ? (unreadCount > 0
            ? `\n\n📧 These landed while you were away. Add an email and /vibe pings you next time — say **"vibe email you@example.com"** _(offline only · one-click unsubscribe)_.`
            : `\n\n📧 **Don't miss a DM** — add an email and /vibe pings you when someone messages you while you're away: **"vibe email you@example.com"** _(offline only · one-click unsubscribe)_.`)
        : '';

      // `vibe logout` is not a tool this server registers — the sign-off that
      // exists is `vibe bye`, which stops presence for this session and keeps
      // the saved identity. No re-init needed afterwards.
      return {
        display: `## Already signed in as @${existingHandle}${unreadLine}

To see who's online: \`vibe who\`
To check messages: \`vibe inbox\`
Heading out? \`vibe bye\` ends presence for this session — you stay @${existingHandle}${emailNudge}`
      };
    }
  }

  // ===========================================
  // Show welcome banner (pre-auth)
  // ===========================================
  const presence = await getPresenceCounts();
  const welcomeBanner = generatePreAuthBanner(presence);

  // ===========================================
  // BROWSER AUTH (Default): GitHub OAuth
  // ===========================================
  if (auth_method === 'browser' || !auth_method) {
    let oauth;

    // Save one_liner for callback handler
    const cfg = config.load();
    if (h) cfg.handle = h;
    cfg.one_liner = one_liner || '';
    cfg.pendingAuth = true;
    config.save(cfg);

    try {
      // The callback listener is bound before this resolves. Only then is it
      // safe to hand the attempt-correlated URL to the browser.
      oauth = await beginOAuth({ requestedHandle: h, actorAware: true });
      openBrowser(oauth.loginUrl);

      // Wait for callback (blocks until auth completes or times out)
      const { token, handle: callbackHandle, actor } = await oauth.waitForCallback();
      const finalHandle = callbackHandle;

      // Actor state is a separate credential family. Install it before claiming
      // sign-in success; an account switch or failed shadow issuance must not leave a
      // previous principal's Actor bundle alive beside the new legacy session.
      if (actor) await actorSession.installOAuthSession(actor);
      else await actorSession.clearActorSession();

      // Save to config (file persistence for restarts)
      config.saveAuthToken(token);
      config.setSessionIdentity(finalHandle, one_liner || '');

      // PUSH to in-memory auth store (immediate propagation)
      authStore.setToken(token);
      authStore.setHandle(finalHandle);
      authStore.setOneLiner(one_liner || '');

      // Update shared config
      const authConfig = config.load();
      authConfig.handle = finalHandle;
      authConfig.one_liner = one_liner || '';
      authConfig.authMethod = 'browser';
      authConfig.pendingAuth = false;
      config.save(authConfig);

      // Register session with API
      const sessionId = config.getSessionId();
      await store.registerSession(sessionId, finalHandle, one_liner);

      // Send initial heartbeat
      await store.heartbeat(finalHandle, one_liner);

      // Post to Discord
      discord.postJoin(finalHandle, one_liner);

      const result = { success: true, handle: finalHandle };

      // Send personalized welcome and wait for it (2.5s timeout)
      let welcomeResult = null;
      try {
        welcomeResult = await Promise.race([
          sendPersonalizedWelcome(result.handle, one_liner),
          new Promise(resolve => setTimeout(() => resolve(null), 2500))
        ]);
      } catch (e) {
        console.error('[vibe_init] Welcome message failed:', e.message);
      }

      // Check for unread messages (includes the welcome we just sent)
      let unreadCount = 0;
      try {
        unreadCount = await store.getUnreadCount(result.handle);
      } catch (e) {}

      // Fetch GitHub friends (non-blocking, 3s timeout)
      let friendsData = null;
      try {
        const friendsPromise = fetchGitHubFriends(result.handle);
        friendsData = await Promise.race([
          friendsPromise,
          new Promise(resolve => setTimeout(() => resolve(null), 3000))
        ]);
      } catch (e) {}

      // Do we have an email to reach them at when a DM lands while away?
      // (non-blocking, 2s timeout — never hold up onboarding for this)
      let hasEmail = null;
      try {
        hasEmail = await Promise.race([
          fetchHasEmail(config.getAuthToken()),
          new Promise(resolve => setTimeout(() => resolve(null), 2000))
        ]);
      } catch (e) {}

      // Generate authenticated banner with handle + unread (3 lines only - won't collapse)
      const authBanner = generateAuthBanner(result.handle, unreadCount, presence);

      // Build friends section if we have data
      let friendsSection = '';
      if (friendsData?.friendsOnVibe?.length > 0) {
        const friendHandles = friendsData.friendsOnVibe.map(f => `@${f.vibe_handle}`).join(', ');
        friendsSection = `\n\n🤝 **${friendsData.friendsOnVibe.length} of your GitHub friends are here!**\n${friendHandles}`;
      } else if (friendsData?.totalContacts > 0) {
        friendsSection = `\n\n👋 None of your GitHub friends are on /vibe yet — say **"vibe invite"** to bring them in!`;
      }

      // Build welcome section - show inline if we have the message
      let welcomeSection = '';
      if (welcomeResult?.messageText) {
        welcomeSection = `\n\n---\n**📨 Welcome from @seth:**\n\n> ${welcomeResult.messageText.split('\n').join('\n> ')}`;
      } else {
        welcomeSection = '\n\n---\n**📨 @seth sent you a welcome message** — say **"vibe inbox"** to read it.';
      }

      // Always close on a concrete next move toward the aha: your first DM
      // landing in someone else's terminal. Only commands that exist (who /
      // @handle / ship). Avoid pointing the reply at a specific founder handle
      // here — it can misroute; reading the inbox is the safe path to reply.
      // Only promise a crowd of *humans* when there's actually one to meet —
      // presence skews agent-heavy, and overselling an empty room is how the
      // green dot stops meaning anything. Agents still show in `vibe who`.
      const whoNudge = presence.humans > 1
        ? `**"vibe who"** — see the ${presence.humans} builders online right now`
        : `**"vibe who"** — see who's building right now`;
      // You are here because someone you work with invited you. So the first move
      // is answering THEM, not being matched with a stranger.
      //
      // This used to instruct the agent to call `vibe_intro` — auto-introduce the
      // newcomer to whoever seemed related. That tool is RETIRED (docs/PRIVATE-FABRIC.md:
      // cold introduction is out of scope), so the very first instruction a new
      // invitee received pointed at the discovery model we deleted.
      const nextSteps = unreadCount > 0
        ? `\n\n---\n**Someone is already waiting on you.** Say **"vibe inbox"** to read it, then **"vibe reply"** to answer.\n\n`
          + `_Stuck? Say **"vibe help"**._`
        : `\n\n---\n**You're in.** Say **"vibe dm @<handle>"** to reach whoever invited you — they'll get it in their next session, whether or not they're online now.\n`
          + `\n${whoNudge}.\n\n`
          + `_Stuck? Say **"vibe help"**._`;

      // One-time email nudge — only for users we can't otherwise reach (no
      // address on file). This is the return loop: a DM that lands while you're
      // away from Claude Code emails you so you actually come back.
      const emailNudge = (EXTRAS_ENABLED && hasEmail === false)
        ? `\n\n---\n📧 **Don't miss a DM** — add an email and /vibe pings you when someone messages you while you're away:\n**"vibe email you@example.com"** _(offline only · one-click unsubscribe)_`
        : '';

      return {
        display: authBanner + friendsSection + welcomeSection + nextSteps + emailNudge,
        onboarding: {
          isNewUser: true,
          handle: result.handle,
          hint: 'show_onboarding_options',
          hasWelcomeMessage: !!welcomeResult,
          welcomeText: welcomeResult?.messageText || null,
          friendsOnVibe: friendsData?.friendsOnVibe || [],
          inviteSuggestions: friendsData?.inviteSuggestions || []
        }
      };

    } catch (err) {
      if (err.message === 'AUTH_IN_PROGRESS') {
        return {
          display: `## A login is already running

Another sign-in owns the callback listener. Finish that browser sign-in, or say
**"let's vibe"** again to start a fresh attempt.`
        };
      }

      if (err.message === 'AUTH_TIMEOUT') {
        return {
          display: `## The sign-in timed out

The browser login wasn't finished within 5 minutes — no problem, just start it again.

**1. Say "let's vibe"** to reopen the login.
**2. Sign in with GitHub** in that tab, then come back here.

_Tip: keep this window and the browser both visible so you can see when it finishes._`
        };
      }

      if (oauth) await oauth.cancel();
      return {
        display: `## Couldn't finish sign-in

**What happened:** ${err.message}

**Try this:**
1. Say **"let's vibe"** to open a fresh sign-in
2. Finish the GitHub sign-in in that tab, then come back

**Still stuck?** Email seth@slashvibe.dev — happy to get you in.`
      };
    }
  }

  // ===========================================
  // LEGACY AUTH: Local Ed25519 keypairs
  // ===========================================
  const crypto = require('../crypto');

  // Generate Ed25519 keypair if not already present
  let keypair = config.getKeypair();
  let keypairNote = '';
  if (!keypair) {
    keypair = crypto.generateKeypair();
    config.saveKeypair(keypair);
    keypairNote = '\n🔐 _AIRC keypair generated for message signing_';
  }

  // Save identity
  config.setSessionIdentity(h, one_liner || '', keypair);

  const cfg = config.load();
  cfg.handle = h;
  cfg.one_liner = one_liner || '';
  cfg.visible = true;
  cfg.authMethod = 'legacy';
  config.save(cfg);

  // Register session with API
  const sessionId = config.getSessionId();
  const registration = await store.registerSession(sessionId, h, one_liner, keypair.publicKey);

  if (!registration.success) {
    return {
      display: `## Identity Set (Local Only)

**@${h}**
_${one_liner}_

⚠️ Session registration failed: ${registration.error}
Local config saved. Heartbeats will use username fallback.`
    };
  }

  // Send initial heartbeat
  await store.heartbeat(h, one_liner);

  // Post to Discord
  discord.postJoin(h, one_liner);

  // Send personalized welcome from @vibe (non-blocking)
  // Send personalized welcome and wait for it
  let welcomeResult = null;
  try {
    welcomeResult = await Promise.race([
      sendPersonalizedWelcome(h, one_liner),
      new Promise(resolve => setTimeout(() => resolve(null), 2500))
    ]);
  } catch (e) {
    console.error('[vibe_init] Welcome message failed:', e.message);
  }

  // Check for unread messages
  let unreadNotice = '';
  try {
    const unreadCount = await store.getUnreadCount(h);
    if (unreadCount > 0) {
      unreadNotice = `\n\n📬 **NEW MESSAGE — ${unreadCount} UNREAD** — say "check my messages"`;
    }
  } catch (e) {}

  return {
    display: `${welcomeBanner}
## Welcome to /vibe! (Legacy Auth)

**@${h}**
_${one_liner}_${unreadNotice}${keypairNote}

📨 **Check your messages** — @seth sent you a personalized welcome!

⚠️ **Using local keys** — consider upgrading to GitHub auth:
\`vibe init\` — Sign in with GitHub for verified identity

### Onboarding Checklist
[ ] Read your welcome message from @seth
[ ] Reply to @seth
[ ] Message one recommended builder
[ ] Post your first ship
[ ] Leave some feedback

_Say "vibe onboarding" anytime to check your progress_`
  };
}

module.exports = { definition, handler };
