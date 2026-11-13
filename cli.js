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

const COMMANDS = ['setup', 'hook', 'trust', 'untrust', 'lines', 'quiet', 'unquiet', 'mute', 'unmute', 'door', 'invisible', 'visible', 'agent', 'operate'];
const USAGE = `slashvibe-mcp: telepathic messaging, inside your coding agent

  npx slashvibe-mcp setup              install: configure your coding agent and sign in with GitHub
  npx slashvibe-mcp hook status        are the Claude Code hooks installed (also: install, uninstall)
  npx slashvibe-mcp trust @handle      open a line with someone you trust (close: untrust @handle)
  npx slashvibe-mcp lines              who you have an open line with
  npx slashvibe-mcp quiet              nothing reaches you while you work (undo: unquiet)
  npx slashvibe-mcp mute @handle       one person stops surfacing (undo: unmute @handle)
  npx slashvibe-mcp invisible          be here without showing as here (undo: visible)
  npx slashvibe-mcp operate @agent     say you run an agent, so people see "run by @you" (also: renew, revoke)
  npx slashvibe-mcp agent              for an agent signing in as itself, not a person
  npx slashvibe-mcp door https://...   leave a door: a link to what you are building (then: door share, door close)

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

/**
 * `door`: leave a link to the thing you are building with people you know.
 *
 *   door                       your door, and who holds it
 *   door https://... [name]    set it (local; tells nobody)
 *   door share [@handle]       leave it with everyone you know, or one of them
 *   door close                 take it down, and tell the people who held it
 *
 * Typed by the person, like `trust`: there is no tool for any of it. Sharing
 * sends one message per person, through the same single send path as every
 * other message, and only to people this person has already written to or has
 * an open line with. Nothing is published anywhere.
 */
async function doorCli(argv, say) {
  const door = require('./door');
  const line = require('./line');
  const reach = require('./reach');
  const config = require('./config');
  const authStore = require('./auth-store');
  const sub = argv[0];
  const people = () => [...new Set([...reach.known(), ...line.list()])].sort();
  const signedIn = () => {
    const cred = authStore.inspectToken(config.getAuthToken());
    if (!cred.ok) throw new Error('Sign in first: npx slashvibe-mcp setup');
    authStore.hydrate();
    return String(cred.handle || '').toLowerCase();
  };
  const send = async (to, message) => {
    const { deliver } = require('./tools/deliver');
    const r = await deliver({ to, message });
    return Boolean(r && r.data && r.data.sent);
  };
  // deliver() and the store talk on stderr; a person typing a command wants the outcome.
  const hush = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

  if (!sub) {
    const mine = door.mine();
    if (!mine) {
      say('You have not left a door.');
      say('A door is a link to the thing you are building. The people you leave it with can say "visit @you" and step in.');
      say('Leave one: npx slashvibe-mcp door https://your-project.dev "what it is"');
      return;
    }
    const told = Object.keys(mine.told).sort();
    say(`\u{1F6AA} Your door${mine.name ? `: "${mine.name}"` : ''}`);
    say(`   ${mine.url}`);
    say(told.length ? `   left with: ${told.map((h) => `@${h}`).join(', ')}` : '   not left with anyone yet');
    say('Leave it with the people you know: npx slashvibe-mcp door share   ·   take it down: npx slashvibe-mcp door close');
    return;
  }

  if (sub === 'share') {
    if (argv.length > 2) throw new Error('One person at a time, or nobody for everyone you know: npx slashvibe-mcp door share @handle');
    const mine = door.mine();
    if (!mine) throw new Error('You have not left a door yet: npx slashvibe-mcp door https://your-project.dev "what it is"');
    const me = signedIn();
    const known = people().filter((h) => h !== me);
    let targets;
    if (argv[1]) {
      const h = line.norm(argv[1]);
      if (!line.validHandle(h)) throw new Error(`"${argv[1]}" is not a handle.`);
      // The rule that keeps a door among people you know lives here, in code.
      if (!known.includes(h)) throw new Error(`You have not written to @${h}, so your door stays closed to them. Write to them first, then share it.`);
      targets = [h];
    } else {
      targets = known;
    }
    if (targets.length === 0) {
      say('There is nobody to leave it with yet. A door goes to people you know: someone you have written to, or opened a line with.');
      return;
    }
    const fresh = targets.filter((h) => !mine.told[h]);
    const now = fresh.slice(0, door.MAX_SHARE);
    const left = []; const failed = [];
    for (const h of now) {
      // eslint-disable-next-line no-await-in-loop
      if (await hush(() => send(h, door.card(me, mine.url, mine.name)))) { door.markTold(h); left.push(h); } else failed.push(h);
    }
    const already = targets.filter((h) => mine.told[h]);
    if (left.length) say(`\u{1F6AA} Door left with ${left.map((h) => `@${h}`).join(', ')}. They can say "visit @${me}".`);
    if (already.length) say(`Already had it: ${already.map((h) => `@${h}`).join(', ')}.`);
    if (failed.length) { say(`Could not reach: ${failed.map((h) => `@${h}`).join(', ')}. Nothing was left with them; run it again.`); process.exitCode = 1; }
    if (fresh.length > now.length) say(`${fresh.length - now.length} more people you know were not told (at most ${door.MAX_SHARE} at a time). Run it again for the rest.`);
    if (left.length) say('You are not told who visits. Take it down: npx slashvibe-mcp door close');
    return;
  }

  if (sub === 'close') {
    const mine = door.mine();
    if (!mine) { say('You have no door open.'); return; }
    const told = Object.keys(mine.told).sort();
    let me = null;
    if (told.length) me = signedIn();
    const reached = []; const failed = [];
    for (const h of told) {
      // eslint-disable-next-line no-await-in-loop
      if (await hush(() => send(h, door.closedCard(me)))) reached.push(h); else failed.push(h);
    }
    door.clear();
    say('Door closed. The link itself is yours; this only stops /vibe leading people to it.');
    if (reached.length) say(`Told: ${reached.map((h) => `@${h}`).join(', ')}.`);
    if (failed.length) { say(`Could not tell: ${failed.map((h) => `@${h}`).join(', ')}. Their /vibe may still show it.`); process.exitCode = 1; }
    return;
  }

  // Anything else is the link, followed by its name in the person's words.
  const next = door.set(sub, argv.slice(1).join(' '));
  const known = people();
  say(`\u{1F6AA} Your door${next.name ? `: "${next.name}"` : ''}`);
  say(`   ${next.url}`);
  const told = Object.keys(next.told);
  if (told.length) say(`   still left with: ${told.sort().map((h) => `@${h}`).join(', ')}`);
  else say('Nobody has been told. A door is not published anywhere; it goes only to people you choose.');
  say(known.length
    ? `Leave it with the people you know (${known.slice(0, 8).map((h) => `@${h}`).join(', ')}${known.length > 8 ? `, +${known.length - 8}` : ''}): npx slashvibe-mcp door share   ·   or one of them: door share @handle`
    : 'When you have written to someone, leave it with them: npx slashvibe-mcp door share');
}

/**
 * `agent`: this process as an agent identity (agent-auth.js).
 *
 *   agent            who this is configured to be, and whether it is signed in
 *   agent signin     sign in now with the agent's credential (no browser)
 *
 * The credential comes from the environment (VIBE_AGENT_MINT_FILE or
 * VIBE_AGENT_MINT) and is never printed.
 */
async function agentCli(argv, say) {
  const agentAuth = require('./agent-auth');
  const me = agentAuth.configured();
  if (!me) {
    say('This is not set up as an agent.');
    say('An agent signs in as itself with its own credential, set in the env of its vibe server:');
    say('  VIBE_AGENT_HANDLE=<handle>  VIBE_AGENT_MINT_FILE=<file holding the credential>  VIBE_HOME=<its own directory>');
    say('The credential is issued per agent by the people who run /vibe. A person signs in with: npx slashvibe-mcp setup');
    return;
  }
  if (me.problem) throw new Error(`@${me.handle} cannot sign in: ${me.problem}.`);
  const hush = console.error; console.error = () => {};
  let state;
  try { state = await agentAuth.ensureSession({ force: argv[0] === 'signin' }); } finally { console.error = hush; }
  if (!state.ok) throw new Error(agentAuth.scrub(state.message));
  const until = state.expiresAt ? new Date(state.expiresAt).toISOString().slice(0, 10) : null;
  say(`\u{1F916} @${me.handle} is signed in to /vibe as an agent${until ? `, until ${until}` : ''}${state.minted ? ' (new session)' : ''}.`);
  if (state.message) say(agentAuth.scrub(state.message));
  const who = await agentAuth.publicIdentity(me.handle);
  if (who && who.operator) say(`Run by @${who.operator}. People see that beside this agent's name.`);
  else if (who) say(`No operator is named. The person who runs this agent names themselves, signed in as themselves: npx slashvibe-mcp operate @${me.handle}`);
  else say('Could not read how /vibe shows this agent right now.');
}

