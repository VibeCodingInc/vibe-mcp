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
  // LONG thread (120 messages): their newest sits at the tail; the API pages oldest-first
  long_mine_last: { id: 'thread_D', with: 'longtalker', unread: 1, message_count: 120, last_message: { id: 'L120', from: 'me', body: 'ok', created_at: '2026-09-02T23:00:00Z' } },
};
const longThread = Array.from({ length: 120 }, (_, i) => ({ id: `L${i + 1}`, from: i === 118 ? 'longtalker' : 'me', body: i === 118 ? 'the newest thing they said' : `mine ${i + 1}`, created_at: `2026-09-02T${String(Math.floor(i / 5)).padStart(2, '0')}:${String((i % 5) * 10).padStart(2, '0')}:00Z` }));
longThread[3] = { id: 'L4', from: 'longtalker', body: 'an OLD message of theirs', created_at: '2026-09-02T00:30:00Z' };
const threadById = { thread_A: 'them', thread_C: 'ghost', thread_D: 'longtalker' };
const threadMessages = {
  longtalker: longThread,
  them: [ { id: 'm1', from: 'me', body: 'hi', created_at: '2026-09-02T22:00:00Z' }, { id: 'm2', from: 'them', body: 'what are you building?', created_at: '2026-09-02T22:04:00Z' }, { id: 'm3', from: 'me', body: 'my reply', created_at: '2026-09-02T22:14:00Z' } ],
  ghost: [ { id: 'm5', from: 'me', body: 'ping', created_at: '2026-09-02T21:00:00Z' } ],
};

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    const m = u.pathname.match(/^\/api\/v2\/threads\/(thread_[A-Z])$/);
    if (m) { // pages OLDEST-first, like production
      const all = threadMessages[threadById[m[1]]] || [];
      const limit = Number(u.searchParams.get('limit') || 50), offset = Number(u.searchParams.get('offset') || 0);
      return res.end(JSON.stringify({ thread_id: m[1], messages: all.slice(offset, offset + limit) }));
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
  assert.equal(byThread.thread_D.text, 'the newest thing they said', 'a long thread reads its TAIL, not its first page');
  assert.ok(rows.every((r) => r.from !== 'me'), 'no row is from me');
});

test('handles keep their dashes: GitHub logins allow them', () => {
  const h = require('../protocol/handle');
  assert.equal(h.canonicalHandle('@Synth-Stan '), 'synth-stan');
  assert.equal(h.isCanonicalHandle('synth-stan'), true);
  assert.equal(h.sameHandle('synth-stan', '@SYNTH-STAN'), true);
  assert.equal(h.sameHandle('synth-stan', 'synth_stan'), false, 'dash and underscore are different people');
});
