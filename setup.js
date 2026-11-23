#!/usr/bin/env node

/**
 * vibe setup — One-click installation for /vibe MCP server
 *
 * Usage: npx slashvibe-mcp setup
 *
 * What it does:
 * 1. Finds Claude Code's config (~/.claude.json)
 * 2. Adds /vibe MCP server to the config
 * 3. Tests the connection
 * 4. Opens browser for GitHub auth
 *
 * Result: User is fully set up in ~30 seconds
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');
const { beginOAuth } = require('./oauth-callback');
const actorSession = require('./actor-session');

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

const API_BASE = 'https://www.slashvibe.dev';

/**
 * Print styled banner
 */
function printBanner() {
  console.log(`
${colors.green}  █░█ █ █▄▄ █▀▀${colors.reset}
${colors.green}  ▀▄▀ █ █▄█ ██▄${colors.reset}   ${colors.dim}telepathic messaging, inside your coding agent${colors.reset}
  ──────────────────────────────────────────────────
`);
}

/**
 * Print step with status
 */
function printStep(num, text, status = 'pending') {
  const statusIcon = {
    pending: colors.dim + '○' + colors.reset,
    running: colors.yellow + '◐' + colors.reset,
    done: colors.green + '●' + colors.reset,
    error: colors.red + '✗' + colors.reset
  }[status];

  console.log(`  ${statusIcon} ${colors.bold}Step ${num}:${colors.reset} ${text}`);
}

// ─── Universal installer ─────────────────────────────────────────────────
// One npx configures every coding agent on the machine that speaks MCP:
// Claude Code. (Earlier versions also wrote Codex and Cursor configs; see below.)
// A host is configured when its config dir/file exists (i.e. it's installed);
// Claude Code is always configured (creating ~/.claude.json if needed) so the
// original single-host behavior is preserved.

const VIBE_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'slashvibe-mcp@latest'],
  env: {
    VIBE_API_URL: 'https://www.slashvibe.dev'
  }
};

/**
 * Find Claude Code config file
 */
function findClaudeConfig() {
  const homeDir = os.homedir();

  // Possible config locations
  const configPaths = [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(homeDir, '.config', 'claude', 'config.json'),
    path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  // Nothing found. Returning a path anyway made setup report "→ Claude Code" and
  // "configured" on machines with no Claude Code at all — a success message for work
  // that helps nobody, and the reason "no supported host" was unreachable. Callers
  // now get null and decide honestly; the default path is only for the create case,
  // which is signalled explicitly.
  return null;
}

/** Where we WOULD write a Claude Code config if the user wants one created. */
function defaultClaudeConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Load existing JSON config. Distinguishes the three states that matter:
 *   missing file  → {}   (safe to create)
 *   parseable     → the parsed object
 *   CORRUPT file  → null (NEVER write — overwriting would destroy whatever
 *                   else lives in e.g. ~/.claude.json beyond mcpServers)
 */
function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Save JSON config to file
 */
function saveConfig(configPath, config) {
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, content, 'utf8');
}

/**
 * Add vibe to an mcpServers-style JSON config (Claude Code).
 * Returns 'added' | 'exists'. Throws (without writing) if the existing
 * config is unparseable — the user's file is corrupt-but-recoverable and
 * clobbering it with only our entry would make that permanent.
 */
function addVibeToJsonConfig(configPath) {
  const config = loadConfig(configPath);
  if (config === null) {
    throw new Error(`existing config is not valid JSON — fix it by hand, not overwriting: ${configPath}`);
  }
  if (!config.mcpServers) config.mcpServers = {};
  if (config.mcpServers.vibe) return 'exists';
  config.mcpServers.vibe = VIBE_SERVER_ENTRY;
  saveConfig(configPath, config);
  return 'added';
}

/**
 * Configure Claude Code (~/.claude.json et al).
 *
 * Cursor and Codex only configure when their directories exist; Claude Code used to
 * configure unconditionally, inventing ~/.claude.json on machines that had never run
 * it. That is what made setup announce "→ Claude Code · configured" during a walk on
 * a clean machine with no Claude Code installed. Same rule for all three hosts now:
 * we write where the host actually lives, and say so honestly when none is found.
 */
