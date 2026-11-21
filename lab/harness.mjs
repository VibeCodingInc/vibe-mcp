// The pieces every lab runner shares: a fictional identity on disk, a person
// typing a /vibe command in their terminal, and a REAL Claude Code session
// (`claude -p`) as that identity. Nothing here touches production, a real
// account, or a real person:
//   - every session's /vibe server gets VIBE_API_URL = the stub on 127.0.0.1,
//     its own VIBE_HOME under a temp dir, and CI=1 so sign-in can never open a
//     browser;
//   - the arrival hook is installed into a scratch settings file passed with
//     --settings, never into ~/.claude/settings.json.
// Used by rehearse.mjs (scripted scenarios) and population.mjs (pairs of
// fictional people over two days).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const jwt = (h, days = 1) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + days * 86400 })).toString('base64url')}.sig`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function identity(root, handle, says, stubUrl, trusts = [], knows = [], { muted = [], invisible = false, startHook = false, agentMint = null, serverEnv = {}, tokenDays = 1 } = {}) {
  const home = path.join(root, handle, '.vibe');
  const work = path.join(root, handle, 'work');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  // A person arrives signed in. An agent identity arrives with nothing but its
  // credential in a file, and signs itself in (agent-auth.js).
  const mintFile = path.join(root, handle, 'agent.mint');
  if (agentMint) {
    fs.writeFileSync(mintFile, agentMint, { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ one_liner: says }));
  } else {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ handle, token: jwt(handle, tokenDays), provider: 'github', authenticated_at: new Date().toISOString() }));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ handle, one_liner: says }));
  }
  if (knows.length || muted.length || invisible) fs.writeFileSync(path.join(home, 'reach.json'), JSON.stringify({ quiet: false, invisible, muted: Object.fromEntries(muted.map((h) => [h, Date.now()])), known: Object.fromEntries(knows.map((h) => [h, Date.now()])) }));
  if (trusts.length) fs.writeFileSync(path.join(home, 'lines.json'), JSON.stringify(Object.fromEntries(trusts.map((h) => [h, { since: Date.now() }]))));
  const env = { VIBE_HOME: home, VIBE_API_URL: stubUrl, VIBE_SETUP_NO_AUTORUN: '1', CI: '1', ...serverEnv, ...(agentMint ? { VIBE_AGENT_HANDLE: handle, VIBE_AGENT_MINT_FILE: mintFile } : {}) };
  const mcp = path.join(root, handle, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { vibe: { command: process.execPath, args: [path.join(REPO, 'index.js')], env } } }));
  const settings = path.join(root, handle, 'settings.json');
  const { createArrivalHookManager } = require(path.join(REPO, 'arrival-hook-settings.js'));
  createArrivalHookManager({ env: { ...process.env, VIBE_HOME: home }, settingsPath: settings }).install();
  if (startHook) {
    // The SessionStart hook from THIS checkout, as this identity, against the
    // stub. (The installer writes an npx launch of the published package.)
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    s.hooks.SessionStart = [{ matcher: 'startup|resume', hooks: [{ type: 'command', timeout: 8, command: `VIBE_HOME=${q(home)} VIBE_API_URL=${q(stubUrl)} CI=1 ${q(process.execPath)} ${q(path.join(REPO, 'cli.js'))} hook run` }] }];
    fs.writeFileSync(settings, JSON.stringify(s, null, 2));
  }
  return { handle, home, work, mcp, settings, token: jwt(handle, tokenDays), api: stubUrl, mintFile: agentMint ? mintFile : null };
}

// A person typing a /vibe command in their terminal, as this identity. Async:
// the stub lives in this process and a synchronous child would starve it.
export function cli(id, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'cli.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(id.home), VIBE_HOME: id.home, VIBE_API_URL: id.api, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', ...extraEnv },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err, typed: `${Object.keys(extraEnv).map((k) => `${k}=… `).join('')}npx slashvibe-mcp ${args.join(' ')}` }));
  });
}

// The tools a rehearsal session is allowed by default (vibe_send only with allowSend).
export const DEFAULT_TOOLS = ['Read', 'Edit', 'Write', 'Bash(sleep:*)', 'mcp__vibe__vibe_people', 'mcp__vibe__vibe_thread', 'mcp__vibe__vibe_prepare', 'mcp__vibe__vibe_discard', 'mcp__vibe__vibe_start',
  // The open-line tools are always offered: the code decides whether they may send.
  'mcp__vibe__vibe_ask', 'mcp__vibe__vibe_answer',
  // Visiting a door opens nothing here (CI=1) and sends nothing.
  'mcp__vibe__vibe_visit',
  // The bump names only people the person knows; it sends nothing.
  'mcp__vibe__vibe_bump'];

