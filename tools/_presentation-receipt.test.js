'use strict';

// The Terminal first-presentation boundary (#309): a fetch is only bytes;
// the receipt fires after the exact tool/hook output crosses stdout.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const store = require('../store');
const patterns = require('../intelligence/patterns');
const {
  attachPresentationIds,
  getPresentationIds,
  incomingPresentationIds,
  renderAmbientPresentation,
  writeResponseWithPresentation,
} = require('../presentation');
const { renderIncoming } = require('../incoming');
const hook = require('../session-start-hook.cjs');

test('named-thread fetch carries incoming ids but writes no receipt until stdout presentation', async () => {
  const originals = {
    isInitialized: config.isInitialized,
    getHandle: config.getHandle,
    getThread: store.getThread,
    markThreadRead: store.markThreadRead,
    markMessagesDelivered: store.markMessagesDelivered,
    logMessageReceived: patterns.logMessageReceived,
  };
  const markerCalls = [];
  const thread = [
    { id: 'm_own', from: 'ada', body: 'question', timestamp: Date.now() - 2 },
    { id: 'm_incoming', from: 'juno', body: 'answer', timestamp: Date.now() - 1 },
  ];
  thread._threadId = 'thread_ada_juno';
  thread._lastMessageId = 'm_incoming';

  try {
    config.isInitialized = () => true;
    config.getHandle = () => 'ada';
    store.getThread = async () => thread;
    store.markThreadRead = async () => {};
    store.markMessagesDelivered = async (ids) => { markerCalls.push(ids); };
    patterns.logMessageReceived = () => {};

    delete require.cache[require.resolve('./inbox.js')];
    const { handler } = require('./inbox.js');
    const result = await handler({ handle: 'juno' });

    assert.deepEqual(getPresentationIds(result), ['m_incoming']);
    assert.deepEqual(markerCalls, [], 'fetch + result construction are not presentation');

    const response = attachPresentationIds(
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: result.display }] } },
      getPresentationIds(result)
    );
    const writes = [];
    const stream = {
      write(payload, flushed) {
        writes.push(payload);
        assert.deepEqual(markerCalls, [], 'receipt cannot precede the stdout boundary');
        flushed();
        return true;
      },
    };
    writeResponseWithPresentation(stream, response, store.markMessagesDelivered);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].includes('presentationMessageIds'), false,
      'internal receipt metadata must not enter MCP/model context');
    assert.deepEqual(markerCalls, [['m_incoming']]);
  } finally {
    Object.assign(config, {
      isInitialized: originals.isInitialized,
      getHandle: originals.getHandle,
    });
    Object.assign(store, {
      getThread: originals.getThread,
      markThreadRead: originals.markThreadRead,
      markMessagesDelivered: originals.markMessagesDelivered,
    });
    patterns.logMessageReceived = originals.logMessageReceived;
    delete require.cache[require.resolve('./inbox.js')];
  }
});

test('bare API fetch never manufactures a first-presentation POST', async () => {
  const requests = [];
  const request = async (method, url, body) => {
    requests.push({ method, url, body });
    return {
      success: true,
      thread_id: 'thread_ada_juno',
      messages: [{ id: 'm_incoming', from: 'juno', body: 'answer', created_at: new Date().toISOString() }],
    };
  };

  const rows = await require('../store/api.js')._testing.getThreadWithRequest(request, 'ada', 'juno');
  assert.equal(rows.length, 1);
  assert.deepEqual(requests, [{
    method: 'GET',
    url: '/api/messages?user=ada&with=juno&limit=200',
    body: null,
  }]);
  assert.equal(requests.some((call) => /delivered/.test(call.url)), false);
});

test('SessionStart orders model-context output before its detached presentation receipt', () => {
  const events = [];
  const messages = [{ id: 'm_start', from: 'juno', text: 'waiting thought' }];
  hook.presentLiveMessages(
    messages,
    () => events.push('write-context'),
    (rows) => {
      events.push(`receipt:${incomingPresentationIds(rows).join(',')}`);
    }
  );
  assert.deepEqual(events, ['write-context', 'receipt:m_start']);
});

test('ambient presentation receipts only the DM previews that entered model context', () => {
  const out = renderAmbientPresentation(
    '\nbase',
    [{ from: 'guest', message: 'session-only note' }],
    [
      { handle: 'juno', lastMessageId: 'm_juno', lastMessage: 'one', unread: 1 },
      { handle: 'maya', lastMessageId: 'm_maya', lastMessage: 'two', unread: 3 },
    ],
    renderIncoming
  );
  assert.match(out.text, /session-only note/);
  assert.match(out.text, /one/);
  assert.match(out.text, /two \(\+2 more unread\)/);
  assert.deepEqual(out.presentationIds, ['m_juno', 'm_maya']);
  assert.equal(out.presentationIds.includes('guest'), false,
    'session guest text has no durable DM id and cannot manufacture a receipt');
});

test('a synchronous receipt failure cannot undo presentation', () => {
  const response = attachPresentationIds({ jsonrpc: '2.0', id: 1, result: {} }, ['m_1']);
  let written = '';
  const stream = {
    write(payload, flushed) {
      written = payload;
      flushed();
      return true;
    },
  };

  assert.doesNotThrow(() => writeResponseWithPresentation(stream, response, () => {
    throw new Error('local store has no receipt writer');
  }));
  assert.deepEqual(JSON.parse(written).result, {});
});