function configureClaudeCode({ createIfMissing = false } = {}) {
  const found = findClaudeConfig();
  const configPath = found || (createIfMissing ? defaultClaudeConfigPath() : null);
  if (!configPath) return null; // Claude Code not installed here
  try {
    return { host: 'Claude Code', path: configPath, status: addVibeToJsonConfig(configPath) };
  } catch (e) {
    return { host: 'Claude Code', path: configPath, status: 'error', error: e.message };
  }
}

// CLAUDE CODE ONLY (2026-11-14). This file used to add /vibe to Cursor and Codex
// as well, write a Codex prompt, and announce "Claude Code, Codex, Cursor". What
// /vibe does (a message reaching you while you work, who's here, doors) runs on
// Claude Code hooks, and everything we publish names Claude Code only. Setup
// writing into two other tools' configuration, for a product we do not say
// supports them, is a surprise on someone's machine. Configs written by earlier
// versions are left exactly as they are.

/**
 * Configure Claude Code. Returns the result (a list, for the callers that print it).
 */
function configureAllHosts() {
  const found = [configureClaudeCode()].filter(Boolean);
  // No host detected at all — someone ran this before installing a coding agent, or
  // in a container. Rather than silently doing nothing (or, as before, inventing a
  // Claude Code config to have something to report), create the Claude Code config so
  // /vibe is wired the moment they install it, and let the caller say which case it is.
  if (found.length === 0) {
    const created = configureClaudeCode({ createIfMissing: true });
    return created ? [{ ...created, hostWasMissing: true }] : [];
  }
  return found;
}

/**
 * Install the /vibe host command (host-command.js): where none exists, or
 * where the file there is exactly one an earlier release installed. A person's
 * own /vibe is never overwritten. The server also updates an earlier
 * release's copy at every start (host-command.js refresh).
 */
function installHostCommands() {
  return require('./host-command').install();
}

/**
 * Test API connection
 */
