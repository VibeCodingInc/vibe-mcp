/**
 * "/vibe does not collect usage analytics" is a SECURITY.md promise — this
 * test makes it enforceable (#9.3).
 *
 * setup.js emitted a setup_complete event to /api/analytics/track while the
 * security policy said no telemetry existed. The event is gone; this guard
 * sweeps every shipped source file so an analytics call cannot return
 * quietly, and pins the SECURITY.md language that replaced the vague claim.
 *
 * Run: node --test tools/_no-telemetry.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

// Every tracked .js/.cjs source file — git is the manifest, so nothing shipped
// can hide from the sweep (node_modules is not tracked).
function shippedSources() {
  return execFileSync('git', ['ls-files', '*.js', '*.cjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.endsWith('.test.js'));
}

// Endpoint shapes that would constitute telemetry. Word-boundaried so the
// discovery topic keyword 'analytics' in _discovery.js does not false-positive.
const TELEMETRY_CALLS = /\/api\/analytics|\/api\/track\b|analytics\/track|\btelemetry\b\s*[:(]/i;

test('no shipped source file calls an analytics endpoint', () => {
  const offenders = [];
  for (const rel of shippedSources()) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    if (TELEMETRY_CALLS.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `analytics call found in: ${offenders.join(', ')}`);
});

test('setup.js no longer emits setup_complete', () => {
  const src = readFileSync(join(ROOT, 'setup.js'), 'utf8');
  assert.ok(!src.includes("event: 'setup_complete'"), 'setup_complete event returned');
});

test('SECURITY.md states the exact enforced claim, not a vague one', () => {
  const doc = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(doc, /does not collect usage analytics/);
  assert.match(doc, /_no-telemetry\.test\.js/, 'the claim names its enforcement');
  assert.match(doc, /API traffic itself/, 'the claim is honest about what the server necessarily sees');
});
