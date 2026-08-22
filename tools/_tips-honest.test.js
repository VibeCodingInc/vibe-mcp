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

const PHANTOMS = ['vibe stuck', "vibe available '", 'vibe context --file', 'start presence monitor'];

// Kernel tool names = registrations OUTSIDE the extraTools block in index.js.
function kernelToolNames() {
  const src = read('index.js');
  const extrasStart = src.indexOf('const extraTools');
  assert.ok(extrasStart > 0, 'extras block found');
  const kernelSrc = src.slice(0, extrasStart);
  return new Set([...kernelSrc.matchAll(/'(vibe_[a-z_]+)'/g)].map((m) => m[1]));
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
