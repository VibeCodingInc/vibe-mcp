#!/usr/bin/env node

/**
 * /vibe CLI entry point
 *
 * Routes commands:
 *   npx slashvibe-mcp        → auto-setup (if TTY + not initialized) or MCP server
 *   npx slashvibe-mcp setup  → interactive setup wizard
 *
 * This file exists because npm rejects "index.js" as a bin script name
 * in some versions (warning: "bin[slashvibe-mcp] script name index.js was invalid").
 * Using a dedicated cli.js avoids the issue entirely.
 */

const args = process.argv.slice(2);

const COMMANDS = ['setup', 'hook', 'trust', 'untrust', 'lines', 'quiet', 'unquiet', 'mute', 'unmute'];
const USAGE = `slashvibe-mcp: telepathic messaging, inside your coding agent

  npx slashvibe-mcp setup              install: configure your coding agent and sign in with GitHub
  npx slashvibe-mcp hook status        are the Claude Code hooks installed (also: install, uninstall)
  npx slashvibe-mcp trust @handle      open a line with someone you trust (close: untrust @handle)
  npx slashvibe-mcp lines              who you have an open line with
  npx slashvibe-mcp quiet              nothing reaches you while you work (undo: unquiet)
  npx slashvibe-mcp mute @handle       one person stops surfacing (undo: unmute @handle)

With no command it sets up on first run in a terminal; a coding agent starts it as an MCP server.
https://github.com/VibeCodingInc/vibe-mcp#readme`;

/**
 * `trust @handle`: open a line, but only with a person who is really there.
 *
 * Refuses, in order and before anything is written: a malformed handle; a
 * person who is not signed in (a line is between two identities); their own
 * handle; a handle /vibe does not know; and any failure to find out (fail
 * closed: "could not check" never opens a line). Then says who it is, in
 * words built here from allow-listed fields, never the server's raw text.
 */
