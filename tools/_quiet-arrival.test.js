'use strict';
// How a message reaches the other person (notice.js quietArrival), said in
// the preview so asking does not feel like an interruption (lab 2026-11-21,
// BRIEF-13 #1). It must say only what the code does: in a session, at the
// next prompt or tool step (hooks/arrival-hook.cjs), never over what they type;
// not shown as in a session, it waits and their next session tells them.
// VIBE_NOTICE_OFF=quietArrival removes it, on a loopback API only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-quiet-arrival-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
delete process.env.VIBE_NOTICE_VARIANT;
delete process.env.VIBE_NOTICE_OFF;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
fs.writeFileSync(path.join(HOME, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: { linus: 1, kenji: 1, mira: 1 } }));

const store = require('../store');
const drafts = require('./drafts');
let users = [];
let readOk = true;
store.getActiveUsers = async () => users;
store.getActiveUsersResult = async () => (readOk ? { ok: true, users } : { ok: false, users: [] });

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const HERE = '**How it reaches them:** @linus is in a session now; it shows there at their next pause (a prompt or a tool step), never over what they are typing.';
const GONE = '**How it reaches them:** @kenji does not show as in a session now; it waits for them, and they are told when they next open a session or pause in one, never over what they are typing.';
const UNKNOWN = '**How it reaches them:** it waits for them, and they are told when they next open a session or pause in one, never over what they are typing.';

async function prepare(handle) {
  const r = await drafts.vibe_prepare.handler({ handle, message: 'Checked the retry queue and the 3 rps limit; is the burst cap 6 or 10?' });
  return r.display;
}

test('in a session now: it shows at their next pause, never over what they are typing', async () => {
  users = [{ handle: 'linus', status: 'active', lastSeen: Date.now() }];
  readOk = true;
  const shown = await prepare('linus');
  assert.ok(shown.includes(`${HERE}\n`), shown);
  assert.ok(shown.includes('**To:** @linus (here now)'));
  // Under the message, above the choices.
  assert.ok(shown.indexOf('**Message (exact):**') < shown.indexOf(HERE));
  assert.ok(shown.indexOf(HERE) < shown.indexOf('Send to @linus · Edit · Cancel'));
  assert.ok(!/ring|notif|buzz|phone|pop/i.test(HERE), 'claims something about other apps');
});

test('not shown as in a session (gone, stale, away): it waits and they are told next time', async () => {
  readOk = true;
  for (const u of [
    { handle: 'kenji', status: 'active', lastSeen: Date.now() - 11 * 60 * 1000 },
    { handle: 'kenji', status: 'away', lastSeen: Date.now() },
  ]) {
    users = [u];
    const shown = await prepare('kenji');
    assert.ok(shown.includes(`${GONE}\n`), shown);
    assert.ok(!shown.includes('is in a session now'));
  }
  // Missing from the list: the preview already says "presence unknown", so no claim either way.
  users = [];
  assert.ok((await prepare('kenji')).includes(UNKNOWN), 'someone missing from the presence list');
});

test('presence could not be read: no claim about where they are', async () => {
  readOk = false;
  const shown = await prepare('mira');
  assert.ok(shown.includes(`${UNKNOWN}\n`), shown);
  assert.ok(!shown.includes('@mira does not show'));
  readOk = true;
});

test('VIBE_NOTICE_OFF=quietArrival removes the line, on a loopback API only; the rest of the preview is unchanged', async (t) => {
  t.after(() => { delete process.env.VIBE_NOTICE_OFF; delete process.env.VIBE_NOTICE_VARIANT; process.env.VIBE_API_URL = 'http://127.0.0.1:9'; });
  users = [{ handle: 'linus', status: 'active', lastSeen: Date.now() }];
  const on = await prepare('linus');
  process.env.VIBE_NOTICE_OFF = 'quietArrival';
  const off = await prepare('linus');
  assert.ok(!off.includes('How it reaches them'), off);
  const strip = (s) => s.replace(`${HERE}\n`, '').replace(/_\(draft [^)]*\)_/, '').replace(/\(draft w[0-9a-f]+\)/g, '');
  assert.equal(strip(off), strip(on));
  process.env.VIBE_NOTICE_OFF = 'showYourWork';
  assert.ok((await prepare('linus')).includes(HERE), 'another name turned this one off');
  delete process.env.VIBE_NOTICE_OFF;
  process.env.VIBE_NOTICE_VARIANT = 'off';
  assert.ok(!(await prepare('linus')).includes('How it reaches them'), 'VIBE_NOTICE_VARIANT=off left it on');
  // A real account always gets it.
  process.env.VIBE_API_URL = 'https://www.slashvibe.dev';
  process.env.VIBE_NOTICE_OFF = 'quietArrival';
  assert.equal(require('../notice').on('quietArrival'), true);
});
