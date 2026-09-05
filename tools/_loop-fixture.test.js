const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = import('../scripts/loop-fixture.mjs');
const side = { handle: 'vibecanary', mint: 'not-a-session-fixture-mint' };
const jwt = overrides => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: side.handle, handle: side.handle, mint: 'agent', principal_id: 'principal_fixture', ...overrides })).toString('base64url'), 'fixture-signature'].join('.');
const response = (status, data) => ({ status, json: async () => data });

test('loop fixture allows only the exact dedicated pair and canonical origin', async () => {
  const { validatePair, LIVE_API } = await fixture;
  const b = { handle: 'vibecanary2', mint: 'second-fixture-mint' };
  assert.doesNotThrow(() => validatePair(side, b, LIVE_API));
  for (const h of ['brightseth', 'seth', 'solienne', 'vibecanary2', 'qa_anything']) assert.throws(() => validatePair({ ...side, handle: h }, b, LIVE_API));
  assert.throws(() => validatePair(side, { ...b, handle: side.handle }, LIVE_API));
  for (const url of ['https://slashvibe.dev', LIVE_API + '/other', 'https://example.com', 'http://localhost:1234']) assert.throws(() => validatePair(side, b, url));
  assert.throws(() => validatePair(side, { ...b, mint: '' }, LIVE_API));
});

test('loop fixture exchanges mint for server-verified durable agent JWT, never uses mint as bearer', async () => {
  const { mintSession, LIVE_API } = await fixture;
  const calls = [], secrets = new Set([side.mint]), token = jwt();
  const request = async (url, options) => { calls.push({ url, options }); return calls.length === 1 ? response(200, { handle: side.handle, token }) : response(200, { valid: true, handle: side.handle }); };
  assert.equal(await mintSession(side, secrets, request), token);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, LIVE_API + '/api/auth/buddy-token');
  assert.equal(calls[0].options.headers['x-agent-mint'], side.mint);
  assert.deepEqual(JSON.parse(calls[0].options.body), { handle: side.handle });
  assert.equal(calls[1].url, LIVE_API + '/api/auth/verify');
  assert.equal(calls[1].options.headers.authorization, 'Bearer ' + token);
  for (const call of calls) { assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal); }
  assert.ok(secrets.has(token));
});

test('loop fixture refuses wrong identity, missing principal, or non-agent before verify/send', async () => {
  const { mintSession } = await fixture;
  for (const claims of [{ sub: 'brightseth' }, { handle: 'brightseth' }, { mint: 'human' }, { principal_id: null }]) {
    let calls = 0;
    await assert.rejects(mintSession(side, new Set(), async () => { calls++; return response(200, { handle: side.handle, token: jwt(claims) }); }), /mismatch/);
    assert.equal(calls, 1);
  }
});

test('loop fixture refuses mint HTTP errors without echoing its body', async () => {
  const { mintSession } = await fixture;
  await assert.rejects(mintSession(side, new Set(), async () => response(403, { error: side.mint })), e => e.message === 'Lab mint refused (HTTP 403)');
});

test('loop fixture refuses a session whose signature, generation, or identity fails verification', async () => {
  const { mintSession } = await fixture;
  for (const check of [response(401, { valid: false }), response(200, { valid: true, handle: 'brightseth' }), response(200, { valid: false, handle: side.handle })]) {
    let calls = 0;
    await assert.rejects(mintSession(side, new Set(), async () => ++calls === 1 ? response(200, { handle: side.handle, token: jwt() }) : check), /verification failed/);
  }
});

test('loop fixture gives children no ambient credential or code-injection environment', async () => {
  const { childEnvironment } = await fixture;
  const env = childEnvironment('/tmp/example-lab', { PATH: '/bin', LANG: 'C', HOME: '/actual-user', VIBE_LAB_A_MINT: side.mint, VIBE_LAB_B_MINT: 'other', GH_TOKEN: 'github', VERCEL_TOKEN: 'vercel', NODE_OPTIONS: '--import evil.mjs', HTTP_PROXY: 'http://evil', VIBE_QA_TOKEN: 'qa', VIBE_SESSION_TOKEN: 'human' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'VIBE_API_URL', 'VIBE_HOME', 'VIBE_SETUP_NO_AUTORUN'].sort());
  assert.equal(env.VIBE_HOME, '/tmp/example-lab/.vibe');
  assert.equal(env.HOME, '/tmp/example-lab');
  assert.ok(!JSON.stringify(env).includes(side.mint));
});

test('loop fixture stores only session JWT in restricted temporary home and cleans exact created target', async () => {
  const { signedInHome, cleanHomes } = await fixture;
  const homes = new Set();
  const token = jwt();
  const dir = signedInHome(side.handle, token, homes);
  try {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const filename of ['auth.json', 'config.json']) {
      const p = path.join(dir, '.vibe', filename);
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(text.includes(token));
      assert.ok(!text.includes(side.mint));
    }
  } finally { cleanHomes(homes); }
  assert.equal(homes.size, 0);
  assert.equal(fs.existsSync(dir), false);
});

