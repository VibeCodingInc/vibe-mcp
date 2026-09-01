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
const { normalizeHandle } = require('./_shared');
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
  description: `Sign in to /vibe with GitHub — NO INPUT NEEDED; the GitHub username becomes the handle. Returns IMMEDIATELY with an auth_required state, the login URL, and one sentence to relay: 'Open this, sign in with GitHub, then say vibe start.' It may open a browser when one is available locally (never over SSH/headless); it never waits. Sign-in completes in the background; the next vibe start recognizes it.`,
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
  // Resolves to whether a browser was actually asked to open. Over SSH or in
  // a headless/CI shell we do not try: `open` on a remote Mac would pop the
  // window on a screen the person is not looking at, and a failed attempt
  // must be REPORTED so the URL becomes the honest next action.
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.CI);
  if (remote) return Promise.resolve(false);
  const platform = process.platform;
  let command;
  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  return new Promise((resolve) => {
    // A launcher still running after the cap is 'unknown' — never reported as
    // failed while it may yet open a window (review P2).
    const timer = setTimeout(() => resolve('unknown'), 5000);
    exec(command, (err) => {
      clearTimeout(timer);
      if (err) console.error('[vibe_init] Could not open a browser:', err.message);
      resolve(!err);
    });
  });
}

// ── Non-blocking sign-in (first-five-minutes repair, 2026-08-30) ─────────
// The tool call NEVER waits for OAuth. One flow at a time lives here; the
// callback listener stays alive after the tool returns, and completion is
// persisted in the background so the NEXT vibe_start recognizes the
// credential. Expired flows are replaced with a fresh one and say so.
const AUTH_SENTENCE = 'Open this, sign in with GitHub, then say vibe start.';

// WHICH CREDENTIAL the record is about — a fingerprint of the token, not a
// boolean and not a handle. Under the blocking flow this was a return value;
// the flow is non-blocking now, so the fact has to outlive the call that
// learned it. A bare boolean told Bob about Ada's mint. A handle was better but
// still outlived the credential: sign out, then load a legacy token under the
// same handle, and it inherited a complaint about a mint it was never part of.
// Binding to the credential makes both cases the same rule — a record is only
// ever about the exact token it was recorded for.
const tokenFingerprint = (token) => {
  if (typeof token !== 'string' || !token) return null;
  return require('node:crypto').createHash('sha256').update(token).digest('hex').slice(0, 16);
};
let lastMintLackedPrincipalForToken = null;
// Set when a completed sign-in could not be written to disk at all. Distinct
// from a handle-only mint: there, the credential exists and lacks a claim;
// here, there may be no new credential at all.
let lastSignInFailedToPersistFor = null;

