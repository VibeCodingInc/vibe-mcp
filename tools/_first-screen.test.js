/**
 * The first screen (vibe_start), after the 2026-08-31 terminal-experience
 * pass. Five defects were found in a real signed-in session; each is pinned
 * here at the claim it violated, not at the code that happened to produce it:
 *
 *   1. the same message was rendered twice in one response
 *   2. the header and the footer disagreed about the unread count
 *   3. "You haven't messaged anyone yet" was shown to someone with history
 *   4. a random online person was chosen and a canned DM drafted for them
 *   5. the useful actions were buried under presence, bodies, tips and footers
 *
 * Run: node --test tools/_first-screen.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-first-screen-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test } = require('node:test');
const assert = require('node:assert/strict');

global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const now = Date.now();
// isHereNow: status active AND a recent heartbeat (tools/_shared.js)
const here = (h) => ({ handle: h, status: 'active', lastSeen: now - 60_000, one_liner: 'x' });

const withStore = (stubs, fn) => async () => {
  const orig = {};
  const base = {
    getActiveUsers: async () => [],
    getInbox: async () => [],
    getUnreadCount: async () => 0,
    heartbeat: async () => ({}),
    registerSession: async () => ({}),
    getLiveBroadcastCount: async () => 0,
  };
  for (const [k, v] of Object.entries({ ...base, ...stubs })) { orig[k] = store[k]; store[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(orig)) store[k] = v; }
};

const run = async () => {
  delete require.cache[require.resolve('./start')];
  const start = require('./start');
  const res = await start.handler({});
  return res.display || '';
};

const INBOX = [
  { handle: 'coltrane', unread: 1, lastMessage: 'the receipt is in the thread', lastMessageId: 'msg_C1', thread_id: 't1' },
  { handle: 'synth-stan', unread: 3, lastMessage: 'round-trip confirmed from the Mac Studio', lastMessageId: 'msg_S9', thread_id: 't2' },
];

test('DEFECT 1 — no message body appears anywhere on the first screen', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => INBOX,
}, async () => {
  const text = await run();
  assert.ok(!text.includes('the receipt is in the thread'), 'no preview of an unread message');
  assert.ok(!text.includes('round-trip confirmed'), 'no preview of any unread message');
  assert.ok(!text.includes('<<<'), 'no foreign-message wrapper block');
  // the ids ARE shown — that is what makes an exact reply possible
  assert.match(text, /#msg_C1/);
  assert.match(text, /#msg_S9/);
}));

test('DEFECT 2 — the unread count is stated exactly once', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => INBOX,
}, async () => {
  const text = await run();
  const counts = text.match(/\b\d+ unread\b/g) || [];
  assert.equal(counts.length, 1, `unread stated ${counts.length} times: ${counts.join(', ')}`);
  assert.equal(counts[0], '4 unread', 'and it is the sum of the served threads');
}));

test('DEFECT 3 — no history claim is made about the person at all', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => INBOX,
}, async () => {
  const text = await run();
  assert.ok(!/haven't messaged anyone/i.test(text), 'never claims an empty history');
  assert.ok(!/first (message|dm)/i.test(text), 'never claims a first anything');
}));

test('DEFECT 4 — nobody is chosen for the person, and no DM is drafted', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai'), here('rune')],
  getInbox: async () => [],
}, async () => {
  const text = await run();
  for (const h of ['zoe', 'kai', 'rune']) {
    assert.ok(!text.includes(`@${h}`), `the screen must not name @${h} — the person chooses`);
  }
  assert.ok(!/vibe dm @(?!handle)/.test(text), 'no pre-filled recipient');
  assert.ok(!/"hey!|what are you building\?/.test(text), 'no canned opener drafted');
}));

test('DEFECT 4b — the same call twice gives the same screen (nothing rotates)', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai'), here('rune')],
  getInbox: async () => INBOX,
}, async () => {
  const a = await run();
  const b = await run();
  assert.equal(a, b, 'no random selection, no rotating tip — a stable first screen');
}));

test('DEFECT 5 — the actions are present, and the screen stays under 20 lines', withStore({
  getActiveUsers: async () => Array.from({ length: 12 }, (_, i) => here(`p${i}`)),
  getInbox: async () => [
    ...INBOX,
    ...Array.from({ length: 8 }, (_, i) => ({ handle: `x${i}`, unread: 2, lastMessage: 'y', lastMessageId: `msg_X${i}` })),
  ],
}, async () => {
  const text = await run();
  const lines = text.split('\n').length;
  assert.ok(lines < 20, `first screen is ${lines} lines; the budget is under 20`);
  assert.match(text, /vibe inbox · vibe people · vibe dm @handle/, 'the three actions are stated');
  assert.ok(text.trim().endsWith('"…"'), 'and they are the last thing read, not buried');
}));

test('a genuinely new arrival is pointed at whoever invited them — never a stranger', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => [],
}, async () => {
  const text = await run();
  assert.match(text, /whoever invited you/i);
  assert.ok(!text.includes('@zoe') && !text.includes('@kai'), 'no online stranger is offered instead');
}));

test('the screen names the person and the room, and nothing else', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => INBOX,
}, async () => {
  const text = await run();
  assert.match(text.split('\n')[0], /^\/vibe @ada$/, 'line 1: who you are');
  assert.match(text.split('\n')[1], /^4 unread · 2 here$/, 'line 2: what is waiting, and the room');
}));

test('DEFECT 2 (dispatcher half) — the first screen carries no ambient footer', () => {
  // The footer states unread a second time from a cached source and re-renders
  // message bodies; in a real session its count disagreed with the header.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('const SKIP_FOOTER_TOOLS'), src.indexOf('const SKIP_FOOTER_TOOLS') + 900);
  assert.ok(block.includes("'vibe_start'"), 'vibe_start is in SKIP_FOOTER_TOOLS');
});
