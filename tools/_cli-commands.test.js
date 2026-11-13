/**
 * The terminal commands a newcomer types (found by the 0.9.1 cold walk):
 * help must be help, the install line must not do nothing silently when there
 * is no terminal, and a line opens with exactly the one handle named.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
function run(args, home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-'))) {
  // stdin is not a terminal here, exactly like an agent's shell tool.
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'), CI: '1', VIBE_SETUP_NO_AUTORUN: '1', VIBE_SETUP_STUB_BROWSER: '1' },
  });
  return { ...r, home };
}

test('help prints the commands and starts nothing', () => {
  for (const flag of ['help', '--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /npx slashvibe-mcp setup/);
    assert.match(r.stdout, /trust @handle/);
    assert.ok(!fs.existsSync(path.join(r.home, '.claude.json')), `${flag} wrote an agent config`);
  }
});

test('--version prints the package version', () => {
  const r = run(['--version']);
  assert.equal(r.stdout.trim(), require('../package.json').version);
});

test('no terminal and never signed in: says how to install, on stderr only', () => {
  const r = run([]);
  assert.match(r.stderr, /npx slashvibe-mcp setup/);
  assert.equal(r.stdout, '', 'stdout belongs to the MCP protocol');
  assert.ok(!/Hydrated/.test(r.stderr), 'start-up diagnostics are VIBE_DEBUG only');
});

test('trust and untrust take exactly one handle', () => {
  const r = run(['trust', '@sam', 'and', '@ada']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /One handle at a time/);
  assert.ok(!fs.existsSync(path.join(r.home, '.vibe', 'lines.json')), 'a line was opened anyway');
  const ok = run(['trust', '@sam'], r.home);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Open line with @sam/);
});