const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };
const resultText = (c) => (Array.isArray(c.content) ? c.content.map((y) => y.text || '').join('\n') : String(c.content || ''));

/**
 * One `claude -p` turn as this identity. Options (all default to the
 * rehearsal behaviour): allowSend, resume (a session id), model, tools
 * (replaces the allowed list), builtins (→ --tools, the built-in tools that
 * exist at all), settings (a settings file in place of id.settings), timeoutMs (the child is killed by pid; resolves with what was
 * captured and timedOut: true).
 *
 * Resolves with { shown, tools, texts, returned, final } as before, plus
 * sessionId, allTools (every tool_use), events (the turn in order: shown,
 * text, tool, returned), timedOut, isError, stderr.
 */
export function session(id, prompt, { allowSend = false, resume = null, model = null, tools = null, builtins = null, settings = null, timeoutMs = 0 } = {}) {
  const allowed = tools ? [...tools] : [...DEFAULT_TOOLS];
  if (!tools && allowSend) allowed.push('mcp__vibe__vibe_send');
  const args = ['-p', prompt, '--mcp-config', id.mcp, '--strict-mcp-config',
    // Never load the operator's own user settings: their real /vibe arrival hook
    // would run inside a lab session and claim a real message's one announcement.
    '--setting-sources', 'project,local', '--settings', settings || id.settings,
    '--allowedTools', ...allowed, '--disallowedTools', 'Agent', 'WebSearch', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (builtins) args.push('--tools', builtins.join(','));
  const child = spawn('claude', args, { cwd: id.work, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; let timedOut = false; let timer = null;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
  const killByPid = (sig) => { try { process.kill(child.pid, sig); } catch {} };
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true; killByPid('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killByPid('SIGKILL'); }, 5000).unref();
    }, timeoutMs);
  }
  const done = new Promise((resolve) => child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    const t = { shown: [], tools: [], final: '', texts: [], returned: [], sessionId: null, allTools: [], events: [], timedOut, isError: false, exitCode: code, stderr: err };
    const toolNames = new Map();   // tool_use_id -> tool name
    for (const line of out.split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.session_id && !t.sessionId) t.sessionId = e.session_id;
      if (e.type === 'system' && e.subtype === 'informational' && String(e.content).includes('/vibe')) {
        t.shown.push(String(e.content)); t.events.push({ kind: 'shown', text: String(e.content) });
      }
      // A SessionStart hook's line for the person arrives as the hook's own output.
      if (e.type === 'system' && e.subtype === 'hook_response') {
        try {
          const o = JSON.parse(e.output ?? e.stdout ?? '');
          if (o && typeof o.systemMessage === 'string' && o.systemMessage.includes('/vibe')) {
            t.shown.push(o.systemMessage); t.events.push({ kind: 'shown', text: o.systemMessage, hook: e.hook_event || e.hook_name || null });
          }
        } catch {}
      }
      if (e.type === 'assistant') for (const c of e.message.content || []) {
        if (c.type === 'tool_use') {
          toolNames.set(c.id, c.name);
          t.allTools.push({ name: c.name, input: clip(c.input, 600) });
          t.events.push({ kind: 'tool', id: c.id, name: c.name, input: c.input });
          if (c.name.includes('vibe')) t.tools.push({ name: c.name.replace('mcp__vibe__', ''), input: c.input });
        }
        if (c.type === 'text') { t.texts.push(c.text); t.events.push({ kind: 'text', text: c.text }); }
      }
      // What the /vibe tools printed back: the terminal a person would see.
      if (e.type === 'user') for (const c of e.message?.content || []) {
        if (c.type !== 'tool_result') continue;
        const x = resultText(c);
        if (/\/vibe|@[a-z]|door/i.test(x) && !/^total \d/.test(x)) t.returned.push(x);
        const name = toolNames.get(c.tool_use_id) || '';
        if (name.startsWith('mcp__vibe__')) t.events.push({ kind: 'returned', tool_use_id: c.tool_use_id, name, text: x, isError: Boolean(c.is_error) });
        else if (c.is_error) t.events.push({ kind: 'tool_error', tool_use_id: c.tool_use_id, name, text: clip(x, 400) });
      }
      if (e.type === 'result') { t.final = e.result || ''; t.isError = Boolean(e.is_error); if (e.session_id) t.sessionId = e.session_id; }
    }
    resolve(t);
  }));
  return { done, kill: () => killByPid('SIGKILL'), pid: child.pid };
}