async function trust(typed, line, say) {
  const h = line.norm(typed);
  if (!line.validHandle(h)) throw new Error(`"${typed}" is not a handle. A handle looks like @sam: letters, digits, - and _.`);

  const config = require('./config');
  const authStore = require('./auth-store');
  const cred = authStore.inspectToken(config.getAuthToken());
  if (!cred.ok) throw new Error('Sign in first: npx slashvibe-mcp setup');
  if (String(cred.handle || '').toLowerCase() === h) throw new Error(`@${h} is you.`);

  const base = String(config.getApiUrl ? config.getApiUrl() : (process.env.VIBE_API_URL || 'https://www.slashvibe.dev')).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let status; let who = null;
  try {
    const response = await fetch(`${base}/api/identity/${encodeURIComponent(h)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    status = response.status;
    if (response.ok) who = await response.json().catch(() => null);
  } catch {
    throw new Error(`Could not reach /vibe to check that @${h} exists. Try again in a moment.`);
  } finally {
    clearTimeout(timer);
  }
  if (status === 404) throw new Error(`There is no @${h} on /vibe. Check the spelling with the person.`);
  if (status !== 200 || !who || String(who.handle || '').toLowerCase() !== h) {
    throw new Error(`Could not confirm that @${h} exists (the check did not answer clearly). Try again in a moment.`);
  }

  const since = Number.isFinite(Date.parse(who.since)) ? new Date(who.since).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : null;
  const operator = typeof who.operator === 'string' && line.validHandle(line.norm(who.operator)) ? line.norm(who.operator) : null;
  const what = who.kind === 'agent' ? `an agent${operator ? ` run by @${operator}` : ''}` : who.kind === 'human' ? 'a person' : 'an account';
  say(`@${h} is ${what} on /vibe${since ? `, since ${since}` : ''}.`);

  line.open(h);
  say(`Open line with @${h}.`);
  say(`Your agent may now ask @${h}'s agent a question from your work, and answer theirs from yours, without stopping you. It is told to give information about the work only; the code caps it at ${line.MAX_PER_HOUR} messages an hour, refuses anything shaped like a credential, and marks each message as your agent's, unread by you. You are told what was said. It works both ways only if @${h} opens one with you.`);
  say(`Close it: npx slashvibe-mcp untrust @${h}`);
}

if (['help', '--help', '-h'].includes(args[0])) {
  process.stdout.write(`${USAGE}\n`);
} else if (['--version', '-v', 'version'].includes(args[0])) {
  process.stdout.write(`${require('./package.json').version}\n`);
} else if (args[0] && process.stdin.isTTY && !COMMANDS.includes(args[0]) && !args.includes('setup')) {
  // A person typed something we do not know. This used to fall through to the
  // full setup: "--help" wrote agent configs and opened GitHub in a browser.
  // Only on a terminal: a host that launches the server with arguments of its
  // own must still get the server.
  process.stderr.write(`Unknown command: ${args[0]}\n\n${USAGE}\n`);
  process.exitCode = 1;
} else if (args[0] === 'hook') {
  require('./hook-cli')
    .run(args.slice(1))
    .catch((error) => {
      if (args[1] === 'run') {
        process.stdout.write(JSON.stringify({ suppressOutput: true }));
      } else {
        process.stderr.write(`${error?.message || error}\n`);
        process.exitCode = 1;
      }
    });
} else if (['trust', 'untrust', 'lines'].includes(args[0])) {
  // Open lines (line.js). This command, typed by the person, is the ONLY way a
  // line opens; nothing a session's agent can call does it.
  const line = require('./line');
  const say = (t) => process.stdout.write(`${t}\n`);
  try {
    if (['trust', 'untrust'].includes(args[0]) && args.length > 2) {
      // One handle, exactly as typed. "trust @sam and @ada" must not quietly
      // open a line with whoever the first word happens to name.
      throw new Error(`One handle at a time: npx slashvibe-mcp ${args[0]} @handle`);
    } else if (args[0] === 'trust' && args[1]) {
      // Opening a line is a grant to a specific person, so it is checked like
      // one: a typo must not hand the line to whoever owns the misspelling.
      trust(args[1], line, say).catch((error) => {
        process.stderr.write(`${error?.message || error}\nNo line was opened.\n`);
        process.exitCode = 1;
      });
    } else if (args[0] === 'untrust' && args[1]) {
      say(line.close(args[1]) ? `Closed the line with @${line.norm(args[1])}.` : `There was no open line with @${line.norm(args[1])}.`);
    } else {
      const open = line.list();
      say(open.length ? `Open lines: ${open.map((h) => `@${h}`).join(', ')}` : 'No open lines.');
      say('Open one: npx slashvibe-mcp trust @handle   ·   close one: npx slashvibe-mcp untrust @handle');
    }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
} else if (['quiet', 'unquiet', 'mute', 'unmute'].includes(args[0])) {
  // Who may reach you while you work (reach.js). Local, and yours to type.
  const reach = require('./reach');
  const say = (t) => process.stdout.write(`${t}\n`);
  try {
    if (args[0] === 'quiet') { reach.setQuiet(true); say('Quiet. Nothing will reach you while you work; messages wait until you ask what is waiting. Turn it off: npx slashvibe-mcp unquiet'); }
    else if (args[0] === 'unquiet') { reach.setQuiet(false); say('Quiet is off. Messages from people you know reach you while you work again.'); }
    else if (args[0] === 'mute' && args[1]) { const h = reach.mute(args[1]); say(`Muted @${h}. Their messages will not surface in your sessions; they stay in the conversation. Undo: npx slashvibe-mcp unmute @${h}`); }
    else if (args[0] === 'unmute' && args[1]) { say(reach.unmute(args[1]) ? `Unmuted @${reach.norm(args[1])}.` : `@${reach.norm(args[1])} was not muted.`); }
    else { const m = reach.muted(); say(`${reach.isQuiet() ? 'Quiet is on.' : 'Quiet is off.'} ${m.length ? `Muted: ${m.map((h) => `@${h}`).join(', ')}` : 'Nobody is muted.'}`); say('npx slashvibe-mcp quiet | unquiet | mute @handle | unmute @handle'); }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
} else if (args.includes('setup')) {
  require('./setup.js');
} else if (process.stdin.isTTY) {
  // Running from terminal (not as MCP server)
  const config = require('./config');
  const authStore = require('./auth-store');

  // A TOKEN EXISTING IS NOT BEING SIGNED IN.
  //
  // This used to pass on `config.getAuthToken()` being truthy, which is true of a
  // credential that expired months ago. On a Mac Studio holding a token 23 days dead it
  // printed "/vibe is configured" and suggested restarting the coding agent — advice that
  // cannot help, given to someone whose only real problem was that they were signed out.
  // The recovery path told them there was nothing to recover.
  const cred = authStore.inspectToken(config.getAuthToken());

  if (!config.isInitialized() && !cred.ok) {
    // Never signed in — set up.
    require('./setup.js');
  } else if (!cred.ok && cred.reason !== 'none') {
    // Signed in once, not any more. Say which, and fix it rather than describing it.
    const when = cred.expiresAt
      ? ` (it expired ${Math.max(1, Math.round((Date.now() - cred.expiresAt) / 86400000))} days ago)`
      : '';
    console.log(cred.handle
      ? `Your /vibe sign-in for @${cred.handle} is no longer valid${when}.`
      : `Your /vibe sign-in is no longer valid${when}.`);
    console.log('Signing you back in...');
    console.log('');
    require('./setup.js');
  } else {
    // Genuinely signed in — say WHO, because a status line that cannot name you is the
    // one that hid this in the first place.
    console.log(cred.handle
      ? `/vibe is configured — signed in as @${cred.handle}.`
      : '/vibe is configured.');
    console.log('Restart your coding agent (Claude Code / Codex / Cursor) to connect.');
    console.log('');
    console.log('Commands:');
    console.log('  npx slashvibe-mcp setup   — re-run setup wizard');
    console.log('');
    console.log('In your coding agent, say "what\'s waiting on /vibe" to get started.');
    process.exit(0);
  }
} else {
  // Running as MCP server (stdin is a pipe from Claude Code).
  //
  // The same shape is an agent running the install line for its person from a
  // shell tool: no terminal, so no setup, and until now no word of why. Say it
  // once on stderr (a host ignores it; an agent's shell shows it). Only before
  // first sign-in, so a working install stays silent.
  try {
    const config = require('./config');
    if (!config.isInitialized() && !config.getAuthToken()) {
      process.stderr.write('slashvibe-mcp: no terminal here, so this started as an MCP server and is waiting for a coding agent. To install /vibe, run: npx slashvibe-mcp setup\n');
    }
  } catch {}
  require('./index.js');
}