/**
 * `operate`: a PERSON says "I run this agent".
 *
 *   operate                      the agents you operate
 *   operate @agent [--days N]    name yourself its operator (1 to 30 days; default 30)
 *   operate renew @agent         replace your grant with a fresh one
 *   operate revoke @agent        stop being named
 *
 * The service wants proof of both halves in one request: your own sign-in, and
 * the agent's credential (so nobody can put their name on an agent they do not
 * run). The credential is read from VIBE_AGENT_MINT_FILE or VIBE_AGENT_MINT for
 * this one command, never from the command line, and never printed.
 */
async function operateCli(argv, say) {
  const fs = require('fs');
  const path = require('path');
  const agentAuth = require('./agent-auth');
  const config = require('./config');
  const authStore = require('./auth-store');
  const { vibeHome } = require('./vibe-home');
  if (process.env.VIBE_AGENT_HANDLE) throw new Error('An agent cannot name its own operator. Run this as the person, without VIBE_AGENT_HANDLE.');
  const secret = agentAuth.credentialForOperator();
  const flags = argv.filter((a) => a.startsWith('--'));
  const words = argv.filter((a) => !a.startsWith('--'));
  if (flags.some((f) => !/^--days(=\d+)?$/.test(f))) throw new Error('The only option is --days=N. The agent\'s credential is never given on the command line; put it in a file and set VIBE_AGENT_MINT_FILE.');
  const verb = ['renew', 'revoke'].includes(words[0]) ? words.shift() : (words.length ? 'grant' : 'list');
  if (words.length > 1) throw new Error('One agent at a time: npx slashvibe-mcp operate @agent');

  const cred = authStore.inspectToken(config.getAuthToken());
  if (!cred.ok) throw new Error('Sign in as yourself first: npx slashvibe-mcp setup');
  authStore.hydrate();
  const me = String(cred.handle || '').toLowerCase();
  const base = String(config.getApiUrl()).replace(/\/+$/, '');
  const call = async (method, query, body, withAgent) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const r = await fetch(`${base}/api/operator-grants${query || ''}`, {
        method, signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken() || config.getAuthToken()}`, ...(withAgent ? { 'x-agent-mint': secret } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch { throw new Error('Could not reach /vibe. Nothing was changed.'); } finally { clearTimeout(timer); }
  };
  const WHY = {
    principal_credential_required: 'Your sign-in is an older kind that cannot name an operator. Sign in again: npx slashvibe-mcp setup',
    identity_not_attested: 'Your handle has no GitHub-attested identity yet. Sign in again: npx slashvibe-mcp setup',
    credential_superseded: 'Your sign-in no longer matches this handle. Sign in again: npx slashvibe-mcp setup',
    agent_credential_required: 'That is not this agent\'s credential. Only the person who holds an agent\'s credential can name themselves its operator.',
    agent_not_found: 'That handle is not an agent on /vibe yet. The agent has to sign in once as itself first (npx slashvibe-mcp agent signin, in its own env).',
    live_grant_exists: 'This agent already has an operator named. If it is you: npx slashvibe-mcp operate renew @agent. If it is someone else, they must revoke first; an operator is never silently replaced.',
    unauthorized: 'Sign in as yourself first: npx slashvibe-mcp setup',
  };
  const refuse = (r) => { throw new Error(agentAuth.scrub(WHY[r.body && r.body.error] || (r.body && r.body.message) || `The service refused (${r.status}). Nothing was changed.`)); };
  const noteFile = path.join(vibeHome(), 'operating.json');
  const notes = () => { try { const v = JSON.parse(fs.readFileSync(noteFile, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const remember = (agent, value) => {
    const all = notes(); if (value) all[agent] = value; else delete all[agent];
    try { fs.mkdirSync(path.dirname(noteFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(noteFile, JSON.stringify(all, null, 2), { mode: 0o600 }); } catch {}
  };
  const day = (iso) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : 'an unknown date');
  const listLive = async () => {
    const r = await call('GET');
    if (r.status !== 200) refuse(r);
    return (r.body.grants || []).filter((g) => g && !g.revoked_at && Date.parse(g.expires_at) > Date.now());
  };

  if (verb === 'list') {
    const live = await listLive();
    if (!live.length) { say('You are not named as the operator of any agent.'); say('Name yourself: npx slashvibe-mcp operate @agent   (with that agent\'s credential in VIBE_AGENT_MINT_FILE)'); return; }
    say('You are named as the operator of:');
    for (const g of live) say(`  @${agentAuth.norm(g.agent_handle)} until ${day(g.expires_at)}`);
    say('Renew: npx slashvibe-mcp operate renew @agent   ·   stop: npx slashvibe-mcp operate revoke @agent');
    return;
  }

  const agent = agentAuth.norm(words[0]);
  if (!agentAuth.HANDLE.test(agent)) throw new Error(`"${words[0] || ''}" is not a handle. Which agent? npx slashvibe-mcp operate @agent`);
  if (agent === me) throw new Error(`@${agent} is you. An operator is a person who runs an agent.`);

  if (verb === 'revoke' || verb === 'renew') {
    const mine = (await listLive()).find((g) => agentAuth.norm(g.agent_handle) === agent);
    if (!mine && verb === 'revoke') { remember(agent, null); say(`You are not named as @${agent}'s operator.`); return; }
    if (mine) {
      if (verb === 'renew' && !secret) throw new Error(`Renewing needs @${agent}'s credential: set VIBE_AGENT_MINT_FILE for this command. Nothing was changed.`);
      const r = await call('DELETE', `?grant_id=${encodeURIComponent(mine.grant_id)}`);
      if (r.status !== 200) refuse(r);
      remember(agent, null);
      if (verb === 'revoke') { say(`You are no longer named as @${agent}'s operator. Messages it already sent keep saying who ran it then.`); return; }
    }
  }

  if (!secret) throw new Error(`Naming yourself @${agent}'s operator needs that agent's own credential, as proof you run it. Put it in a file and run:\n  VIBE_AGENT_MINT_FILE=<that file> npx slashvibe-mcp operate @${agent}`);
  const daysFlag = flags.find((f) => f.startsWith('--days='));
  const days = daysFlag ? Number(daysFlag.split('=')[1]) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be between 1 and 30. The service does not name an operator for longer than 30 days at a time.');
  const r = await call('POST', '', { agent_handle: agent, expires_in_hours: days * 24, scope: ['messages:send'] }, true);
  if (r.status !== 200 || !r.body.success) refuse(r);
  remember(agent, { expires_at: r.body.expires_at, grant_id: r.body.grant_id });
  say(`\u{1F916} @${agent} is now shown as an agent run by @${me}, until ${day(r.body.expires_at)}.`);
  say('That covers what it sends from now on. It ends on that date unless you renew it:');
  say(`  npx slashvibe-mcp operate renew @${agent}   ·   stop being named: npx slashvibe-mcp operate revoke @${agent}`);
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
} else if (args[0] === 'agent' || args[0] === 'operate') {
  // An agent as itself, and the person who runs it (agent-auth.js).
  (args[0] === 'agent' ? agentCli : operateCli)(args.slice(1), (t) => process.stdout.write(`${t}\n`)).catch((error) => {
    process.stderr.write(`${require('./agent-auth').scrub(error?.message || error)}\n`);
    process.exitCode = 1;
  });
} else if ((args.includes('setup') || (args.length === 0 && process.stdin.isTTY)) && require('./agent-auth').isAgent()) {
  // Setup is a person signing in through GitHub. An agent that did that would
  // become a person as far as /vibe knows.
  process.stderr.write(`This is set up as the agent @${require('./agent-auth').configured().handle}. Setup is for people. An agent signs in with: npx slashvibe-mcp agent signin\n`);
  process.exitCode = 1;
} else if (args[0] === 'door') {
  // A door (door.js). Typed by the person; nothing a session's agent can call sets or shares one.
  doorCli(args.slice(1), (t) => process.stdout.write(`${t}\n`)).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
} else if (['quiet', 'unquiet', 'mute', 'unmute', 'invisible', 'visible'].includes(args[0])) {
  // Who may reach you while you work (reach.js). Local, and yours to type.
  const reach = require('./reach');
  const say = (t) => process.stdout.write(`${t}\n`);
  try {
    if (args[0] === 'invisible') { reach.setInvisible(true); say('Invisible. Your sessions stop saying you are here, so you drop off other people\'s lists within about ten minutes. You still see who is here, and messages still reach you. Turn it off: npx slashvibe-mcp visible'); }
    else if (args[0] === 'visible') { reach.setInvisible(false); say('Visible. You show as here while you are in a session.'); }
    else if (args[0] === 'quiet') { reach.setQuiet(true); say('Quiet. Nothing will reach you while you work; messages wait until you ask what is waiting. Turn it off: npx slashvibe-mcp unquiet'); }
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
    console.log('Restart your Claude Code session to connect.');
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
