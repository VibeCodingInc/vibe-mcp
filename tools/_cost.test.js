'use strict';
// What /vibe costs a session is stated in the README as measured numbers. These
// ceilings keep the statement true: a change that makes the hook slow or the
// standing text heavy fails here, with the number, before anyone feels it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (args, input) => { const a = process.hrtime.bigint(); spawnSync(process.execPath, args, { input, env: { ...process.env, VIBE_ARRIVALS_DIR: DIR } }); return Number(process.hrtime.bigint() - a) / 1e6; };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cost-'));

test('the arrival hook costs about what starting node costs, and nothing that grows with the folder', () => {
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash' });
  const hook = [path.join(ROOT, 'hooks', 'arrival-hook.cjs')];
  for (let i = 0; i < 5; i++) time(hook, input);   // warm the file cache
  const bare = median(Array.from({ length: 25 }, () => time(['-e', '0'], '')));
  const empty = median(Array.from({ length: 25 }, () => time(hook, input)));
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(DIR, `msg_old${i}.json`), JSON.stringify({ id: `msg_old${i}`, at: Date.now(), context: 'x', line: 'y' }));
    fs.writeFileSync(path.join(DIR, `msg_old${i}.shown`), '');
  }
  const full = median(Array.from({ length: 25 }, () => time(hook, input)));
  // Relative to this machine's own node start, so a slow CI box does not fail it.
  assert.ok(empty <= bare + 25, `hook ${empty.toFixed(1)} ms vs bare node ${bare.toFixed(1)} ms: the hook itself must stay within 25 ms`);
  assert.ok(full <= empty + 25, `with 200 old rows ${full.toFixed(1)} ms vs ${empty.toFixed(1)} ms: the cost must not grow with the folder`);
});

test('the hook has no dependencies and makes no network call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'arrival-hook.cjs'), 'utf8');
  const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(required.filter((r) => !['fs', 'path', 'node:fs', 'node:path'].includes(r)), []);
  assert.doesNotMatch(src, /\bfetch\(|https?\.request|net\.connect/);
});

test('standing text stays small: instructions under 2,400 characters, tool definitions under 10,000', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const from = index.indexOf('const SERVER_INSTRUCTIONS = [');
  const lines = [...index.slice(from, index.indexOf('].filter(Boolean).join', from)).matchAll(/^\s*(?:CHANNEL_ENABLED \? )?'((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1]);
  assert.ok(lines.length >= 5, 'could not read the standing instructions from index.js');
  const instructions = lines.join(' ').length;
  assert.ok(instructions <= 2400 + 400, `standing instructions are ${instructions} characters (the optional channel line included)`);
  let definitions = 0; let count = 0;
  for (const t of ['start', 'init', 'token', 'people', 'thread', 'drafts', 'line', 'visit', 'bump']) {
    const mod = require(`./${t}`);
    for (const x of (mod.definition ? [mod] : Object.values(mod))) if (x && x.definition) { definitions += JSON.stringify(x.definition).length; count += 1; }
  }
  assert.equal(count, 12);
  assert.ok(definitions <= 10000, `tool definitions are ${definitions} characters`);
});

test('the README states the numbers these ceilings protect', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /## What it costs your session/);
  assert.match(readme, /about 22 ms/);
  assert.match(readme, /about 530 tokens/);
  assert.ok(readme.split('\n').length <= 90, 'the README is the short version; detail goes in docs/DETAILS.md');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'DETAILS.md')));
});
