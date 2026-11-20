'use strict';
/**
 * What deliver says happened must be what happened (review findings, 0.9.15).
 *
 *  - A reply the client cannot read is not a receipt. A 200 whose body is not
 *    JSON, or { success: false } with no error, used to print "Sent to @x".
 *    It is an uncertain failure now, and a draft treats it as one: retry the
 *    same text under the same key, or cancel.
 *  - " @me " is still me: the recipient and the self-check use one canonical form.
 *  - "not in a session right now" is said only when presence was actually read.
 *  - No user-facing string names a tool or command that does not exist.
 *
 * The send runs through the REAL store/api.js against a local HTTP server, so
 * the { raw } shape is the one requestOnce really produces. Nothing here
 * reaches production.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-send-truth-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

let reply = 'ok';
const posts = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/api/v2/messages')) {
      const body = JSON.parse(raw || '{}');
      posts.push(body);
      res.statusCode = 200;
      if (reply === 'raw') { res.setHeader('content-type', 'text/html'); return res.end('<html>ok</html>'); }
      res.setHeader('content-type', 'application/json');
      if (reply === 'bare-false') return res.end(JSON.stringify({ success: false }));
      return res.end(JSON.stringify({ success: true, message: { id: `msg_${posts.length}`, body: body.body, created_at: new Date().toISOString() }, storedLength: body.body.length }));
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, messages: [] }));
  });
});
const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let store; let deliver; let drafts;
let presence = { ok: true, users: [] };
const origFetch = global.fetch;
before(async () => {
  await ready;
  process.env.VIBE_API_URL = `http://127.0.0.1:${server.address().port}`;
  store = require('../store');
  // Presence is the one thing stubbed: each test says what the read returned.
  store.getActiveUsersResult = async () => presence;
  store.getActiveUsers = async () => { throw new Error('deliver must read presence with its outcome, not the flattened list'); };
  // vibe_prepare asks /api/identity whether the recipient exists; answer here.
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    return { ok: true, status: 200, json: async () => ({ handle: h, kind: 'human' }) };
  };
  ({ deliver } = require('./deliver'));
  drafts = require('./drafts');
});
after(() => { global.fetch = origFetch; server.close(); });

test('a 200 whose body is not JSON is not a receipt, and it is not a definite failure either', async () => {
  reply = 'raw';
  const r = await deliver({ to: 'linus', message: 'hello' });
  assert.deepEqual(r.data, { sent: false, definite: false });
  assert.doesNotMatch(r.display, /Sent to/);
  assert.match(r.display, /reply could not be read, so it is not known whether the message was stored/);
  assert.doesNotMatch(r.display, /Worth one retry/, 'a typed resend carries a new key and could deliver twice');
});

test('{ success: false } with no error string is not a receipt either', async () => {
  reply = 'bare-false';
  const r = await deliver({ to: 'linus', message: 'hello again' });
  assert.deepEqual(r.data, { sent: false, definite: false });
  assert.doesNotMatch(r.display, /Sent to/);
});

test('a draft whose Send got an unreadable reply is kept as unconfirmed, and the retry reuses its key', async () => {
  reply = 'raw';
  posts.length = 0;
  const p = await drafts.vibe_prepare.handler({ handle: 'grace', message: 'the lease holds at 2s' });
  const { id, rev } = p.data.draft;
  const first = await drafts.vibe_send.handler({ id, rev });
  assert.equal(first.data.sent, false);
  assert.match(first.display, /kept as unconfirmed: Send again retries exactly this text/);
  const again = await drafts.vibe_prepare.handler({ id });
  assert.match(again.display, /did not confirm/);
  assert.equal(again.data.draft.status, 'unknown');
  const edit = await drafts.vibe_prepare.handler({ id, message: 'something else' });
  assert.match(edit.display, /text is frozen/, 'an unconfirmed draft cannot be edited');

  reply = 'ok';
  const retry = await drafts.vibe_send.handler({ id, rev: again.data.draft.rev });
  assert.equal(retry.data.sent, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].idempotency_key, posts[0].idempotency_key, 'the retry names the same key, so the service delivers once');
});

test('a real success still reads as sent, with its receipt', async () => {
  reply = 'ok';
  presence = { ok: true, users: [] };
  const r = await deliver({ to: 'linus', message: 'hi' });
  assert.equal(r.data.sent, true);
  assert.match(r.display, /Sent to \*\*@linus\*\*/);
  assert.match(r.display, /receipt: msg_\d+ · 2 chars stored/);
});

