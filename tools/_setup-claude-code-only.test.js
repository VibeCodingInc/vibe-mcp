/**
 * What setup does to a machine, and what it shows a newcomer (found on the founder's
 * own terminal, 2026-11-14):
 *   - it configures Claude Code and nothing else. It used to write Codex and Cursor
 *     configs and a Codex prompt, for a product that names Claude Code only;
 *   - it shows no roster. It used to list strangers by handle with what they were
 *     working on;
 *   - signing in again keeps the rest of the person's config;
 *   - an EXPIRED second credential for the same handle is retired, and only that.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const jwt = (h, exp) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp })).toString('base64url')}.sig`;
const NOW = Math.floor(Date.now() / 1000);

/** Run a snippet with HOME (and optionally VIBE_HOME) pointed at a scratch machine. */
function onMachine(home, code, env = {}) {
  const r = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8', cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, VIBE_SETUP_NO_AUTORUN: '1', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('setup configures Claude Code, and leaves Codex and Cursor exactly as it found them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-setup-'));
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# mine\n');
  fs.mkdirSync(path.join(home, '.cursor'));
  const out = JSON.parse(onMachine(home, `
    const s = require('./setup.js');
    console.log(JSON.stringify({ hosts: s.configureAllHosts(), commands: s.installHostCommands() }));`));
  assert.deepEqual(out.hosts.map((h) => h.host), ['Claude Code']);
  assert.deepEqual(out.commands.map((c) => c.host), ['Claude Code']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers.vibe);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), '# mine\n', 'setup wrote to Codex');
  assert.deepEqual(fs.readdirSync(path.join(home, '.codex')), ['config.toml'], 'setup added a Codex prompt');
  assert.deepEqual(fs.readdirSync(path.join(home, '.cursor')), [], 'setup wrote to Cursor');
});

test('setup names one host and shows no roster of people', () => {
  const src = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/Codex|Cursor/.test(code), 'setup still names or touches another host');
  assert.ok(!/people here now|here now:|api\/presence/.test(code), 'setup still reads or prints who is here');
  const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
  assert.ok(!/Codex|Cursor/.test(cli));
  assert.ok(!/Codex|Cursor/.test(require('../package.json').description));
});

test('signing in again keeps the rest of the config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-setup-'));
  const vh = path.join(home, '.vibe');
  fs.mkdirSync(vh);
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle: 'nell', authToken: 'old', one_liner: 'the scheduler lease', github_activity_privacy: 'off', pendingAuth: true }));
  onMachine(home, `require('./setup.js').saveAuthConfig('nell', ${JSON.stringify(jwt('nell', NOW + 3600))});`);
  const cfg = JSON.parse(fs.readFileSync(path.join(vh, 'config.json'), 'utf8'));
  assert.equal(cfg.one_liner, 'the scheduler lease', 'signing in erased the line the person had set');
  assert.equal(cfg.github_activity_privacy, 'off');
  assert.equal(cfg.handle, 'nell');
  assert.notEqual(cfg.authToken, 'old');
  assert.equal(cfg.pendingAuth, undefined);
  assert.equal(fs.statSync(path.join(vh, 'config.json')).mode & 0o777, 0o600);
});

test('an expired second credential for the same handle is retired; anything else is left alone', () => {
  const cases = [
    ['expired, same person', { handle: 'nell', token: jwt('nell', NOW - 60) }, false],
    ['still valid, same person', { handle: 'nell', token: jwt('nell', NOW + 3600) }, true],
    ['expired, someone else', { handle: 'sam', token: jwt('sam', NOW - 60) }, true],
    ['no expiry claim', { handle: 'nell', token: `h.${Buffer.from(JSON.stringify({ handle: 'nell' })).toString('base64url')}.sig` }, true],
    ['not a token at all', { handle: 'nell', token: 'garbage' }, true],
  ];
  for (const [name, stored, kept] of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-setup-'));
    const vh = path.join(home, '.vibe');
    fs.mkdirSync(vh);
    fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify(stored));
    onMachine(home, `require('./setup.js').saveAuthConfig('nell', ${JSON.stringify(jwt('nell', NOW + 3600))});`);
    assert.equal(fs.existsSync(path.join(vh, 'auth.json')), kept, name);
  }
});
