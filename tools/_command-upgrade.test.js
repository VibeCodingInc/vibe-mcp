/**
 * The /vibe command an earlier release installed is updated; anything else is
 * left alone (2026-11-21).
 *
 * Every /vibe command shipped from v0.8.27 to v0.9.21 told the agent to offer
 * Send in the host's question control. A pick there is not counted as the
 * person's choice, so people who installed those versions were offered a Send
 * that is refused. Setup now replaces <HOME>/.claude/commands/vibe.md when its
 * bytes are exactly one of those releases, and never otherwise.
 *
 * Every case runs setup's installHostCommands in a child whose HOME is a
 * scratch directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CURRENT = fs.readFileSync(path.join(ROOT, 'hosts', 'vibe-command.md'), 'utf8');
const V0917 = fs.readFileSync(path.join(__dirname, 'fixtures', 'vibe-command-v0.9.17.md'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cmd-upgrade-'));
  fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
  return home;
}

function install(home) {
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./setup.js').installHostCommands()))"], {
    cwd: ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_SETUP_NO_AUTORUN: '1', VIBE_API_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const cmd = (home, name = 'vibe.md') => path.join(home, '.claude', 'commands', name);

test('the fixture is the command v0.9.17 shipped, and its hash is in the shipped list', () => {
  const { SHIPPED_COMMAND_SHA256 } = require('../setup.js');
  assert.equal(sha(V0917), '5c1c767cf52eb6f5650f22f51d9a888c75d2c3a0dfe797cacb5c1fec41b0ea75');
  assert.ok(SHIPPED_COMMAND_SHA256.has(sha(V0917)));
  assert.ok(!SHIPPED_COMMAND_SHA256.has(sha(Buffer.from(CURRENT))), 'the current command is listed as an old one to replace');
  assert.match(V0917.toString('utf8'), /question control/);
  assert.doesNotMatch(CURRENT, /native question control/);
});

test('an installed command that is exactly an earlier release is replaced with the current one', () => {
  const home = machine();
  fs.writeFileSync(cmd(home), V0917);
  const out = install(home);
  assert.deepEqual(out, [{ host: 'Claude Code', path: cmd(home), replaced: true }]);
  assert.equal(fs.readFileSync(cmd(home), 'utf8'), CURRENT);
  assert.ok(!fs.existsSync(cmd(home, 'vibe-moves.md')), 'installed beside it instead of replacing it');
});

test('a command with any other content is left alone, and the current one installs beside it as /vibe-moves', () => {
  const home = machine();
  const mine = Buffer.concat([V0917, Buffer.from('\nmy own line\n')]);
  fs.writeFileSync(cmd(home), mine);
  const out = install(home);
  assert.ok(fs.readFileSync(cmd(home)).equals(mine), 'the person\'s own command was changed');
  assert.deepEqual(out, [{ host: 'Claude Code', path: cmd(home, 'vibe-moves.md') }]);
  assert.equal(fs.readFileSync(cmd(home, 'vibe-moves.md'), 'utf8'), CURRENT);
  // A second run changes nothing: vibe-moves.md is now the current command, not an old one.
  assert.deepEqual(install(home), []);
  assert.ok(fs.readFileSync(cmd(home)).equals(mine));
});

test('a link to an earlier release is the person\'s arrangement and is left alone', () => {
  const home = machine();
  const target = path.join(home, 'elsewhere.md');
  fs.writeFileSync(target, V0917);
  fs.symlinkSync(target, cmd(home));
  install(home);
  assert.ok(fs.lstatSync(cmd(home)).isSymbolicLink());
  assert.ok(fs.readFileSync(target).equals(V0917), 'wrote through the link');
});

test('a missing command is installed as before', () => {
  const home = machine();
  const out = install(home);
  assert.deepEqual(out, [{ host: 'Claude Code', path: cmd(home) }]);
  assert.equal(fs.readFileSync(cmd(home), 'utf8'), CURRENT);
  // Running setup again leaves the current command as it is.
  assert.deepEqual(install(home), []);
});

test('the shipped list matches every tagged release, where the tags are present', (t) => {
  let tags;
  try { tags = execFileSync('git', ['tag', '-l', 'v0.*'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { tags = []; }
  if (!tags.includes('v0.9.24')) { t.skip('release tags not available in this checkout'); return; }
  const { SHIPPED_COMMAND_SHA256 } = require('../setup.js');
  const seen = new Set();
  // Releases up to v0.9.24: v0.9.21 was the last to ship a question-control
  // command, v0.9.22 the last without the line on a thread's "you", v0.9.23
  // the last without "or what to type in it", v0.9.24 the last without
  // "the preview is the offer".
  const upTo = (tag) => { const [a, b, c] = tag.slice(1).split('.').map(Number); return a === 0 && (b < 9 || (b === 9 && c <= 24)); };
  for (const tag of tags.filter(upTo)) {
    let body;
    try { body = execFileSync('git', ['show', `${tag}:hosts/vibe-command.md`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    seen.add(sha(body));
  }
  assert.deepEqual([...seen].sort(), [...SHIPPED_COMMAND_SHA256].sort());
});

// ── at server start (host-command.js refresh, called from index.js) ─────────

function refresh(home, env = {}) {
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./host-command.js').refresh()))"], {
    cwd: ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, VIBE_SETUP_NO_AUTORUN: '1', VIBE_API_URL: 'http://127.0.0.1:9', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('refresh at start: an earlier release\'s vibe.md and vibe-moves.md are replaced; nothing is created', () => {
  const home = machine();
  fs.writeFileSync(cmd(home), V0917);
  fs.writeFileSync(cmd(home, 'vibe-moves.md'), V0917);
  assert.deepEqual(refresh(home).sort(), [cmd(home), cmd(home, 'vibe-moves.md')].sort());
  assert.equal(fs.readFileSync(cmd(home), 'utf8'), CURRENT);
  assert.equal(fs.readFileSync(cmd(home, 'vibe-moves.md'), 'utf8'), CURRENT);
  assert.deepEqual(refresh(home), [], 'already current: nothing to do');
  const empty = machine();
  assert.deepEqual(refresh(empty), []);
  assert.deepEqual(fs.readdirSync(path.join(empty, '.claude', 'commands')), [], 'refresh created a command');
  const noClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cmd-none-'));
  assert.deepEqual(refresh(noClaude), []);
  assert.deepEqual(fs.readdirSync(noClaude), []);
});

test('refresh at start leaves the person\'s own command, and a link, alone; no temporary file is left', () => {
  const home = machine();
  const mine = Buffer.concat([V0917, Buffer.from('mine\n')]);
  fs.writeFileSync(cmd(home), mine);
  const target = path.join(home, 'elsewhere.md');
  fs.writeFileSync(target, V0917);
  fs.symlinkSync(target, cmd(home, 'vibe-moves.md'));
  assert.deepEqual(refresh(home), []);
  assert.ok(fs.readFileSync(cmd(home)).equals(mine));
  assert.ok(fs.lstatSync(cmd(home, 'vibe-moves.md')).isSymbolicLink());
  assert.ok(fs.readFileSync(target).equals(V0917), 'wrote through the link');
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'commands')).sort(), ['vibe-moves.md', 'vibe.md']);
});

test('refresh honours CLAUDE_CONFIG_DIR', () => {
  const home = machine();
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cmd-conf-'));
  fs.mkdirSync(path.join(conf, 'commands'));
  fs.writeFileSync(path.join(conf, 'commands', 'vibe.md'), V0917);
  fs.writeFileSync(cmd(home), V0917);
  assert.deepEqual(refresh(home, { CLAUDE_CONFIG_DIR: conf }), [path.join(conf, 'commands', 'vibe.md')]);
  assert.ok(fs.readFileSync(cmd(home)).equals(V0917), 'touched ~/.claude while CLAUDE_CONFIG_DIR named another');
});

test('the server runs the refresh at start, behind the lab-isolation guard', () => {
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n';
  const start = (env) => spawnSync(process.execPath, [path.join(ROOT, 'index.js')], {
    input: initialize, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, VIBE_API_URL: 'http://127.0.0.1:9', CI: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '', ...env },
  });
  // An isolated identity (VIBE_HOME) with the real Claude dir: never edited.
  const home = machine();
  fs.writeFileSync(cmd(home), V0917);
  start({ HOME: home, VIBE_HOME: path.join(home, '.vibe-lab') });
  assert.ok(fs.readFileSync(cmd(home)).equals(V0917), 'a lab identity edited the real command');
  // Isolated, with its own Claude dir: that one is refreshed.
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cmd-srv-'));
  fs.mkdirSync(path.join(conf, 'commands'));
  fs.writeFileSync(path.join(conf, 'commands', 'vibe.md'), V0917);
  start({ HOME: home, VIBE_HOME: path.join(home, '.vibe-lab'), CLAUDE_CONFIG_DIR: conf });
  assert.equal(fs.readFileSync(path.join(conf, 'commands', 'vibe.md'), 'utf8'), CURRENT);
  // The everyday identity (no VIBE_HOME): ~/.claude is refreshed.
  start({ HOME: home });
  assert.equal(fs.readFileSync(cmd(home), 'utf8'), CURRENT);
});
