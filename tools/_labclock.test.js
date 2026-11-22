'use strict';
// The lab's clock (labclock.js): a lab story's days are minutes apart, so a
// message from "yesterday" read as "4m ago". A lab run may shift what is
// SHOWN, against a loopback API only; nothing it decides by time moves.
const test = require('node:test');
const assert = require('node:assert/strict');

const labclock = require('../labclock');
const H = 60 * 60 * 1000;
const LOCAL = { VIBE_API_URL: 'http://127.0.0.1:9' };
const PROD = { VIBE_API_URL: 'https://www.slashvibe.dev' };

function withEnv(t, vars) {
  const keys = ['VIBE_API_URL', 'VIBE_LAB_CLOCK_OFFSET_HOURS', 'VIBE_LAB_DAY_STARTS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
}

test('off unless the offset is set and valid AND the API is loopback', () => {
  const real = 1_700_000_000_000;
  assert.equal(labclock.now(real, { ...LOCAL }), real);
  assert.equal(labclock.now(real, { ...LOCAL, VIBE_LAB_CLOCK_OFFSET_HOURS: '24' }), real + 24 * H);
  assert.equal(labclock.now(real, { VIBE_API_URL: 'http://localhost:4000', VIBE_LAB_CLOCK_OFFSET_HOURS: '48' }), real + 48 * H);
  assert.equal(labclock.now(real, { VIBE_API_URL: 'http://[::1]:4000', VIBE_LAB_CLOCK_OFFSET_HOURS: '24' }), real + 24 * H);
  // A real account always has the real clock.
  assert.equal(labclock.now(real, { ...PROD, VIBE_LAB_CLOCK_OFFSET_HOURS: '24' }), real);
  assert.equal(labclock.now(real, { VIBE_API_URL: 'http://127.0.0.1.evil.dev/', VIBE_LAB_CLOCK_OFFSET_HOURS: '24' }), real);
  assert.equal(labclock.at(real, { ...PROD, VIBE_LAB_CLOCK_OFFSET_HOURS: '24', VIBE_LAB_DAY_STARTS: `2:${real - 1}` }), real);
  for (const bad of ['', ' ', '-1', 'abc', 'Infinity', String(24 * 400)]) {
    assert.equal(labclock.now(real, { ...LOCAL, VIBE_LAB_CLOCK_OFFSET_HOURS: bad }), real, `offset ${JSON.stringify(bad)} was honoured`);
  }
});

test('a timestamp moves to its lab day; before the first start it stays', () => {
  const t1 = 1_700_000_000_000; const t2 = t1 + 5 * 60 * 1000; const t3 = t2 + 7 * 60 * 1000;
  const env = { ...LOCAL, VIBE_LAB_CLOCK_OFFSET_HOURS: '48', VIBE_LAB_DAY_STARTS: `3:${t3},1:${t1},2:${t2},junk,9:x` };
  assert.deepEqual(labclock.dayStarts(env).map((s) => s.day), [1, 2, 3]);
  assert.equal(labclock.at(t1 - 1000, env), t1 - 1000, 'setup, before day 1');
  assert.equal(labclock.at(t1 + 1000, env), t1 + 1000, 'day 1');
  assert.equal(labclock.at(t2 + 1000, env), t2 + 1000 + 24 * H, 'day 2');
  assert.equal(labclock.at(t3 + 1000, env), t3 + 1000 + 48 * H, 'day 3');
  // Age as shown on day 3, a minute into it.
  const realNow = t3 + 60 * 1000;
  const shownAge = (ts) => labclock.now(realNow, env) - labclock.at(ts, env);
  assert.equal(shownAge(t3 + 30 * 1000), 30 * 1000, "today's stays seconds old");
  assert.ok(Math.abs(shownAge(t2 + 1000) - 24 * H) < 10 * 60 * 1000, "yesterday's reads a day old");
  assert.ok(Math.abs(shownAge(t1 + 1000) - 48 * H) < 15 * 60 * 1000);
  assert.equal(labclock.at('x', env), 'x');
  assert.equal(labclock.at(undefined, env), undefined);
});

test('formatTimeAgo: yesterday reads 1d ago in a lab day 2, and never on a real account', (t) => {
  const store = require('../store/api');
  const dayStart1 = Date.now() - 10 * 60 * 1000;
  const dayStart2 = Date.now() - 60 * 1000;
  const yesterday = dayStart1 + 60 * 1000;   // really 9 minutes ago
  const today = Date.now() - 20 * 1000;
  withEnv(t, { ...LOCAL });
  assert.equal(store.formatTimeAgo(yesterday), '9m ago');
  process.env.VIBE_LAB_CLOCK_OFFSET_HOURS = '24';
  process.env.VIBE_LAB_DAY_STARTS = `1:${dayStart1},2:${dayStart2}`;
  assert.equal(store.formatTimeAgo(yesterday), '1d ago');
  assert.equal(store.formatTimeAgo(today), 'just now');
  assert.equal(require('../store/local').formatTimeAgo(yesterday), '1d ago');
  process.env.VIBE_API_URL = PROD.VIBE_API_URL;
  assert.equal(store.formatTimeAgo(yesterday), '9m ago');
});

test('the session-start "since", people\'s "today", unsent\'s "last shown" and "they wrote last · Nd" follow it', (t) => {
  const hook = require('../session-start-hook.cjs');
  const unsent = require('../unsent');
  const arrival = require('../arrival');
  // A fixed noon, so a calendar day boundary never falls inside the test.
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const realNow = noon.getTime();
  const dayStart1 = realNow - 10 * 60 * 1000;
  const dayStart2 = realNow - 60 * 1000;
  const yesterday = dayStart1 + 60 * 1000;
  withEnv(t, { ...LOCAL });
  assert.equal(hook.sinceWhen(yesterday, realNow), 'earlier today');
  assert.equal(unsent.ago(yesterday, realNow), '9 minutes ago');
  process.env.VIBE_LAB_CLOCK_OFFSET_HOURS = '24';
  process.env.VIBE_LAB_DAY_STARTS = `1:${dayStart1},2:${dayStart2}`;
  assert.equal(hook.sinceWhen(yesterday, realNow), 'yesterday');
  assert.equal(hook.waitingCount([{ seen: true, at: yesterday }], realNow), '1 message still waiting since yesterday');
  assert.equal(unsent.ago(yesterday, realNow), '24 hours ago');
  // Which conversations count as "they wrote last" stays on the real clock (a
  // day's age); only the number shown moves.
  const threads = [{ handle: 'kenji', lastFrom: 'kenji', lastTimestamp: Date.now() - 25 * H, unread: 0 }];
  assert.equal(arrival.wroteLast(threads, 'ada')[0].days, 2);
  assert.equal(arrival.wroteLast([{ ...threads[0], lastTimestamp: yesterday }], 'ada').length, 0, 'a decision moved with the display clock');
  process.env.VIBE_API_URL = PROD.VIBE_API_URL;
  assert.equal(hook.sinceWhen(yesterday, realNow), 'earlier today');
  assert.equal(arrival.wroteLast(threads, 'ada')[0].days, 1);
});
