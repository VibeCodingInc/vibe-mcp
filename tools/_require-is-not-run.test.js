/**
 * Loading a file is not running it (2026-11-21).
 *
 * setup.js ran setup when it was required, so a one-liner that only meant to
 * look at its exports signed in to production as the machine's real user. The
 * entry files (setup.js, cli.js, index.js, draft-cli.js, the two hooks) now act
 * only as the entry point, or when a caller asks (setup.run(), index.start()).
 *
 * This test requires every JavaScript file the package ships, in a child with a
 * scratch HOME, with argv saying "setup" and WITHOUT VIBE_SETUP_NO_AUTORUN, so it
 * proves the guard itself rather than the environment variable. A preload refuses
 * and records any non-local connection and any child process, so a regression
 * fails here instead of reaching the network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));

const PRELOAD = `
const net = require('net'); const cp = require('child_process');
const seen = (globalThis.__requireSeen = []);
const local = (h) => !h || ['127.0.0.1', 'localhost', '::1'].includes(String(h));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  let o = Array.isArray(a[0]) ? a[0][0] : a[0];
  const host = o && typeof o === 'object' ? (o.path ? null : o.host) : (typeof a[1] === 'string' ? a[1] : null);
  if (!local(host)) { seen.push('connect ' + host); throw new Error('blocked connect'); }
  return connect.apply(this, a);
};
globalThis.fetch = async (u) => { seen.push('fetch ' + String(u && u.url || u)); throw new TypeError('blocked fetch'); };
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[k] = (...a) => { seen.push(k + ' ' + String(a[0])); throw new Error('blocked ' + k); };
}
`;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [p + '/', ...walk(p)] : [p];
  });
}

test('requiring any shipped file runs nothing: no network, no child process, no file written', () => {
  const files = PKG.files.filter((f) => /\.(c?js)$/.test(f));
  for (const entry of ['setup.js', 'cli.js', 'index.js', 'draft-cli.js', 'hooks/arrival-hook.cjs', 'session-start-hook.cjs']) {
    assert.ok(files.includes(entry), `${entry} is no longer shipped; update this test`);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-cwd-'));
  const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-pre-')), 'preload.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const script = `
    process.argv.push('setup');
    const errors = [];
    for (const f of ${JSON.stringify(files)}) {
      try { require(${JSON.stringify(ROOT)} + '/' + f); } catch (e) { errors.push(f + ': ' + e.message); }
    }
    setTimeout(() => {
      process.stdout.write('\\n@@' + JSON.stringify({ seen: globalThis.__requireSeen, errors, exitCode: process.exitCode || 0 }) + '\\n');
      process.exit(0);
    }, 400);
  `;
  const env = {
    PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'),
    VIBE_API_URL: 'http://127.0.0.1:9', VIBE_SETUP_STUB_BROWSER: '1', CI: '1',
  };
  const r = spawnSync(process.execPath, ['--require', preload, '-e', script], { cwd: work, env, encoding: 'utf8', timeout: 20_000, input: '' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `no report from the child: ${r.stdout}\n${r.stderr}`);
  const report = JSON.parse(line.slice(2));
  assert.deepEqual(report.seen, [], 'loading a file reached out');
  assert.deepEqual(report.errors, [], 'a shipped file threw when loaded');
  assert.equal(report.exitCode, 0, 'loading a file set a failing exit code');
  assert.equal(r.stdout.replace(line, '').trim(), '', 'loading a file printed something');
  assert.deepEqual(walk(home), [], 'loading a file wrote under HOME');
  assert.deepEqual(walk(work), [], 'loading a file wrote in the working directory');
});

test('the entry points still run: cli.js setup calls setup.run(), cli.js with no terminal starts the server', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
  assert.ok(!/require\('\.\/setup\.js'\);/.test(cli), 'cli.js loads setup.js expecting it to run');
  assert.ok((cli.match(/require\('\.\/setup\.js'\)\.run\(\)/g) || []).length >= 3);
  assert.match(cli, /require\('\.\/index\.js'\)\.start\(\)/);
  const setup = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
  assert.match(setup, /if \(require\.main === module\) run\(\);/);
  assert.match(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'), /if \(require\.main === module\) start\(\);/);
});

test('node index.js still answers as an MCP server', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-srv-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'index.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
    env: { PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_API_URL: 'http://127.0.0.1:9', CI: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
    encoding: 'utf8', timeout: 20_000,
  });
  const init = r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 1);
  assert.ok(init && init.result && init.result.serverInfo, r.stderr);
});

test('cli.js with no terminal starts the server, and setup with VIBE_SETUP_NO_AUTORUN set refuses', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-cli-'));
  const env = { PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_API_URL: 'http://127.0.0.1:9', CI: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' };
  const srv = spawnSync(process.execPath, [path.join(ROOT, 'cli.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
    env, encoding: 'utf8', timeout: 20_000,
  });
  assert.ok(srv.stdout.split('\n').some((l) => { try { return JSON.parse(l).id === 1; } catch { return false; } }), srv.stderr);
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-require-cli2-'));
  const env2 = { ...env, HOME: home2, VIBE_HOME: path.join(home2, '.vibe'), VIBE_SETUP_NO_AUTORUN: '1' };
  const setup = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), 'setup'], { env: env2, encoding: 'utf8', timeout: 20_000 });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /setup not run/);
  assert.deepEqual(walk(home2), []);
});
