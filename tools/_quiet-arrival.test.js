'use strict';
// How a message reaches the other person (notice.js quietArrival), said in
// the preview so asking does not feel like an interruption (lab 2026-11-21,
// BRIEF-13 #1). It must say only what the code does (review SF-1): their
// session shows a message mid-work only from someone they know (presence.js
// knows), so "at their next pause" only when this person's records show they
// have written here (a message of theirs, or an open line); a first contact
// waits and a new session says at most that someone is waiting; anything not
// known is worded to be true either way. VIBE_NOTICE_OFF=quietArrival removes
// it, on a loopback API only.
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
fs.writeFileSync(path.join(HOME, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: { linus: 1, kenji: 1, mira: 1, nora: 1 } }));

const store = require('../store');
const drafts = require('./drafts');
let users = [];
let readOk = true;
store.getActiveUsers = async () => users;
store.getActiveUsersResult = async () => (readOk ? { ok: true, users } : { ok: false, users: [] });
// The conversation, served here: never the network.
const theyWrote = (h) => [{ id: `m_${h}1`, from: 'ada', body: 'q', timestamp: Date.now() - 3600e3 }, { id: `m_${h}2`, from: h, body: 'a', timestamp: Date.now() - 1800e3 }];
let threads = { linus: theyWrote('linus'), kenji: theyWrote('kenji'), mira: theyWrote('mira'), nora: [{ id: 'm_n1', from: 'ada', body: 'only mine', timestamp: Date.now() - 3600e3 }] };
store.getThreadBounded = async (me, them) => {
  const t = threads[them];
  if (t === 'fail') { const e = []; Object.defineProperty(e, 'readFailed', { value: true }); return e; }
  return t || [];
};

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const HERE = '**How it reaches them:** @linus is in a session now and has written to you or shares an open line with you, so it can show there at their next pause (a prompt or a tool step), never over what they are typing.';
const GONE = '**How it reaches them:** @kenji does not show as in a session now; it waits for them, unread, and their next session or pause can show it, never over what they are typing.';
const KNOWN_NO_PRESENCE = '**How it reaches them:** it waits for them, unread, and their next session or pause can show it, never over what they are typing.';
const FIRST = '**How it reaches them:** it waits for them, unread, until they open it. Unless they have written to you or invited you, their session does not show it mid-work, and a new session tells them at most that someone they have not written to is waiting, not who or what.';
const UNKNOWN = '**How it reaches them:** it waits for them, unread, until they open it; if they have written to you before, their session can show it sooner, at a pause, never over what they are typing.';
const PAUSE = /at their next pause/;

async function prepare(handle) {
  const r = await drafts.vibe_prepare.handler({ handle, message: 'Checked the retry queue and the 3 rps limit; is the burst cap 6 or 10?' });
  return r.display;
}

test('known (a message of theirs in the conversation) and in a session now: it can show at their next pause', async () => {
  users = [{ handle: 'linus', status: 'active', lastSeen: Date.now() }];
  readOk = true;
  const shown = await prepare('linus');
  assert.ok(shown.includes(`${HERE}\n`), shown);
  assert.ok(shown.includes('**To:** @linus (here now)'));
  // Under the message, above the choices.
  assert.ok(shown.indexOf('**Message (exact):**') < shown.indexOf(HERE));
  assert.ok(shown.indexOf(HERE) < shown.indexOf('Send to @linus · Edit · Cancel'));
  assert.ok(!/ring|notif|buzz|phone|pop/i.test(HERE), 'claims something about other apps');
  // An edit keeps what the first read found, without reading again.
  const id = (await drafts.vibe_prepare.handler({ handle: 'linus', message: 'one' })).data.draft.id;
  assert.ok((await drafts.vibe_prepare.handler({ id, message: 'two' })).display.includes(HERE));
});

test('known, not shown as in a session (gone, stale, away, missing): it waits', async () => {
  readOk = true;
  for (const u of [
    { handle: 'kenji', status: 'active', lastSeen: Date.now() - 11 * 60 * 1000 },
    { handle: 'kenji', status: 'away', lastSeen: Date.now() },
  ]) {
    users = [u];
    const shown = await prepare('kenji');
    assert.ok(shown.includes(`${GONE}\n`), shown);
    assert.ok(!PAUSE.test(shown));
  }
  users = [];
  assert.ok((await prepare('kenji')).includes(KNOWN_NO_PRESENCE), 'someone missing from the presence list');
});

test('presence could not be read: no claim about where they are', async () => {
  readOk = false;
  const shown = await prepare('mira');
  assert.ok(shown.includes(`${KNOWN_NO_PRESENCE}\n`), shown);
  assert.ok(!shown.includes('@mira does not show') && !PAUSE.test(shown));
  readOk = true;
});

test('first contact: never the pause form, even when they are in a session, and never under the Check line', async () => {
  users = [{ handle: 'zoe', status: 'active', lastSeen: Date.now() }];
  const shown = await prepare('zoe');
  assert.ok(shown.includes(`${FIRST}\n`), shown);
  assert.ok(shown.includes('**Check:** you have not written to @zoe before'));
  assert.ok(!PAUSE.test(shown), shown);
});

test('unknown: in a session, but no message of theirs (or the conversation could not be read): worded to be true either way', async () => {
  users = [{ handle: 'nora', status: 'active', lastSeen: Date.now() }];
  const mineOnly = await prepare('nora');
  assert.ok(mineOnly.includes(`${UNKNOWN}\n`), mineOnly);
  assert.ok(!PAUSE.test(mineOnly));
  threads.nora = 'fail';
  const failed = await prepare('nora');
  assert.ok(failed.includes(`${UNKNOWN}\n`), failed);
  assert.ok(!PAUSE.test(failed));
  // An open line is known from the person's own lines file, whatever the read says.
  const line = require('../line');
  line.open('nora');
  try {
    assert.ok((await prepare('nora')).includes('@nora is in a session now and has written to you or shares an open line with you, so it can show there at their next pause'));
  } finally { line.close('nora'); }
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
  // A real account always gets it (only the switch is asked; nothing is called).
  process.env.VIBE_API_URL = 'https://www.slashvibe.dev';
  process.env.VIBE_NOTICE_OFF = 'quietArrival';
  assert.equal(require('../notice').on('quietArrival'), true);
});
