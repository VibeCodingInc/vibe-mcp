'use strict';
/**
 * A message to a hyphenated login goes to the handle as the platform spells it.
 *
 * GitHub sign-in gives "rae-lin" the handle "rae_lin", and that is where their
 * inbox is read. The platform accepts a send to "rae-lin" (its existence check
 * folds the dash) but stores it under "rae-lin", where rae_lin never sees it.
 * So the client asks the identity lookup and addresses the spelling it
 * answers: in the draft (to, rev, digest), however the draft was opened. A login the
 * platform really stores with the dash keeps it; one that is not on /vibe is
 * still held for the GitHub login as typed.
 *
 * Sends run through the REAL store/api.js against a local HTTP server; the
 * identity lookup is stubbed at fetch. Nothing here reaches production.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hyphen-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

const posts = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    if (req.method === 'POST' && req.url.startsWith('/api/v2/messages')) {
      const body = JSON.parse(raw || '{}');
      posts.push(body);
      return res.end(JSON.stringify({ success: true, message: { id: `msg_${posts.length}`, body: body.body, created_at: new Date().toISOString() }, storedLength: body.body.length }));
    }
    res.end(JSON.stringify({ success: true, messages: [] }));
  });
});
const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// identity[h] = what /api/identity/<h> answers: a handle string (200), 404, or 'throw'.
let identity = {};
const lookups = [];
const origFetch = global.fetch;
let store; let drafts; let invite;
before(async () => {
  await ready;
  process.env.VIBE_API_URL = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    lookups.push(h);
    const a = identity[h];
    if (a === 'throw') throw new Error('offline');
    if (a === 404) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ handle: a === undefined ? h : a, kind: 'human' }) };
  };
  store = require('../store');
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  drafts = require('./drafts');
  invite = require('../invite');
});
after(() => { global.fetch = origFetch; server.close(); });
beforeEach(() => { posts.length = 0; lookups.length = 0; identity = {}; });

const digest = (to, body) => crypto.createHash('sha256').update(`${to}\n${body}`, 'utf8').digest('hex');

test('a draft to rae-lin, whose account is rae_lin, is to rae_lin: preview, digest and stored recipient', async () => {
  identity['rae-lin'] = 'rae_lin';
  const p = await drafts.vibe_prepare.handler({ handle: '@rae-lin', message: 'the lease holds' });
  assert.equal(lookups.length, 1, 'one identity request for the whole prepare');
  assert.equal(p.data.draft.to, 'rae_lin');
  assert.match(p.display, /\*\*To:\*\* @rae_lin /);
  assert.notEqual(p.data.draft.held, true);
  const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(r.data.sent, true);
  assert.match(r.display, /Sent to \*\*@rae_lin\*\*/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to, 'rae_lin');
  assert.equal(posts[0].approved_sha256, digest('rae_lin', 'the lease holds'), 'the approval is over the recipient that is stored');
});

test('an account the platform stores with the dash keeps the dash', async () => {
  identity['old-timer'] = 'old-timer';
  const p = await drafts.vibe_prepare.handler({ handle: 'old-timer', message: 'still here?' });
  assert.equal(lookups.length, 1);
  assert.equal(p.data.draft.to, 'old-timer');
  await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(posts[0].to, 'old-timer');
  assert.equal(posts[0].approved_sha256, digest('old-timer', 'still here?'));
});

test('a hyphenated login not on /vibe is still held for the GitHub login as typed, with one request', async () => {
  identity['new-comer'] = 404;
  const p = await drafts.vibe_prepare.handler({ handle: 'new-comer', message: 'when you join, look at this' });
  assert.equal(lookups.length, 1);
  assert.equal(p.data.draft.held, true);
  assert.equal(p.data.draft.to, 'new-comer');
  assert.equal(p.data.draft.for_github, 'new-comer');
  assert.equal(posts.length, 0);
});

test('a lookup that fails keeps the handle as typed, and the message still sends', async () => {
  identity['net-down'] = 'throw';
  const p = await drafts.vibe_prepare.handler({ handle: 'net-down', message: 'try anyway' });
  assert.equal(p.data.draft.to, 'net-down');
  assert.notEqual(p.data.draft.held, true, 'could not tell is never absent');
  const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(r.data.sent, true);
  assert.equal(posts[0].to, 'net-down');

  identity['net-down2'] = 'throw';
  const typed = await drafts.vibe_send.handler({ handle: 'net-down2', message: 'my own words' });
  assert.equal(typed.data.sent, false, 'a handle + message opens a draft; it never sends');
  assert.equal(typed.data.draft.to, 'net-down2');
  assert.equal(posts.length, 1);
  const r2 = await drafts.vibe_send.handler({ id: typed.data.draft.id, rev: typed.data.draft.rev });
  assert.equal(r2.data.sent, true);
  assert.equal(posts[1].to, 'net-down2');
});

test('only a dash-for-underscore answer changes the spelling; anything else leaves it as typed', async () => {
  for (const [typed, answered] of [['ab-cd', 'abcd'], ['ab-cd', 'ab_ce'], ['ab-cd', 'xy_zw']]) {
    identity = { [typed]: answered };
    const r = await invite.resolveRecipient(typed);
    assert.equal(r.handle, typed, `${typed} vs ${answered}`);
  }
});

test('a handle with no dash makes no identity request from the resolver', async () => {
  const r = await invite.resolveRecipient('linus');
  assert.deepEqual(r, { handle: 'linus', who: null });
  assert.equal(lookups.length, 0);
});

test('dictated words to rae-lin are previewed to rae_lin, then sent there', async () => {
  identity['rae-lin'] = 'rae_lin';
  const p = await drafts.vibe_send.handler({ handle: ' @Rae-Lin ', message: 'shipping now' });
  assert.equal(p.data.sent, false);
  assert.equal(posts.length, 0, 'nothing leaves before Send');
  assert.equal(p.data.draft.to, 'rae_lin');
  assert.equal(lookups.length, 1);
  const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
  assert.equal(r.data.sent, true);
  assert.match(r.display, /Sent to \*\*@rae_lin\*\*/);
  assert.equal(posts[0].to, 'rae_lin');
  assert.equal(posts[0].body, 'shipping now');
  assert.equal(posts[0].approved_sha256, digest('rae_lin', 'shipping now'));
  assert.equal(require('../reach').isKnown('rae_lin'), true, 'their answer arrives from rae_lin, so that is who is known');
});

test('yourself under the other spelling is still yourself', async () => {
  // ada_b signed in; typing ada-b resolves to ada_b and is refused before anything is sent.
  const config = require('../config');
  const orig = config.getHandle;
  config.getHandle = () => 'ada_b';
  identity['ada-b'] = 'ada_b';
  try {
    const p = await drafts.vibe_prepare.handler({ handle: 'ada-b', message: 'note' });
    assert.match(p.display, /can't draft to yourself/);
    const s = await drafts.vibe_send.handler({ handle: 'ada-b', message: 'note' });
    assert.match(s.display, /can't draft to yourself/);
    assert.equal(posts.length, 0);
  } finally { config.getHandle = orig; }
});
