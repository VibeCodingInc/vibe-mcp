'use strict';
// 2026-09-02, the day of the invite: the session-start hook showed Seth his OWN
// reply as "MESSAGE from @brightseth". getRawInbox took each unread thread's
// last_message regardless of direction. "Waiting" means THEIR words.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let server, base;
const threads = {
  // last message is MINE (I replied; their earlier message is still unread)
  mine_last: { id: 'thread_A', with: 'them', unread: 1, last_message: { id: 'm3', from: 'me', body: 'my reply', created_at: '2026-09-02T22:14:00Z' } },
  // last message is THEIRS
  theirs_last: { id: 'thread_B', with: 'other', unread: 1, last_message: { id: 'm9', from: 'other', body: 'hello?', created_at: '2026-09-02T22:00:00Z' } },
  // unread but nothing of theirs at all (only my sends)
  only_mine: { id: 'thread_C', with: 'ghost', unread: 1, last_message: { id: 'm5', from: 'me', body: 'ping', created_at: '2026-09-02T21:00:00Z' } },
};
const threadMessages = {
  them: [ { id: 'm1', from: 'me', body: 'hi', created_at: '2026-09-02T22:00:00Z' }, { id: 'm2', from: 'them', body: 'what are you building?', created_at: '2026-09-02T22:04:00Z' }, { id: 'm3', from: 'me', body: 'my reply', created_at: '2026-09-02T22:14:00Z' } ],
  ghost: [ { id: 'm5', from: 'me', body: 'ping', created_at: '2026-09-02T21:00:00Z' } ],
};

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/api/messages' && u.searchParams.get('with')) {
      return res.end(JSON.stringify({ messages: threadMessages[u.searchParams.get('with')] || [] }));
    }
    if (u.pathname === '/api/messages') {
      return res.end(JSON.stringify({ threads: Object.values(threads), total_unread: 3 }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.VIBE_API_URL = base;
});
test.after(() => server.close());

test('a waiting message is always THEIR words, never my own last send', async () => {
  const store = require('../store/api.js');
  const rows = await store.getRawInbox('me');
  const byThread = Object.fromEntries(rows.map((r) => [r.thread_id, r]));
  assert.equal(byThread.thread_A.from, 'them', 'my reply must not be presented as waiting');
  assert.equal(byThread.thread_A.text, 'what are you building?');
  assert.equal(byThread.thread_B.from, 'other');
  assert.equal(byThread.thread_C, undefined, 'a thread with nothing of theirs is not a waiting message');
  assert.ok(rows.every((r) => r.from !== 'me'), 'no row is from me');
});

test('handles keep their dashes: GitHub logins allow them', () => {
  const h = require('../protocol/handle');
  assert.equal(h.canonicalHandle('@Synth-Stan '), 'synth-stan');
  assert.equal(h.isCanonicalHandle('synth-stan'), true);
  assert.equal(h.sameHandle('synth-stan', '@SYNTH-STAN'), true);
  assert.equal(h.sameHandle('synth-stan', 'synth_stan'), false, 'dash and underscore are different people');
});