async function testConnection() {
  // Found by actually RUNNING this on a clean machine, which no amount of reading
  // the code surfaced: /api/health answers `{"status":"healthy"}`, and this asked
  // for `'ok'`. So every first run — on a perfectly good connection — printed
  // "Could not reach slashvibe.dev" and three troubleshooting steps, to a person
  // whose very first experience of /vibe was being told it was broken.
  //
  // The client no longer guesses at the server's vocabulary. Reachability is what
  // HTTP already answers; the body is only allowed to veto by reporting an explicit
  // unhealthy state.
  // Bounded: a hung connection must not leave a new user staring at a spinner with no
  // way to know whether to wait.
  //
  // "DEGRADED" IS NOT UNREACHABLE, and treating it as such blocked every new install on
  // 2026-08-01. Upstash hit a quota wall, /api/health honestly reported `degraded`
  // because a CACHE was down, and this returned false — so setup told people "Could not
  // reach slashvibe.dev" and advised them to check their internet connection, about a
  // site that was serving perfectly.
  //
  // The reasoning in the version that did this was mine and it was wrong: I blocked on
  // degraded because "the next step is an OAuth round trip". OAuth does not touch the
  // cache. A partial-capability signal about a subsystem we do not need is not a reason
  // to refuse someone the product, and "we cannot reach the server" is not a true thing
  // to say when we just did.
  //
  // Only an explicitly unhealthy service blocks. Everything else proceeds, because the
  // OAuth round trip that follows is a better test of what setup actually needs than any
  // status string.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API_BASE}/api/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (data.success === false) return false;
    if (typeof data.status === 'string' && /\bunhealthy\b|\bdown\b/i.test(data.status)) return false;
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// NO ROSTER HERE (2026-11-14). Setup used to print "N people here now" and, after
// sign-in, list up to five of them by handle with what each says they are working
// on: strangers, shown to a newcomer in their first minute, by a product whose
// promise is that only people you know are put in front of you. Who's here is one
// line at session start, for people you know (session-start-hook.cjs).

/**
 * Open URL in browser
 */
function openBrowser(url) {
  // Release conformance runs the real walk on a build machine; opening a browser there
  // would authenticate against production as whoever that machine is signed in as.
  // Nothing in normal use sets this.
  if (process.env.VIBE_SETUP_STUB_BROWSER === '1') {
    console.log(`${colors.dim}  (browser suppressed for conformance run)${colors.reset}`);
    return;
  }
  // No shell: the URL is one argument to the opener, so nothing in it (a
  // quote, an &, a $) can be read as a command.
  let file;
  let args;
  if (process.platform === 'darwin') {
    file = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    // `cmd /c start` would hand the URL to cmd's parser, where & ends the
    // command. The URL handler opens it in the default browser without one.
    file = 'rundll32'; args = ['url.dll,FileProtocolHandler', url];
  } else {
    file = 'xdg-open'; args = [url];
  }

  execFile(file, args, (err) => {
    if (err) {
      console.log(`${colors.yellow}  Could not open browser automatically.${colors.reset}`);
      console.log(`${colors.cyan}  Please open: ${url}${colors.reset}`);
    }
  });
}

/**
 * Save auth config
 */
function saveAuthConfig(handle, token) {
  // THE identity directory comes from vibe-home.js — never hardcode ~/.vibe.
  // This function used to, so running an ISOLATED setup (VIBE_HOME=~/.vibe-x)
  // silently overwrote the machine's normal profile at ~/.vibe/config.json
  // (Stage-0 incident, 2026-08-19).
  const { vibeHome } = require('./vibe-home');
  const vibeDir = vibeHome();

  // Create the identity directory if not exists — and ENFORCE 0700 either way:
  // mkdir's mode is umask-masked and does nothing for a pre-existing dir.
  if (!fs.existsSync(vibeDir)) {
    fs.mkdirSync(vibeDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(vibeDir, 0o700);

  // Save config — 0600: it carries the auth token.
  //
  // MERGE, never replace. This wrote four fields over the whole file, so signing in
  // again erased everything else the person had set on this machine (found
  // 2026-11-14, on the founder's own config).
  const configPath = path.join(vibeDir, 'config.json');
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {}
  const config = {
    ...existing,
    handle,
    username: handle,
    authToken: token,
    authMethod: 'browser',
    authenticatedAt: new Date().toISOString()
  };
  delete config.privyToken;
  delete config.pendingAuth;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created. One that already existed with
  // looser permissions kept them while holding the token.
  fs.chmodSync(configPath, 0o600);
  retireDeadCredential(vibeDir, handle);
}

/**
 * ONE CREDENTIAL PER IDENTITY. A second file, auth.json, can hold a sign-in for the
 * same handle (other /vibe clients write it). After a fresh sign-in here, a copy
 * there that has EXPIRED is a dead credential with the person's name on it: nothing
 * can use it, and anything that reads it is misled (it showed the founder as about
 * to be signed out a day after he had signed in). Remove it, and only it: a token
 * that is still valid, belongs to someone else, or cannot be read is left alone.
 */
function retireDeadCredential(vibeDir, handle) {
  const file = path.join(vibeDir, 'auth.json');
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = stored && stored.token;
    if (typeof token !== 'string') return false;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const whose = String(claims.handle || claims.sub || '').toLowerCase();
    const expired = Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now();
    if (whose !== String(handle).toLowerCase() || !expired) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ── the installer's last lines (notice.js setupReceipt) ─────────────────────

const RECEIPT_HANDLE = /^[a-z0-9][a-z0-9_-]{1,38}$/;
const RECEIPT_READ_MS = 3000;

/**
 * Notes waiting for the person who just signed in: ONE read of their
 * conversation list, bounded, no retry. Returns { total, named, others }, or
 * null when the read failed, timed out, or answered in a shape it does not
 * know (then nothing is said about notes). Only the other person's words
 * count, unread and last in their conversation, as the session-start hook
 * counts them; never an agent, a muted person or a door card. Handles are
 * named only for people this machine knows (written to, an open line, the
 * inviter marked by --from): the same rule as every other surface, so a
 * stranger's handle is counted ("1 other"), never printed. No message text
 * is read into anything that is printed.
 */
async function readWaiting({ apiUrl, token, handle, fetchImpl = fetch, timeoutMs = RECEIPT_READ_MS, env = process.env } = {}) {
  const me = String(handle || '').toLowerCase();
  if (!token || !RECEIPT_HANDLE.test(me)) return null;
  const reach = require('./reach');
  const line = require('./line');
  const door = require('./door');
  if (reach.isQuiet(env)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const base = String(apiUrl || '').replace(/\/+$/, '');
    const response = await fetchImpl(`${base}/api/messages?user=${encodeURIComponent(me)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!response || !response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!body || body.success === false || !Array.isArray(body.threads)) return null;
  let total = 0;
  const named = [];
  let others = 0;
  for (const t of body.threads) {
    const last = t && t.last_message;
    if (!last || !(Number(t.unread) > 0)) continue;
    const from = String(last.from || '').toLowerCase();
    if (!from || from === me) continue;
    if ((last.actor && last.actor.kind === 'agent') || reach.isMuted(from, env)) continue;
    if (typeof last.body === 'string' && door.parseCard(last.body)) continue;
    total += Math.max(1, Math.floor(Number(t.unread)) || 1);
    let known = false;
    try { known = RECEIPT_HANDLE.test(from) && (reach.isKnown(from, env) || line.isOpen(from, env)); } catch { known = false; }
    if (known && !named.includes(from)) named.push(from);
    else if (!known) others += 1;
  }
  return { total, named, others };
}

/** "1 note waiting from @ben." and the like; null when nothing was found or nothing was read. Pure. */
function waitingLine(w) {
  if (!w || !(w.total > 0)) return null;
  const notes = `${w.total} ${w.total === 1 ? 'note' : 'notes'} waiting`;
  const named = (Array.isArray(w.named) ? w.named : []).filter((h) => RECEIPT_HANDLE.test(h));
  const shown = named.slice(0, 2).map((h) => `@${h}`);
  const rest = named.length - shown.length + (Number.isInteger(w.others) && w.others > 0 ? w.others : 0);
  if (shown.length === 0) {
    return rest > 1 ? `${notes}, from ${rest} people you have not written to.` : `${notes}, from someone you have not written to.`;
  }
  if (rest === 0 && shown.length === 1) return `${notes} from ${shown[0]}.`;
  if (rest === 0) return `${notes}, from ${shown[0]} and ${shown[1]}.`;
  return `${notes}, from ${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}.`;
}

const FRESH_SESSION = 'Open a fresh Claude Code session to load /vibe. Sessions that are already open will not see it.';

/**
 * The installer's last lines, in order: notes waiting (only when the read
 * found some), the fresh-session line, then the lines about who invited them
 * (invite.accept: only what it confirmed). Pure: [{ text, strong }].
 *
 * `invited` (the person came with --from): who invited them comes first, the
 * first of those lines strong, then the notes waiting, and the fresh-session
 * line stays last. Someone who was just invited is not first asked to invite
 * someone else (setup.js leaves the "takes two" block out for them).
 */
function finalLines({ waiting = null, inviteLines = [], invited = false } = {}) {
  const out = [];
  const w = waitingLine(waiting);
  const inv = (Array.isArray(inviteLines) ? inviteLines : []).filter((l) => typeof l === 'string' && l);
  if (invited) {
    inv.forEach((l, i) => out.push({ text: l, strong: i === 0 }));
    if (w) out.push({ text: w, strong: true });
    out.push({ text: FRESH_SESSION, strong: true });
    return out;
  }
  if (w) out.push({ text: w, strong: true });
  out.push({ text: FRESH_SESSION, strong: true });
  for (const l of inv) out.push({ text: l, strong: false });
  return out;
}

/**
 * Main setup function
 */
async function setup() {
  printBanner();
  console.log(`${colors.bold}  One-Click Setup${colors.reset}`);
  console.log('');

  // Step 1: Detect coding agents on this machine
  printStep(1, 'Looking for Claude Code...', 'running');
  const homeDir = os.homedir();
  // Detection reports what is HERE. `['Claude Code'] // always configured` was a
  // detection step that had already decided its answer: a machine with no Claude Code
  // was still told "→ Claude Code". #115 made the configuration honest but left this
  // line printing the old claim, which is the difference between fixing the internals
  // and fixing what a person actually reads.
  const detected = [];
  if (findClaudeConfig()) detected.push('Claude Code');
  console.log(detected.length
    ? `${colors.dim}     → Claude Code${colors.reset}`
    : `${colors.dim}     → not found yet — setting it up so /vibe is ready when you install Claude Code${colors.reset}`);
  printStep(1, 'Looking for Claude Code...', 'done');

  // Step 2: Add /vibe MCP server to Claude Code
  printStep(2, 'Adding /vibe MCP server...', 'running');
  const hostResults = configureAllHosts();
  const hostCommands = installHostCommands();
  for (const c of hostCommands) console.log(c.error ? `  (could not install the /vibe command for ${c.host}: ${c.error} — everything else still works)` : `  /vibe command ${c.replaced ? 'updated' : 'installed'} for ${c.host}: ${c.path}`);
  for (const r of hostResults) {
    const note = r.status === 'added' ? 'configured'
      : r.status === 'exists' ? 'already configured'
      : `failed: ${r.error}`;
    const icon = r.status === 'error' ? colors.yellow + '!' : colors.green + '✓';
    const label = r.hostWasMissing ? `${r.host} ${colors.dim}(not installed yet)` : r.host;
    console.log(`     ${icon}${colors.reset} ${label} ${colors.dim}— ${note} (${r.path})${colors.reset}`);
  }
  const configuredCount = hostResults.filter(r => r.status !== 'error').length;
  if (configuredCount === 0) {
    // Every host failed — don't march the user into auth with no working
    // MCP config and then report success.
    printStep(2, 'Adding /vibe MCP server...', 'error');
    console.log(`${colors.red}     → No coding agent could be configured — fix the errors above and re-run setup${colors.reset}`);
    process.exit(1);
  }
  if (configuredCount < hostResults.length) {
    console.log(`${colors.yellow}     → Partial install: ${configuredCount}/${hostResults.length} configured${colors.reset}`);
  }
  printStep(2, 'Adding /vibe MCP server...', 'done');

  // Step 3: Test connection
  printStep(3, 'Testing connection...', 'running');
  const connected = await testConnection();
  if (!connected) {
    printStep(3, 'Testing connection...', 'error');
    console.log(`${colors.red}     → Could not reach slashvibe.dev${colors.reset}`);
    console.log('');
    console.log(`${colors.bold}  Troubleshooting:${colors.reset}`);
    console.log(`${colors.dim}  1. Check your internet connection${colors.reset}`);
    console.log(`${colors.dim}  2. Try: ${colors.cyan}curl -s https://www.slashvibe.dev/api/health${colors.reset}`);
    console.log(`${colors.dim}  3. If that works, try setup again${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.dim}     → Connected${colors.reset}`);
  printStep(3, 'Testing connection...', 'done');

  // Step 4: Authenticate
  printStep(4, 'Opening browser for GitHub auth...', 'running');

  let oauth;

  try {
    // The callback listener is bound before beginOAuth returns, so the browser
    // cannot race a listener that does not exist yet.
    oauth = await beginOAuth({ actorAware: true, inviteCode: require('./invite').inviteArg() });
    openBrowser(oauth.loginUrl);
    console.log(`${colors.dim}     → Waiting for authentication...${colors.reset}`);
    // Always say where to go. The browser may have opened on a screen nobody is
    // looking at (SSH), or not at all, and "waiting" with no link is a dead end.
    console.log(`${colors.dim}     → If no browser opened, open this to sign in:${colors.reset}`);
    console.log(`       ${colors.cyan}${oauth.loginUrl}${colors.reset}`);

    const authResult = await oauth.waitForCallback();

    if (authResult.actor) await actorSession.installOAuthSession(authResult.actor);
    else await actorSession.clearActorSession();

    // Save auth config
    saveAuthConfig(authResult.handle, authResult.token);

    printStep(4, 'Opening browser for GitHub auth...', 'done');
    console.log(`${colors.dim}     → Authenticated as @${authResult.handle}${colors.reset}`);

    const receipt = require('./notice').on('setupReceipt');
    console.log('');
    // What was observed: Claude Code's config has /vibe, and this sign-in
    // returned. No exclamation marks, no welcome (docs/VOICE.md).
    console.log(receipt
      ? `${colors.green}  ✓ /vibe is set up for Claude Code, signed in as @${authResult.handle}.${colors.reset}`
      : `${colors.green}  ✓ Setup complete!${colors.reset}`);
    console.log('');

    if (receipt) {
      console.log(`${colors.dim}  In a new session, say "what's waiting on /vibe" to see who has written to you,${colors.reset}`);
      console.log(`${colors.dim}  or "message @their-handle: ..." to write to someone.${colors.reset}`);
    } else {
      console.log(`${colors.bold}  Quick start:${colors.reset}`);
      console.log(`${colors.dim}  1. Restart your Claude Code session${colors.reset}`);
      console.log(`${colors.dim}  2. Say: "what's waiting on /vibe" to see who has written to you${colors.reset}`);
      console.log(`${colors.dim}     or: "message @their-handle: ..." to write to someone${colors.reset}`);
    }
    // Receiving is the product: a reply has to reach you while you work, not
    // when you remember to ask. So the hooks are installed here, by default,
    // for Claude Code — stated plainly, with the one command that removes them.
    let hooksInstalled = false;
    // An ISOLATED identity (VIBE_HOME set) must not write hooks into the
    // machine's real ~/.claude/settings.json — that would point the everyday
    // Claude at a lab identity's spool. It installs only when the Claude
    // config is isolated too (CLAUDE_CONFIG_DIR).
    const isolatedIdentity = require('./vibe-home').isIsolated() && !process.env.CLAUDE_CONFIG_DIR;
    if (detected.includes('Claude Code') && process.env.VIBE_SETUP_NO_HOOKS !== '1' && !isolatedIdentity) {
      try {
        require('./session-start-hook-settings').createHookSettingsManager().install();
        hooksInstalled = require('./arrival-hook-settings').createArrivalHookManager().install().installed;
      } catch (e) {
        hooksInstalled = false;
      }
    }
    const step3 = receipt ? '' : '3. ';
    console.log(hooksInstalled
      ? `${colors.dim}  ${step3}When someone writes back, it reaches you inside Claude Code while you work (hooks added to ~/.claude/settings.json; remove with "npx slashvibe-mcp hook uninstall")${colors.reset}`
      : `${colors.dim}  ${step3}Claude Code: run "npx slashvibe-mcp hook install" — replies then reach you while you work${colors.reset}`);
    console.log('');
    if (!receipt) {
      console.log(`${colors.cyan}  Welcome to /vibe, @${authResult.handle}.${colors.reset}`);
      console.log('');
    }

    // The inviter is known from the first minute. Marked before the inbox is
    // read below, so a note from them is named there.
    const invite = require('./invite');
    const from = invite.fromArg();
    let inviteLines = [];
    if (from) {
      // With --invite, only a --from the code is consistent with is named (invite.codeIsFrom).
      const got = await invite.accept(from, authResult.handle, { code: invite.inviteArg() });
      inviteLines = got.lines;
      if (!receipt) {
        for (const l of inviteLines) console.log(`${colors.dim}  ${l}${colors.reset}`);
        if (inviteLines.length) console.log('');
      }
    }
    // The line carries a code minted on this account, so whoever installs from
    // it is someone this person knows once they sign in (invite.codeFor).
    // Someone who arrived with --from is not asked to invite someone else on
    // this screen, and none of their codes is spent on it (setupReceipt). Their
    // own line is still offered by vibe_start while they have no conversation,
    // and by an invite-line message (vibe_prepare invite: true).
    const invitedHere = receipt && Boolean(from);
    const bring = invitedHere ? null : invite.line(authResult.handle, await invite.codeFor(authResult.handle));
    if (bring) {
      invite.noteGiven();
      console.log(`${colors.bold}  /vibe takes two. Send this to the person you build with:${colors.reset}`);
      console.log(`${colors.cyan}  ${bring.command}${colors.reset}`);
      console.log(`${colors.dim}  or the page: ${bring.link}${colors.reset}`);
      console.log('');
    }

    // The last lines (notice.js setupReceipt): notes already waiting, if one
    // bounded read just now found any; that /vibe loads only in a session
    // opened from here on; and who invited them. A person usually runs this
    // beside a Claude Code session that is already open, goes back to it,
    // finds no /vibe there and concludes nothing happened.
    if (receipt) {
      let waiting = null;
      try { waiting = await readWaiting({ apiUrl: API_BASE, token: authResult.token, handle: authResult.handle }); } catch { waiting = null; }
      for (const l of finalLines({ waiting, inviteLines, invited: invitedHere })) {
        console.log(`${l.strong ? colors.bold : colors.dim}  ${l.text}${colors.reset}`);
      }
      console.log('');
    }

    // No analytics ping here (#9.3). SECURITY.md promises "/vibe does not
    // collect usage analytics", and this file was the one place that broke
    // that promise (a setup_complete event). Setup completion is already
    // observable server-side — the OAuth token mint above IS the signal —
    // so the event carried no information the server didn't have.
    // _no-telemetry.test.js keeps this file (and every other) clean.

  } catch (err) {
    printStep(4, 'Opening browser for GitHub auth...', 'error');

    // Specific error recovery messages
    if (err.message === 'AUTH_TIMEOUT') {
      console.log(`${colors.red}     → Authentication timed out (5 min limit)${colors.reset}`);
      console.log('');
      console.log(`${colors.yellow}  What happened:${colors.reset}`);
      console.log(`${colors.dim}  The browser auth wasn't completed in time.${colors.reset}`);
      console.log('');
      console.log(`${colors.bold}  Try again:${colors.reset}`);
      console.log(`${colors.cyan}  npx slashvibe-mcp setup${colors.reset}`);
    } else if (err.message === 'AUTH_IN_PROGRESS') {
      console.log(`${colors.red}     → Auth callback port busy${colors.reset}`);
      console.log('');
      console.log(`${colors.yellow}  What happened:${colors.reset}`);
      console.log(`${colors.dim}  Another setup or auth process is running.${colors.reset}`);
      console.log('');
      console.log(`${colors.bold}  Fix it:${colors.reset}`);
      console.log(`${colors.dim}  1. Wait a minute for it to finish, or${colors.reset}`);
      console.log(`${colors.dim}  2. Kill the process: ${colors.cyan}lsof -ti:9876 | xargs kill${colors.reset}`);
      console.log(`${colors.dim}  3. Try again: ${colors.cyan}npx slashvibe-mcp setup${colors.reset}`);
    } else {
      console.log(`${colors.red}     → ${err.message}${colors.reset}`);
      console.log('');
      console.log(`${colors.bold}  Try these steps:${colors.reset}`);
      console.log(`${colors.dim}  1. Check internet connection${colors.reset}`);
      console.log(`${colors.dim}  2. Try again: ${colors.cyan}npx slashvibe-mcp setup${colors.reset}`);
      console.log(`${colors.dim}  3. The link above still works if the browser did not open${colors.reset}`);
    }
    if (oauth && err.message !== 'AUTH_TIMEOUT') await oauth.cancel();
    console.log('');
    console.log(`${colors.dim}  Need help? https://github.com/VibeCodingInc/vibe-mcp/issues${colors.reset}`);
    // On timeout the shared listener remains live during its grace window so a
    // late browser callback gets the explanatory page instead of a refusal.
    process.exitCode = 1;
  }
}

/**
 * Run setup as a person runs it: the walk, and a non-zero exit if it fails.
 * The only two callers are this file as the entry point (`vibe-setup`, `node
 * setup.js`) and cli.js on `npx slashvibe-mcp setup`.
 *
 * VIBE_SETUP_NO_AUTORUN=1 refuses even an explicit run: test suites and the lab
 * set it for every process they start, so nothing below them can sign in to
 * production as whoever owns the machine. Nothing in normal use sets it.
 */
function run() {
  if (process.env.VIBE_SETUP_NO_AUTORUN === '1') {
    process.stderr.write('slashvibe-mcp: setup not run (VIBE_SETUP_NO_AUTORUN=1 is set in this environment).\n');
    process.exitCode = 1;
    return Promise.resolve();
  }
  return setup().catch(err => {
    console.error(`${colors.red}Setup failed: ${err.message}${colors.reset}`);
    process.exit(1);
  });
}

// Loading this module does nothing. It used to run setup on require, so anything
// that so much as inspected setup.js (a test, a one-liner, a tool reading its
// exports) opened a browser, wrote host configs and signed in to production as the
// machine's real user. That happened twice. Setup runs only when this file is the
// entry point, or when cli.js calls run().
if (require.main === module) run();

// Named exports for tests and for callers that want a piece rather than the whole
// ceremony. Deliberately narrow.
module.exports = {
  run,
  setup,
  findClaudeConfig,
  configureAllHosts,
  testConnection,
  saveAuthConfig,
  retireDeadCredential,
  installHostCommands,
  SHIPPED_COMMAND_SHA256: require('./host-command').SHIPPED_COMMAND_SHA256,
  openBrowser,
  readWaiting,
  waitingLine,
  finalLines,
  FRESH_SESSION,
};
