const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../store/api.js');

test('named thread read is one direct GET plus one read PATCH', async () => {
  const requests = [];
  const request = async (method, url, body) => {
    requests.push({ method, url, body });
    if (method === 'GET' && url === '/api/messages?user=ada&with=juno&limit=200') {
      return {
        success: true,
        thread_id: 'thread_ada_juno',
        last_message_id: 'message_latest',
        messages: [
          {
            id: 'message_first', from: 'ada', body: 'question',
            created_at: '2026-08-09T18:00:00.000Z', status: 'delivered',
          },
          {
            id: 'message_latest', from: 'juno', body: 'answer',
            created_at: '2026-08-09T18:01:00.000Z', status: 'presented',
            transport_attempted_at: '2026-08-09T18:00:30.000Z',
            first_presented_at: '2026-08-09T18:01:30.000Z',
          },
        ],
      };
    }
    if (method === 'PATCH' && url === '/api/v2/threads/thread_ada_juno/read') {
      return { success: true };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  const thread = await store._testing.getThreadWithRequest(request, 'ada', 'juno');
  await store._testing.markThreadReadWithRequest(
    request,
    'ada',
    'juno',
    thread._lastMessageId,
    thread._threadId
  );

  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/messages?user=ada&with=juno&limit=200', body: null },
    {
      method: 'PATCH',
      url: '/api/v2/threads/thread_ada_juno/read',
      body: { last_read_id: 'message_latest', client: 'terminal' },
    },
  ]);
  assert.equal(thread._threadId, 'thread_ada_juno');
  assert.equal(thread._lastMessageId, 'message_latest');
  assert.equal(thread[1].body, 'answer');
  assert.equal(thread[1].status, 'presented');
  assert.equal(thread[1].transportAttemptedAt, '2026-08-09T18:00:30.000Z');
  assert.equal(thread[1].firstPresentedAt, '2026-08-09T18:01:30.000Z');
  assert.equal(thread[0].status, null,
    'legacy delivered must not be laundered into the authoritative vocabulary');
});

test('a direct empty thread does not fall back to a list lookup', async () => {
  const requests = [];
  const request = async (method, url, body) => {
    requests.push({ method, url, body });
    return { success: true, thread_id: 'thread_empty', messages: [] };
  };

  const thread = await store._testing.getThreadWithRequest(request, 'ada', 'nobody');
  await store._testing.markThreadReadWithRequest(
    request,
    'ada',
    'nobody',
    thread._lastMessageId,
    thread._threadId
  );

  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/messages?user=ada&with=nobody&limit=200', body: null },
  ]);
  assert.equal(thread.length, 0);
  assert.equal(thread._threadId, 'thread_empty');
});