test('" @ada " is ada: the padded self-target is refused before anything is sent', async () => {
  reply = 'ok';
  posts.length = 0;
  for (const to of [' @ada ', '@ADA', '  ada', '@@ada']) {
    const r = await deliver({ to, message: 'note to self' });
    assert.deepEqual(r.data, { sent: false, definite: true }, JSON.stringify(to));
    assert.match(r.display, /can't message yourself/);
  }
  assert.equal(posts.length, 0);
  const ok = await deliver({ to: ' @Linus ', message: 'padded is fine' });
  assert.equal(ok.data.sent, true);
  assert.equal(posts[0].to, 'linus', 'the recipient is sent in canonical form');
});

test('normalizeHandle trims before it strips the @', () => {
  const { normalizeHandle, displayHandle } = require('./_shared');
  assert.equal(normalizeHandle(' @alice '), 'alice');
  assert.equal(normalizeHandle('@Alice'), 'alice');
  assert.equal(normalizeHandle('synth-stan'), 'synth-stan', 'the dash is kept');
  assert.equal(displayHandle(' @alice '), '@alice');
});

test('"not in a session" is said only when presence was read', async () => {
  reply = 'ok';
  presence = { ok: false, users: [], error: 'transport_failed' };
  const unread = await deliver({ to: 'linus', message: 'one' });
  assert.equal(unread.data.sent, true);
  assert.doesNotMatch(unread.display, /not in a session/, 'a failed presence read says nothing about them');

  presence = { ok: false, users: [], error: 'unauthenticated' };
  assert.doesNotMatch((await deliver({ to: 'linus', message: 'two' })).display, /not in a session/);

  presence = { ok: true, users: [] };
  assert.match((await deliver({ to: 'linus', message: 'three' })).display, /@linus is not in a session right now/);

  presence = { ok: true, users: [{ handle: 'linus', status: 'active', lastSeen: Date.now() }] };
  assert.doesNotMatch((await deliver({ to: 'linus', message: 'four' })).display, /not in a session/);

  store.getActiveUsersResult = async () => { throw new Error('boom'); };
  try {
    const r = await deliver({ to: 'linus', message: 'five' });
    assert.equal(r.data.sent, true, 'presence trouble never turns a real send into a failure');
    assert.doesNotMatch(r.display, /not in a session/);
  } finally { store.getActiveUsersResult = async () => presence; }
});

test('@echo names the tool that exists', async () => {
  const r = await drafts.vibe_prepare.handler({ handle: 'echo', message: 'feedback' });
  assert.match(r.display, /vibe_send \(handle \+ message\)/);
  assert.doesNotMatch(r.display, /vibe_dm/);
});

test('no user-facing string names a tool or command that does not exist', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['tools/drafts.js', 'tools/deliver.js', 'tools/_shared.js', 'store/api.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /vibe_dm/, `${f} names vibe_dm`);
    assert.doesNotMatch(src, /vibe help/, `${f} names "vibe help"`);
    assert.doesNotMatch(src, /`vibe init`/, `${f} tells someone to run "vibe init", which is not a command`);
  }
  // The command these strings name instead is a real one.
  const cli = fs.readFileSync(path.join(root, 'cli.js'), 'utf8');
  assert.match(cli, /const COMMANDS = \[[^\]]*'setup'/);
});
