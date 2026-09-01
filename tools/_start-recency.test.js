/**
 * vibe_start's green claims pass the SAME recency gate as who and dm (#9.1).
 *
 * getActiveUsers returns active+away merged. vibe_start used to render that
 * whole union as live, so a handle whose last heartbeat was 25 minutes ago
 * counted as present. One definition of present — isHereNow in _shared.js —
 * on every surface.
 *
 * The first screen no longer lists people at all (2026-08-31: no presence
 * roster, no chosen person, no message bodies), so the claim under test is
 * now the COUNT: "N here" must count recent heartbeats only, and the screen
 * must not name anyone it has not been asked about.
 *
 * Run: node --test tools/_start-recency.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-start-recency-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  one_liner: 'recency gate',
}));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// No test may leave this process and touch the real network.
global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const mins = (n) => Date.now() - n * 60_000;

function toolWith(name, stubs) {
  const originals = {};
  // start reads the presence OUTCOME; a stubbed roster means "the server
  // answered with this", not "the read failed".
  if (stubs.getActiveUsers && !stubs.getActiveUsersResult) {
    stubs = { ...stubs, getActiveUsersResult: async () => ({ ok: true, users: await stubs.getActiveUsers() }) };
  }
  for (const [k, v] of Object.entries(stubs)) {
    originals[k] = store[k];
    store[k] = v;
  }
  const toolPath = require.resolve(`./${name}.js`);
  delete require.cache[toolPath];
  const tool = require(toolPath);
  return {
    run: (args = {}) => tool.handler(args),
    restore: () => {
      for (const [k, v] of Object.entries(originals)) store[k] = v;
      delete require.cache[toolPath];
    },
  };
}

const QUIET = {
  getUnreadCount: async () => 0,
  getInbox: async () => [],
  getRawInbox: async () => [],
  getThread: async () => [],
  markThreadRead: async () => {},
  sendTypingIndicator: async () => {},
  getTypingUsers: async () => [],
  heartbeat: async () => ({ ok: true }),
};

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// One fresh heartbeat, one row the server still files as "active" but stale,
// one properly away row. Only the first may render green.
const ROOM = [
  { handle: 'fresh', status: 'active', lastSeen: mins(2), one_liner: 'shipping' },
  { handle: 'stale', status: 'active', lastSeen: mins(25), one_liner: 'gone quiet' },
  { handle: 'resting', status: 'away', lastSeen: mins(3), one_liner: 'afk' },
];

test('green count and green list are gated on isHereNow, not the merged union', async () => {
  const t = toolWith('start', { ...QUIET, getActiveUsers: async () => ROOM });
  try {
    const res = await t.run({});
    const text = res.display;

    assert.match(text, /\b1 other here\b/, 'the count includes recent heartbeats only, and excludes you');
    const greenSection = text.split('○')[0];
    assert.ok(!text.includes('@stale'), 'a 25m-old heartbeat is not counted or named');
    assert.ok(!text.includes('@resting'), 'an away row is not counted or named');
    assert.ok(!text.includes('@fresh'), 'the first screen names nobody it was not asked about');
  } finally {
    t.restore();
  }
});

test('a room of only stale rows renders zero green, not a live room', async () => {
  const t = toolWith('start', {
    ...QUIET,
    getActiveUsers: async () => ROOM.filter((u) => u.handle !== 'fresh'),
  });
  try {
    const res = await t.run({});
    const text = res.display;
    assert.match(text, /\b0 others here\b/, 'no recent heartbeat, no one counted as here');
    assert.ok(!/@\w+ \(/.test(text.split('vibe inbox')[0]), 'no roster rendered');
  } finally {
    t.restore();
  }
});

// The enriched roster was REMOVED from vibe_start (2026-08-31): shipping a
// list of unrequested people in the payload defeats the screen's own rule,
// and vibe_who is the tool that answers "who is around". What survives of
// this pin is the invariant that mattered — the isHereNow verdict decides the
// count, and no unrequested person is named anywhere in the result.
test('no roster ships from the first screen; the recency gate decides the count', async () => {
  const t = toolWith('start', { ...QUIET, getActiveUsers: async () => ROOM });
  try {
    const res = await t.run({});
    assert.equal(res.onlineUsers, undefined, 'no roster in the payload');
    const all = JSON.stringify(res);
    for (const h of ['fresh', 'stale', 'resting']) {
      assert.ok(!all.includes(`"${h}"`), `@${h} is not named in the result`);
    }
    assert.equal(res.here, 1, 'exactly the one recent heartbeat is counted');
  } finally {
    t.restore();
  }
});

// ── The AMBIENT escapes make the same claim outside the transcript (#9.1
// review): the terminal title says "N online" and the iTerm badge renders
// ●N. index.js used to feed them the raw active+away union, so a
// stale/away-only room still put "2 online" in the title bar after the
// card was fixed. ambientEscapes gates internally — no caller can feed it
// an ungated count.

test('a stale-only room produces a quiet title and empty badge, never an online claim', () => {
  const { ambientEscapes } = require('../ambient-escapes.js');
  const escapes = ambientEscapes(
    [
      { handle: 'stale', status: 'active', lastSeen: mins(25) },
      { handle: 'resting', status: 'away', lastSeen: mins(3) },
    ],
    0
  );
  assert.ok(!escapes.includes('online'), 'no "N online" title from a stale-only room');
  const badge = Buffer.from('○').toString('base64');
  assert.ok(escapes.includes(`SetBadgeFormat=${badge}`), 'the badge is the empty ring, not ●N');
});

test('the title and badge count only recent heartbeats, and lastActivity names one', () => {
  const { ambientEscapes } = require('../ambient-escapes.js');
  const escapes = ambientEscapes(
    [
      { handle: 'fresh', status: 'active', lastSeen: mins(2) },
      { handle: 'stale', status: 'active', lastSeen: mins(25) },
    ],
    0
  );
  assert.ok(escapes.includes('1 online'), 'one recent heartbeat, one online');
  assert.ok(escapes.includes('@fresh'), 'lastActivity names the here-now handle');
  const badge = Buffer.from('●1').toString('base64');
  assert.ok(escapes.includes(`SetBadgeFormat=${badge}`), 'badge counts hereNow only');
});

test('ambient-escapes exports ONLY the gated entry point — no bypass surface', () => {
  const mod = require('../ambient-escapes.js');
  assert.deepEqual(Object.keys(mod), ['ambientEscapes'],
    'exporting the raw formatters would hand callers an ungated online claim');
});