async function completeSignIn({ token, handle: finalHandle, actor }, one_liner) {
  // VERIFY BEFORE CLAIMING (#320): the point of reauth is a credential that
  // PROVES the principal. Decoded here, but RECORDED only after the credential
  // is actually persisted below — recording it first claimed a saved
  // credential on a path where saving had not happened yet.
  const mintLackedPrincipal = !authStore.principalFromToken(token);
  if (actor) await actorSession.installOAuthSession(actor);
  else await actorSession.clearActorSession();
  // Each of these can REFUSE rather than throw. "The refreshed credential was
  // saved" is a claim about disk, so it has to be answered by disk.
  const tokenSaved = config.saveAuthToken(token) !== false;
  const identitySaved = config.setSessionIdentity(finalHandle, one_liner || '') !== false;
  authStore.setToken(token);
  authStore.setHandle(finalHandle);
  authStore.setOneLiner(one_liner || '');
  const authConfig = config.load();
  authConfig.handle = finalHandle;
  // Only when we were actually given one. save() can now express a clear, and
  // `one_liner || ''` would make signing in erase the line you set last week —
  // an instruction nobody gave.
  if (one_liner) authConfig.one_liner = one_liner;
  authConfig.authMethod = 'browser';
  authConfig.pendingAuth = false;
  const configSaved = config.save(authConfig) !== false;
  // Only a credential that actually reached disk may drive the message that
  // says so. If nothing was written, the honest state is "not saved", not a
  // minting complaint about a credential the person does not have.
  const credentialPersisted = tokenSaved && identitySaved && configSaved;
  const fp = tokenFingerprint(token);
  // The MINT record is about a credential, so it is keyed by that credential.
  lastMintLackedPrincipalForToken = (credentialPersisted && mintLackedPrincipal) ? fp : null;
  // The PERSIST-FAILURE record cannot be: when the token write is what failed,
  // the token on disk is still the OLD one, so keying the failure by the new
  // token means the next call never matches it and silently starts another
  // flow. That failure is about this person's attempt, so it is keyed by them,
  // and any later successful sign-in for the same person clears it.
  const who = normalizeHandle(finalHandle);
  if (credentialPersisted) {
    if (lastSignInFailedToPersistFor === who) lastSignInFailedToPersistFor = null;
  } else {
    lastSignInFailedToPersistFor = who;
  }
  if (!credentialPersisted) {
    console.error(`[vibe] sign-in for @${finalHandle} did not persist — token:${tokenSaved} identity:${identitySaved} config:${configSaved}`);
  }
  // The toolset just changed — tell the host now, not on the next call.
  global.vibeNotifier?.emitImmediate();
  // Presence + welcome are best-effort and must never block or throw here.
  try { await store.registerSession(config.getSessionId(), finalHandle, one_liner); } catch {}
  try { await store.heartbeat(finalHandle, one_liner); } catch {}
  try { discord.postJoin(finalHandle, one_liner); } catch {}
  try { await Promise.race([sendPersonalizedWelcome(finalHandle, one_liner), new Promise((r) => setTimeout(r, 2500))]); } catch {}
}

// A flow is only shareable with a caller asking for the SAME identity. The
// sharing exists so concurrent signed-out starts don't each bind a listener —
// but it was unconditional, so Ada starting a flow and Bob starting one handed
// Bob Ada's login URL, and completing it would have signed Bob in as Ada.
const flowKey = (opts) => normalizeHandle((opts && opts.requestedHandle) || '');

// Keyed by identity, not single slots. A single `pendingAuthCreation` slot meant
// simultaneous Ada and Bob starts each bound a listener and only the last was
// tracked — the other could never be cancelled or reset. The callback server
// falls back to an ephemeral port when 9876 is taken, so concurrent flows for
// different people are legitimate; they just have to be remembered.
const authFlows = new Map();       // key -> flow
const authFlowCreations = new Map(); // key -> promise

async function ensureAuthFlow(opts) {
  const key = flowKey(opts);
  const existing = authFlows.get(key);
  if (existing && !existing.expired) {
    return { ...existing, reused: true };
  }
  // Concurrent starts for the SAME identity must not each bind a listener.
  const inFlight = authFlowCreations.get(key);
  if (inFlight) {
    const flow = await inFlight;
    return { ...flow, reused: true };
  }
  const promise = createAuthFlow(opts).finally(() => { authFlowCreations.delete(key); });
  authFlowCreations.set(key, promise);
  return promise;
}

