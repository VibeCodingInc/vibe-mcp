'use strict';
// 2026-09-02 polling audit: ~7 inbox polls/sec at the KV came from every
// client reading session/guest (6 KV commands) + the threads list every 15s
// forever. The repair is a cadence, not a feature: fast while the person is
// active, slower when idle, snapped back by any tool call.
const test = require('node:test');
const assert = require('node:assert');
const presence = require('../presence');

test('active sessions keep the 15s DM check; idle sessions back off to 60s', () => {
  assert.equal(presence.cadenceFor(0).unread, 15_000);
  assert.equal(presence.cadenceFor(presence.ACTIVE_WINDOW_MS - 1).unread, 15_000);
  assert.equal(presence.cadenceFor(presence.ACTIVE_WINDOW_MS).unread, 60_000);
});

test('the guest-session poll is never faster than the DM check, and idles to 5 min', () => {
  assert.equal(presence.cadenceFor(0).guest, 60_000);
  assert.equal(presence.cadenceFor(presence.ACTIVE_WINDOW_MS).guest, 300_000);
  for (const idle of [0, presence.ACTIVE_WINDOW_MS]) {
    const c = presence.cadenceFor(idle);
    assert.ok(c.guest >= c.unread, 'guest poll must not outpace the DM check');
  }
});

test('worst-case DM notification latency is bounded: 15s active, 60s idle', () => {
  assert.equal(presence.CADENCE.active.unread, 15_000);
  assert.equal(presence.CADENCE.idle.unread, 60_000);
});

test('the dispatcher marks every tool call as activity', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const i = src.indexOf('presence.noteActivity()');
  const j = src.indexOf('const result = await tool.handler(args)');
  assert.ok(i > -1 && j > i, 'noteActivity() must run before tool.handler in tools/call');
});
