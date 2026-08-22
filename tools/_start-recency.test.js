/**
 * vibe_start's green claims pass the SAME recency gate as who and dm (#9.1).
 *
 * getActiveUsers returns active+away merged. vibe_start used to render that
 * whole union under "🟢 N online" / "🟢 Online now:", so a handle whose last
 * heartbeat was 25 minutes ago rendered as live. Green means a recent
 * confirmed heartbeat — one definition (isHereNow in _shared.js), every
 * surface. Away rows render as ○ away, in words, never under green.
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

    assert.match(text, /🟢 1 online/, 'the card counts recent heartbeats only');
    assert.match(text, /🟢 Online now:[\s\S]*@fresh/, 'a fresh heartbeat is green');
    const greenSection = text.split('○')[0];
    assert.ok(!greenSection.includes('@stale'), 'a 25m-old heartbeat never sits under green');
    assert.ok(!greenSection.includes('@resting'), 'an away row never sits under green');
    assert.match(text, /○ 2 away/, 'non-green rows are said in words, not hidden');
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
    assert.match(text, /🟢 0 online/, 'no recent heartbeat, no green count');
    assert.ok(!text.includes('🟢 Online now:'), 'no green list without a live row');
    assert.match(text, /○ 2 away/);
  } finally {
    t.restore();
  }
});

test('enriched onlineUsers carries the hereNow verdict per row', async () => {
  const t = toolWith('start', { ...QUIET, getActiveUsers: async () => ROOM });
  try {
    const res = await t.run({});
    const byHandle = Object.fromEntries(
      (res.onlineUsers ?? []).map((u) => [u.handle, u.hereNow])
    );
    assert.equal(byHandle.fresh, true);
    assert.equal(byHandle.stale, false);
    assert.equal(byHandle.resting, false);
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
