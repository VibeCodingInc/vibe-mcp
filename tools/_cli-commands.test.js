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

// ── trust: a grant to a specific person, tested like one ────────────────────
const http = require('node:http');
const { spawn } = require('node:child_process');

const jwt = (h, exp = Math.floor(Date.now() / 1000) + 3600) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp })).toString('base64url')}.sig`;
function homeFor(handle, token = handle && jwt(handle)) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-trust-'));
  fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
  if (handle) fs.writeFileSync(path.join(home, '.vibe', 'auth.json'), JSON.stringify({ handle, token, provider: 'github', authenticated_at: new Date().toISOString() }));
  return home;
}
/** A stand-in identity service. `known` maps handle → served body (or a function of the response). */
function identityServer(known) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/api\/identity\/([^/?]+)$/);
    const h = m ? decodeURIComponent(m[1]) : null;
    asked.push(h);
    const body = h && known[h];
    if (typeof body === 'function') return body(res);
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body || { error: 'identity_not_found' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((r) => server.close(r)) })));
}
// Asynchronous on purpose: the identity server lives in this process, and a
// synchronous child would stop it from answering.
function trustCli(args, home, apiUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', VIBE_SETUP_STUB_BROWSER: '1' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const lines = (home) => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'lines.json'), 'utf8'))); } catch { return []; } };
const SAM = { handle: 'sam', kind: 'human', operator: null, since: '2026-02-05T16:43:21.453Z' };

test('trust: a real person is named, then the line opens', async () => {
  const api = await identityServer({ sam: SAM });
  try {
    const home = homeFor('nell');
    const r = await trustCli(['trust', '@Sam'], home, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /@sam is a person on \/vibe, since February 2026\./);
    assert.ok(r.stdout.indexOf('@sam is a person') < r.stdout.indexOf('Open line with @sam'), 'who it is comes before the line opens');
    assert.deepEqual(lines(home), ['sam']);
  } finally { await api.close(); }
});

test('trust: a typo that names nobody opens nothing', async () => {
  const api = await identityServer({ sam: SAM });
  try {
    const home = homeFor('nell');
    const r = await trustCli(['trust', '@sma'], home, api.url);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /There is no @sma on \/vibe/);
    assert.match(r.stderr, /No line was opened/);
    assert.deepEqual(lines(home), []);
  } finally { await api.close(); }
});

test('trust: a malformed handle is refused before anything is asked', async () => {
  const api = await identityServer({ sam: SAM });
  try {
    const home = homeFor('nell');
    for (const bad of ['sam!', '@', 'a', '-sam', 'sam/../x', 'sam@evil', 'x'.repeat(60), '@sam\u001b[31m']) {
      const r = await trustCli(['trust', bad], home, api.url);
      assert.equal(r.status, 1, `accepted ${JSON.stringify(bad)}`);
      assert.match(r.stderr, /is not a handle|One handle at a time/);
    }
    const spaced = await trustCli(['trust', '@sam', 'and', '@ada'], home, api.url);
    assert.equal(spaced.status, 1);
    assert.match(spaced.stderr, /One handle at a time/);
    assert.deepEqual(api.asked, [], 'a malformed handle reached the network');
    assert.deepEqual(lines(home), []);
  } finally { await api.close(); }
});

test('trust: signed out, or with an expired sign-in, opens nothing and asks nothing', async () => {
  const api = await identityServer({ sam: SAM });
  try {
    for (const home of [homeFor(null), homeFor('nell', jwt('nell', Math.floor(Date.now() / 1000) - 60))]) {
      const r = await trustCli(['trust', '@sam'], home, api.url);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Sign in first: npx slashvibe-mcp setup/);
      assert.deepEqual(lines(home), []);
    }
    assert.deepEqual(api.asked, []);
  } finally { await api.close(); }
});

test('trust: fails closed when the check cannot answer', async () => {
  const home = homeFor('nell');
  // Nothing listening.
  const down = await trustCli(['trust', '@sam'], home, 'http://127.0.0.1:9');
  assert.equal(down.status, 1);
  assert.match(down.stderr, /Could not reach \/vibe/);
  // A server error, a body that is not an identity, and an identity for someone else.
  const api = await identityServer({
    sam: (res) => { res.writeHead(500); res.end('{}'); },
    ada: (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>ok</html>'); },
    ben: { handle: 'someone-else', kind: 'human' },
  });
  try {
    for (const h of ['sam', 'ada', 'ben']) {
      const r = await trustCli(['trust', `@${h}`], home, api.url);
      assert.equal(r.status, 1, `${h} was trusted on an unclear answer`);
      assert.match(r.stderr, /Could not confirm that @/);
    }
  } finally { await api.close(); }
  assert.deepEqual(lines(home), []);
});

test('trust: not yourself; an agent is called an agent; served text is never echoed raw', async () => {
  const api = await identityServer({
    nell: { handle: 'nell', kind: 'human' },
    bot: { handle: 'bot', kind: 'agent', operator: 'sam', since: 'not a date' },
    odd: { handle: 'odd', kind: '\u001b[31mroot\u001b[0m', operator: 'x y; rm -rf', since: '\u001b[2J' },
  });
  try {
    const home = homeFor('nell');
    const self = await trustCli(['trust', '@nell'], home, api.url);
    assert.equal(self.status, 1);
    assert.match(self.stderr, /@nell is you/);
    const bot = await trustCli(['trust', '@bot'], home, api.url);
    assert.match(bot.stdout, /@bot is an agent run by @sam on \/vibe\./);
    const odd = await trustCli(['trust', '@odd'], home, api.url);
    assert.equal(odd.status, 0);
    assert.match(odd.stdout, /@odd is an account on \/vibe\./);
    assert.ok(!/\u001b|rm -rf|root/.test(odd.stdout), 'served text reached the terminal');
    assert.deepEqual(lines(home), ['bot', 'odd']);
  } finally { await api.close(); }
});

test('untrust needs no network and closes the line', async () => {
  const home = homeFor('nell');
  fs.writeFileSync(path.join(home, '.vibe', 'lines.json'), JSON.stringify({ sam: { since: 1 } }));
  const r = await trustCli(['untrust', '@sam'], home, 'http://127.0.0.1:9');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Closed the line with @sam/);
  assert.deepEqual(lines(home), []);
});
