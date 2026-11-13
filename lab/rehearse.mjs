#!/usr/bin/env node
// Rehearse /vibe with REAL Claude Code sessions as lab identities, against the
// in-process stub (lab/stub.mjs). Nothing here touches production, a real
// account, or a real person:
//   - every session's /vibe server gets VIBE_API_URL = the stub on 127.0.0.1,
//     its own VIBE_HOME under a temp dir, and CI=1 so sign-in can never open a
//     browser;
//   - the arrival hook is installed into a scratch settings file passed with
//     --settings, never into ~/.claude/settings.json.
//
//   node lab/rehearse.mjs            list scenarios
//   node lab/rehearse.mjs <name>     run one, print a report (exit 1 if a check fails)
//   node lab/rehearse.mjs all
//
// It costs real model tokens and takes a minute or two per scenario.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub.mjs';
import { scenarios } from './scenarios.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function identity(root, handle, says, stubUrl, trusts = [], knows = [], { muted = [], invisible = false, startHook = false } = {}) {
  const home = path.join(root, handle, '.vibe');
  const work = path.join(root, handle, 'work');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ handle, one_liner: says }));
  if (knows.length || muted.length || invisible) fs.writeFileSync(path.join(home, 'reach.json'), JSON.stringify({ quiet: false, invisible, muted: Object.fromEntries(muted.map((h) => [h, Date.now()])), known: Object.fromEntries(knows.map((h) => [h, Date.now()])) }));
  if (trusts.length) fs.writeFileSync(path.join(home, 'lines.json'), JSON.stringify(Object.fromEntries(trusts.map((h) => [h, { since: Date.now() }]))));
  const env = { VIBE_HOME: home, VIBE_API_URL: stubUrl, VIBE_SETUP_NO_AUTORUN: '1', CI: '1' };
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
  return { handle, home, work, mcp, settings, token: jwt(handle), api: stubUrl };
}

// A person typing a /vibe command in their terminal, as this identity. Async:
// the stub lives in this process and a synchronous child would starve it.
function cli(id, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'cli.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(id.home), VIBE_HOME: id.home, VIBE_API_URL: id.api, CI: '1', VIBE_SETUP_NO_AUTORUN: '1' },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err, typed: `npx slashvibe-mcp ${args.join(' ')}` }));
  });
}

function session(id, prompt, { allowSend = false } = {}) {
  const tools = ['Read', 'Edit', 'Write', 'Bash(sleep:*)', 'mcp__vibe__vibe_people', 'mcp__vibe__vibe_thread', 'mcp__vibe__vibe_prepare', 'mcp__vibe__vibe_discard', 'mcp__vibe__vibe_start',
    // The open-line tools are always offered: the code decides whether they may send.
    'mcp__vibe__vibe_ask', 'mcp__vibe__vibe_answer',
    // Visiting a door opens nothing here (CI=1) and sends nothing.
    'mcp__vibe__vibe_visit',
    // The bump names only people the person knows; it sends nothing.
    'mcp__vibe__vibe_bump'];
  if (allowSend) tools.push('mcp__vibe__vibe_send');
  const child = spawn('claude', ['-p', prompt, '--mcp-config', id.mcp, '--strict-mcp-config',
    // Never load the operator's own user settings: their real /vibe arrival hook
    // would run inside a lab session and claim a real message's one announcement.
    '--setting-sources', 'project,local', '--settings', id.settings,
    '--allowedTools', ...tools, '--disallowedTools', 'Agent', 'WebSearch', '--output-format', 'stream-json', '--verbose'],
  { cwd: id.work, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', () => {
    const t = { shown: [], tools: [], final: '', texts: [], returned: [] };
    for (const line of out.split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'system' && e.subtype === 'informational' && String(e.content).includes('/vibe')) t.shown.push(String(e.content));
      // A SessionStart hook's line for the person arrives as the hook's own output.
      if (e.type === 'system' && e.subtype === 'hook_response') {
        try { const o = JSON.parse(e.output ?? e.stdout ?? ''); if (o && typeof o.systemMessage === 'string' && o.systemMessage.includes('/vibe')) t.shown.push(o.systemMessage); } catch {}
      }
      if (e.type === 'assistant') for (const c of e.message.content || []) {
        if (c.type === 'tool_use' && c.name.includes('vibe')) t.tools.push({ name: c.name.replace('mcp__vibe__', ''), input: c.input });
        if (c.type === 'text') t.texts.push(c.text);
      }
      // What the /vibe tools printed back: the terminal a person would see.
      if (e.type === 'user') for (const c of e.message?.content || []) {
        if (c.type !== 'tool_result') continue;
        const x = Array.isArray(c.content) ? c.content.map((y) => y.text || '').join('\n') : String(c.content || '');
        if (/\/vibe|@[a-z]|door/i.test(x) && !/^total \d/.test(x)) t.returned.push(x);
      }
      if (e.type === 'result') t.final = e.result || '';
    }
    resolve(t);
  }));
  return { done, kill: () => child.kill('SIGKILL') };
}

