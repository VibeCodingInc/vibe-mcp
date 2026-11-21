'use strict';
// The arrival hook's installed copy only moves forward (arrival-hook-settings
// syncScript): an older server starting must not put back the hook a newer
// release installed. The version that wrote the copy sits beside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { syncScript, scriptPath, versionPath, compareVersions } = require('../arrival-hook-settings');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs'));
const OURS = require('../package.json').version;

const home = () => ({ VIBE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hookcopy-')) });
const installed = (env) => fs.readFileSync(scriptPath(env));
const recorded = (env) => JSON.parse(fs.readFileSync(versionPath(env), 'utf8')).version;

test('compareVersions', () => {
  assert.equal(compareVersions('0.9.22', '0.9.21'), 1);
  assert.equal(compareVersions('0.9.9', '0.9.10'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('garbage', '0.0.1'), -1);
});

test('a fresh install writes the copy and the version beside it', () => {
  const env = home();
  assert.equal(syncScript(env), true);
  assert.ok(installed(env).equals(SOURCE));
  assert.equal(recorded(env), OURS);
  assert.equal(syncScript(env), false, 'already current');
});

test('a newer server replaces an older copy (and one with no recorded version)', () => {
  const env = home();
  fs.mkdirSync(path.dirname(scriptPath(env)), { recursive: true });
  fs.writeFileSync(scriptPath(env), '// an older hook\n');
  assert.equal(syncScript(env), true, 'no version recorded: older');
  assert.ok(installed(env).equals(SOURCE));
  fs.writeFileSync(scriptPath(env), '// an older hook\n');
  fs.writeFileSync(versionPath(env), JSON.stringify({ version: '0.9.1' }));
  assert.equal(syncScript(env), true);
  assert.ok(installed(env).equals(SOURCE));
  assert.equal(recorded(env), OURS);
});

test('an older server leaves a newer copy alone', () => {
  const env = home();
  fs.mkdirSync(path.dirname(scriptPath(env)), { recursive: true });
  const newer = '// the hook a newer release installed\n';
  fs.writeFileSync(scriptPath(env), newer);
  fs.writeFileSync(versionPath(env), JSON.stringify({ version: '99.0.0' }));
  assert.equal(syncScript(env), false);
  assert.equal(installed(env).toString(), newer);
  assert.equal(recorded(env), '99.0.0');
  // The same from this server acting as an older version against a copy it wrote.
  const env2 = home();
  syncScript(env2, fs, '0.9.30');
  fs.writeFileSync(scriptPath(env2), '// 0.9.30 hook\n');
  assert.equal(syncScript(env2, fs, '0.9.22'), false);
  assert.equal(installed(env2).toString(), '// 0.9.30 hook\n');
});