async function createAuthFlow({ requestedHandle, one_liner }) {
  const key = flowKey({ requestedHandle });
  const prior = authFlows.get(key);
  const replacedExpired = Boolean(prior && prior.expired);
  if (replacedExpired) {
    // The expired listener must not linger through its grace period beside
    // the replacement (review P2). Only THIS identity's expired flow is
    // touched: cancelling someone else's live flow dropped a callback that
    // was already in flight (round-3 review), losing their credential.
    try { await prior.oauth.cancel(); } catch {}
    authFlows.delete(key);
  }
  const oauth = await beginOAuth({ requestedHandle, actorAware: true });
  // 'unknown' until the launcher actually answers: a staggered caller that
  // finds the flow mid-launch must not report `false` for a browser that is
  // still opening (review P2). The field is updated in place when known.
  const flow = { oauth, loginUrl: oauth.loginUrl, startedAt: Date.now(), browserOpened: 'unknown', expired: false, reused: false, replacedExpired, key };
  authFlows.set(key, flow);
  // Background completion: nobody awaits this. Success persists the credential;
  // timeout marks the flow expired so the next start issues a fresh link.
  oauth.waitForCallback().then(
    (result) => completeSignIn(result, one_liner).catch((e) => console.error('[vibe_init] sign-in completion failed:', e.message)).finally(() => { if (authFlows.get(key) === flow) authFlows.delete(key); }),
    (err) => { flow.expired = true; if (err?.message !== 'AUTH_TIMEOUT') console.error('[vibe_init] sign-in flow ended:', err?.message || err); }
  );
  // Kick the launcher off and report only what is known within a short
  // budget — a slow launcher yields 'unknown', never a wait and never a lie.
  flow.browserPromise = openBrowser(oauth.loginUrl).then((result) => {
    flow.browserOpened = result;
    return result;
  });
  await Promise.race([
    flow.browserPromise,
    new Promise((resolve) => setTimeout(resolve, 750)),
  ]);
  return flow;
}

function authRequiredResult(flow, presenceBanner) {
  const lead = flow.replacedExpired
    ? 'The earlier sign-in link expired — here is a fresh one.'
    : flow.reused
      ? 'Still waiting for your sign-in.'
      : flow.browserOpened === true
        ? 'A browser window is opening for GitHub sign-in.'
        : flow.browserOpened === 'unknown'
          ? 'A browser may be opening; if it did not, use the link.'
          : 'No browser could be opened from here.';
  const structured = {
    state: 'auth_required',
    login_url: flow.loginUrl,
    browser_opened: flow.browserOpened,
    waiting_since: flow.startedAt,
    next: 'vibe start',
    sentence: AUTH_SENTENCE,
  };
  return {
    display: `${presenceBanner || ''}\n\n**Sign in to /vibe**\n${lead}\n${AUTH_SENTENCE}\n\n${flow.loginUrl}`,
    data: structured,
    structured, // the dispatcher forwards `structured` as structuredContent (review P1)
  };
}

// Test seam: expire every pending flow between cases.
function _forceExpireForTest() {
  for (const flow of authFlows.values()) flow.expired = true;
}

