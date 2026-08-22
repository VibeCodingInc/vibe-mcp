/**
 * Tips and guided actions may only advertise commands that exist (#9.2).
 *
 * The rotating vibe_start tips named "vibe stuck", "vibe available",
 * "vibe context --file" and "start presence monitor"; the guided-action
 * fallback promoted "start presence monitor"; who.js suggested `vibe stuck`.
 * None of these is a registered tool in any session — every one told the
 * user to run a command that fails.
 *
 * Two guards: the known phantoms are pinned out by name, and any vibe_<x>
 * token a tip mentions must be registered in a DEFAULT session (kernel, not
 * extras — a default install doesn't have extras).
 *
 * Run: node --test tools/_tips-honest.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Command STEMS, not exact examples — 'vibe available "React"' and
// 'vibe available anything-else' are the same phantom (review delta).
const PHANTOMS = ['vibe stuck', 'vibe available', 'vibe context', 'start presence monitor'];

// Kernel tool names = the actual KEYS of the kernelTools object literal in
// index.js — not any quoted vibe_* string, which a comment or unrelated
// string could masquerade as (review delta).
function kernelToolNames() {
  const src = read('index.js');
  const start = src.indexOf('const kernelTools = {');
  assert.ok(start > 0, 'kernelTools object found');
  const end = src.indexOf('};', start);
  assert.ok(end > start, 'kernelTools object closes');
  const body = src.slice(start, end);
  // keys look like `  vibe_name: require(...)` — anchor on key position.
  const names = new Set(
    [...body.matchAll(/^\s*(vibe_[a-z_]+)\s*:/gm)].map((m) => m[1])
  );
  assert.ok(names.has('vibe_who') && names.has('vibe_dm'), 'sanity: known kernel keys parsed');
  return names;
}

function tipLines(src) {
  const start = src.indexOf('const tips = [');
  assert.ok(start > 0, 'tips array found');
  return src.slice(start, src.indexOf('];', start));
}

test('the rotating tips never name the known phantom commands', () => {
  const tips = tipLines(read('tools/start.js'));
  for (const phantom of PHANTOMS) {
    assert.ok(!tips.includes(phantom), `tip advertises unregistered "${phantom}"`);
  }
});

test('every vibe_<tool> a tip names is registered in a DEFAULT session', () => {
  const kernel = kernelToolNames();
  const tips = tipLines(read('tools/start.js'));
  for (const [, tool] of tips.matchAll(/\b(vibe_[a-z_]+)\b/g)) {
    assert.ok(kernel.has(tool), `tip names ${tool}, which a default session does not register`);
  }
});

test('guided actions and who.js do not promote phantom commands either', () => {
  const actions = read('tools/_actions.js');
  assert.ok(
    !actions.includes("command: 'start presence monitor'"),
    'guided action promotes an unregistered command'
  );
  const who = read('tools/who.js');
  assert.ok(
    !who.includes('`vibe stuck`'),
    'who.js suggests running unregistered `vibe stuck`'
  );
});

test('the literal `npx slashvibe-mcp hook install` route the tips name exists', () => {
  const pkg = JSON.parse(read('package.json'));
  const binEntries = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  assert.ok(binEntries['slashvibe-mcp'], 'package exposes the slashvibe-mcp bin');
  // The route is two hops: cli.js dispatches 'hook' to hook-cli.js, which
  // handles 'install'. Pin both hops, not just the first.
  const cliSrc = read(binEntries['slashvibe-mcp'].replace(/^\.\//, ''));
  assert.match(cliSrc, /args\[0\] === 'hook'/, 'cli.js dispatches the hook subcommand');
  const hookSrc = read('hook-cli.js');
  assert.match(hookSrc, /install/, 'hook-cli.js handles install');
});
