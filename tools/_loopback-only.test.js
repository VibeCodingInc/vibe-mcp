'use strict';
// Review SF-4: the suite talks only to loopback, and the bounded conversation
// read never refreshes and retries on a 401.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'test', 'loopback-only.cjs');

test('npm test loads the loopback-only guard', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--require \$\(pwd\)\/test\/loopback-only\.cjs/);
});

test('the guard fails a process that tried a non-loopback host, even when the error was swallowed; loopback is fine', () => {
  // 203.0.113.1 is TEST-NET-3: never routed, and refused before any packet leaves.
  const swallowed = spawnSync(process.execPath, ['--require', GUARD, '-e',
    "try { require('net').connect(443, '203.0.113.1'); } catch (e) {} console.log('carried on');"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(swallowed.status, 1, swallowed.stderr);
  assert.match(swallowed.stdout, /carried on/);
  assert.match(swallowed.stderr, /loopback-only: 1 connection attempt\(s\) to a non-loopback host .*203\.0\.113\.1/);
  const local = spawnSync(process.execPath, ['--require', GUARD, '-e',
    "const s = require('net').connect(9, '127.0.0.1'); s.on('error', () => {});"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(local.status, 0, local.stderr);
});

/** spawn, awaited: the test's own server must keep answering while the child runs. */
function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, opts);
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('getThreadBounded: a 401 is answered once; no token refresh, no retry', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-bounded-401-'));
  const jwt = (h, n) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, n, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
  // A newer token on disk than in memory: the ordinary 401 path would retry with it.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada', 2) }));
  const child = await runAsync(process.execPath, ['-e', `
    const store = require(${JSON.stringify(path.join(ROOT, 'store'))});
    require(${JSON.stringify(path.join(ROOT, 'auth-store'))}).setToken(${JSON.stringify(jwt('ada', 1))});
    store.getThreadBounded('ada', 'mira', { timeoutMs: 1000 }).then((t) => {
      console.log(JSON.stringify({ isArray: Array.isArray(t), failed: Boolean(t.readFailed), n: t.length }));
    });`], { env: { PATH: process.env.PATH, HOME: home, VIBE_HOME: home, VIBE_API_URL: `http://127.0.0.1:${server.address().port}`, VIBE_SETUP_NO_AUTORUN: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' } });
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  const out = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { isArray: true, failed: true, n: 0 }, child.stderr);
  assert.equal(hits, 1, `${hits} requests: the bounded read refreshed and retried`);
  assert.ok(!/attempting token refresh/.test(child.stderr), child.stderr);
});