// Cancels EVERY tracked flow. The single-slot version could only reach the
// last one created, so a concurrently-started flow leaked its listener.
async function _resetPendingAuth() {
  const flows = [...authFlows.values()];
  authFlows.clear();
  authFlowCreations.clear();
  for (const flow of flows) {
    if (flow?.oauth) { try { await flow.oauth.cancel(); } catch {} }
  }
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
    let verifiedAlive = false;
    if (existingHandle) {
      try {
        const verification = await Promise.race([
          store.verifyAuthToken(config.getAuthToken()),
          new Promise(resolve => setTimeout(() => resolve(null), 2500))
        ]);
        sessionDead = !!(verification && verification.definitive && !verification.valid);
        // A DEFINITIVE "yes" is a different fact from the absence of a "no".
        // The principal fall-through below may only fire on a confirmed-alive
        // session; a timeout or an unreachable server is not evidence about
        // the credential, and treating it as such rebuilds the #91 sign-in
        // loop for anyone offline.
        verifiedAlive = !!(verification && verification.definitive && verification.valid);
      } catch (e) {}
      if (sessionDead) {
        console.error(`[vibe] Saved session for @${existingHandle} was rejected by the server — reconnecting.`);
      }
    }
    // #320: a session that proves only a HANDLE cannot exercise principal
    // authority (thought-bearing invitations refuse it with principal_required).
    // The server mints principal-bearing sessions on every fresh OAuth — but
    // this short-circuit was the trap: "Already signed in" left the legacy
    // credential in place with no path to the server's reauth action. A valid
    // handle-only token therefore falls through to re-auth — but ONLY when the
    // server confirmed the session is alive. Offline and timeout keep the
    // short-circuit, because unreachable is not invalid.
    const provesPrincipal = !!authStore.principalFromToken(config.getAuthToken());
    const needsReauthForPrincipal = existingHandle && !sessionDead && verifiedAlive && !provesPrincipal;
    if (needsReauthForPrincipal) {
      console.error(`[vibe] @${existingHandle}'s saved session proves the handle but not the principal — refreshing sign-in (server action: reauth).`);
      // …unless the last completed sign-in ALREADY came back handle-only. Then
      // reauth is not a fix, it is a loop, and the honest thing is to say so.
      const currentFp = tokenFingerprint(config.getAuthToken());
      if (lastSignInFailedToPersistFor
          && lastSignInFailedToPersistFor === normalizeHandle(existingHandle)) {
        return {
          display: `## Signed in as @${existingHandle} — but the credential could not be saved\n\n`
            + `The sign-in itself worked; writing it to disk did not, so this session is still `
            + `using the old credential and a restart will lose the new one. Check that `
            + `~/.vibe is writable, then say \`vibe init\` again.`,
        };
      }
      if (lastMintLackedPrincipalForToken && currentFp
          && lastMintLackedPrincipalForToken === currentFp) {
        return {
          display: `## Signed in as @${existingHandle} — but this session still proves only your handle\n\n`
            + `The server did not mint a principal claim into your last sign-in, so principal-gated actions `
            + `will still refuse with \`principal_required\`. The refreshed credential was saved. `
            + `Signing in again will not change this — it is a server-side minting issue, not something you did.`,
        };
      }
    }
    if (existingHandle && !sessionDead && !needsReauthForPrincipal) {
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
  // Bounded: the pre-auth banner must never hold the sign-in response hostage
  // to a slow presence fetch (review P1 — 'return immediately').
  const presence = await Promise.race([
    getPresenceCounts(),
    new Promise((resolve) => setTimeout(() => resolve({ online: 0, humans: 0, agents: 0 }), 1500)),
  ]);
  const welcomeBanner = generatePreAuthBanner(presence);

  // ===========================================
  // BROWSER AUTH (Default): GitHub OAuth
  // ===========================================
  if (auth_method === 'browser' || !auth_method) {
    // Save one_liner for the completion handler
    const cfg = config.load();
    if (h) cfg.handle = h;
    if (one_liner) cfg.one_liner = one_liner;
    cfg.pendingAuth = true;
    config.save(cfg);

    let flow;
    try {
      flow = await ensureAuthFlow({ requestedHandle: h, one_liner });
    } catch (error) {
      if (error?.message === 'AUTH_IN_PROGRESS') {
        return {
          display: `${welcomeBanner}\n\n**Sign in to /vibe**\nAnother /vibe session on this machine is already signing in — finish that one, then say vibe start.`,
          data: { state: 'auth_required', login_url: null, browser_opened: false, next: 'vibe start', sentence: AUTH_SENTENCE },
          structured: { state: 'auth_required', login_url: null, browser_opened: false, next: 'vibe start', sentence: AUTH_SENTENCE },
        };
      }
      return {
        display: `${welcomeBanner}\n\nCould not start sign-in (${error?.message || error}). Say vibe start to try again.`,
        data: { state: 'auth_error', next: 'vibe start' },
        structured: { state: 'auth_error', next: 'vibe start' },
      };
    }
    return authRequiredResult(flow, welcomeBanner);
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
  if (one_liner) cfg.one_liner = one_liner;   // same: absent is not "clear it"
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

module.exports = { definition, handler,  _resetPendingAuth, _forceExpireForTest, AUTH_SENTENCE, _completeSignInForTest: completeSignIn, _resetMintStateForTest: () => { lastMintLackedPrincipalForToken = null; lastSignInFailedToPersistFor = null; },
  _ensureAuthFlowForTest: ensureAuthFlow };