async function run(name) {
  const sc = scenarios[name];
  if (!sc) throw new Error(`no scenario "${name}"`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-lab-${name}-`));
  const stub = await startStub({ people: sc.people });
  const ids = {};
  for (const [h, p] of Object.entries(sc.people)) {
    ids[h] = identity(root, h, p.says, stub.url, p.trusts || [], p.knows || [], { muted: p.muted || [], invisible: Boolean(p.invisible), startHook: Boolean(sc.startHook) });
    for (const [file, text] of Object.entries(p.files || {})) fs.writeFileSync(path.join(ids[h].work, file), text);
  }
  const lab = { stub, ids, sleep, cli: (h, args) => cli(ids[h], args), session: (h, prompt, o) => session(ids[h], prompt, o), read: (h, f) => fs.readFileSync(path.join(ids[h].work, f), 'utf8') };
  const started = Date.now();
  let result; let failed = [];
  try {
    result = await sc.run(lab);
    failed = (sc.checks(result, lab) || []).filter((c) => !c.ok);
    const sends = stub.effects.filter((e) => e.effect === 'SEND');
    console.log(`\n# ${name}: ${sc.title}\n`);
    for (const c of result.terminal || []) console.log(`$ ${c.typed}\n${(c.out + c.err).trimEnd()}\n[exit ${c.code}]\n`);
    for (const [who, t] of Object.entries(result.sessions || {})) {
      console.log(`## @${who}'s session`);
      for (const s of t.shown) console.log(`shown to the person: ${s}`);
      for (const c of t.tools) console.log(`tool: ${c.name} ${JSON.stringify(c.input).slice(0, 700)}`);
      for (const r of t.returned) console.log(`\n/vibe printed:\n${r}`);
      console.log(`\nfinal message:\n${t.final}\n`);
    }
    console.log('## the wire');
    for (const s of sends) console.log(`SEND @${s.me} → @${s.to}${s.reply_to ? ` (answers ${s.reply_to}${s.linked ? '' : ', NOT LINKED'})` : ''} [${s.origin || 'composed'}${s.approved ? ', approved digest' : ''}]: ${s.body}`);
    console.log(`read-cursor writes: ${stub.effects.filter((e) => e.effect === 'READ_CURSOR').length}`);
    console.log(`\n## checks (${Math.round((Date.now() - started) / 1000)}s)`);
    for (const c of sc.checks(result, lab)) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.what}`);
  } finally {
    await stub.close();
    if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`kept: ${root}`);
  }
  return failed.length === 0;
}

const which = process.argv[2];
if (!which) {
  for (const [k, v] of Object.entries(scenarios)) console.log(`${k.padEnd(12)} ${v.title}`);
} else {
  const names = which === 'all' ? Object.keys(scenarios) : [which];
  let ok = true;
  for (const n of names) ok = (await run(n)) && ok;
  process.exit(ok ? 0 : 1);
}