test('loop fixture refuses broad cleanup targets', async () => {
  const { cleanHomes } = await fixture;
  for (const dir of ['/', '/tmp', process.cwd(), '/tmp/unrelated-fixture']) assert.throws(() => cleanHomes(new Set([dir])), /unsafe fixture cleanup/);
});

test('loop fixture redacts full values before truncation and newly minted sessions', async () => {
  const { redactor } = await fixture;
  const long = 'fake-secret-'.repeat(40);
  const secrets = new Set([long]);
  const redact = redactor(secrets);
  assert.equal(redact(long + ' useful').slice(0, 200), '[redacted] useful');
  const token = jwt(); secrets.add(token);
  assert.equal(redact(token), '[redacted]');
});

test('loop fixture concurrent closes share one wait and do not authorize cleanup until child closes', async () => {
  const { EventEmitter } = require('node:events');
  const { childCloser } = await fixture;
  const child = new EventEmitter();
  let ended = 0, killed = 0, cleaned = 0;
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdin: { end: () => ended++ }, kill: () => killed++ });
  const close = childCloser(child, () => cleaned++);
  const first = close(), second = close();
  assert.equal(first, second);
  assert.equal(cleaned, 0);
  child.emit('close');
  await Promise.all([first, second]);
  assert.equal(cleaned, 1); assert.equal(ended, 1); assert.equal(killed, 1);
});

test('loop fixture failed spawn has no child to await or kill', async () => {
  const { childCloser } = await fixture;
  let cleaned = 0;
  const close = childCloser({ pid: undefined, exitCode: null, signalCode: null, kill: () => assert.fail('no spawned child') }, () => cleaned++);
  await close();
  assert.equal(cleaned, 1);
});

test('live runner only launches a pinned local checkout, not an npx process tree', () => {
  const text = fs.readFileSync(path.join(__dirname, '../scripts/loop-acceptance.mjs'), 'utf8');
  assert.match(text, /if \(VERSION !== 'local'\) throw/);
  assert.match(text, /spawn\(process\.execPath/);
  assert.doesNotMatch(text, /\['npx',/);
});

test('shutdown during a leg close forbids the next leg before cleanup proceeds', async () => {
  const { EventEmitter } = require('node:events');
  const { childCloser, assertRunning } = await fixture;
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdin: { end() {} }, kill() {} });
  const close = childCloser(child, () => {});
  let stopping = false, nextSpawned = false;
  // main registers its continuation first, as in the reproduced shutdown race.
  const main = (async () => { await close(); assertRunning(stopping); nextSpawned = true; })();
  const rejected = assert.rejects(main, /shutting down/);
  stopping = true;
  const shutdown = close();
  child.emit('close');
  await Promise.all([shutdown, rejected]);
  assert.equal(nextSpawned, false);
  const text = fs.readFileSync(path.join(__dirname, '../scripts/loop-acceptance.mjs'), 'utf8');
  assert.match(text, /function session\(side, home\) \{\s*assertRunning\(shuttingDown\)/);
  assert.match(text, /const rpc = .*assertRunning\(shuttingDown\)/);
});

// The runner's parsers against the REAL handlers' output (codex P2 on the trim:
// the runner must never drift from what the tools actually print).
test('runner parsers read the current tool output: draft id/rev from the tool-only trailer, linked answer, receipt, verified reply line', async () => {
  const os = require('node:os');
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-parse-')); process.env.VIBE_HOME = HOME;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig` }));
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  const store = require('../store/api.js');
  Object.assign(store, { getActiveUsersResult: async () => ({ ok: true, users: [] }), getActiveUsers: async () => [], getPeople: async () => ({ ok: true, listings: [] }), getInboxResult: async () => ({ ok: true, threads: [] }), getInbox: async () => [], getUnreadCount: async () => 0, getRawInbox: async () => [], getThread: async () => [], markThreadRead: async () => {}, sendTypingIndicator: async () => {}, heartbeat: async () => ({ ok: true }), sendMessage: async () => ({ id: 'msg_parse_1', success: true }) });
  const moves = require('../tools/moves.js');
  const { parseDraft, answersLinked, parseReceipt, verifiedReplyFrom } = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'scripts', 'loop-fixture.mjs')).href);
  const d = await moves.vibe_draft.handler({ handle: '@linus', message: 'the cloud side decides.', reply_to: 'msg_q1' });
  const p = parseDraft(d.display);
  assert.ok(p && p.id && /^[0-9a-f]{8}$/.test(p.rev), `parsed ${JSON.stringify(p)}`);
  assert.equal(p.rev, d.data.draft.rev);
  assert.ok(answersLinked(d.display));
  const s = await moves.vibe_send_draft.handler({ id: p.id, rev: p.rev });
  assert.equal(parseReceipt(s.display), 'msg_parse_1');
  assert.ok(verifiedReplyFrom('↩ @linus answered what you asked from **runtime** ("q"): "the cloud side decides."', 'linus', 'the cloud side decides.'));
  assert.ok(!verifiedReplyFrom('↩ @linus wrote after what you sent ("q"): "x"', 'linus'));
  fs.rmSync(HOME, { recursive: true, force: true });
});
