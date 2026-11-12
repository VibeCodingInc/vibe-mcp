'use strict';
// Who may reach you while you work (reach.js). A stranger must not be able to
// interrupt a working session; quiet and mute must hold; and none of it may
// mark anything read or release a burst later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reach-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

const authStore = require('../auth-store');
const store = require('../store');
const reach = require('../reach');
const line = require('../line');
const arrival = require('../arrival');
const presence = require('../presence');

authStore.isVerified = () => true;
store.getActiveUsers = async () => [];
let threadReads = 0; let conversations = {}; let marked = 0;
store.getThread = async (me, them) => { threadReads++; return conversations[them] || []; };
store.markThreadRead = async () => { marked++; return { success: true }; };
const now = Date.now();
let n = 0;
const msg = (from) => ({ handle: from, unread: 1, lastMessage: `hello from ${from}`, lastMessageId: `msg_r${String(++n).padStart(4, '0')}`, lastFrom: from, lastTimestamp: now });

test('first look establishes what was already waiting', async () => {
  await presence.noteArrivals('ada', []);
});

test('a stranger does not reach you mid-work; the question is asked once, and nothing is marked read', async () => {
  const m = msg('stranger');
  await presence.noteArrivals('ada', [m]);
  await presence.noteArrivals('ada', [m]);
  assert.equal(arrival.isSpooled(m.lastMessageId), false);
  assert.equal(threadReads, 1, 'the conversation was checked once, not on every poll');
  assert.equal(marked, 0);
});

test('someone you wrote to from another device reaches you, and is remembered', async () => {
  conversations.stan = [{ from: 'ada', body: 'ship it?' }, { from: 'stan', body: 'yes' }];
  const m = msg('stan');
  await presence.noteArrivals('ada', [m]);
  assert.equal(arrival.isSpooled(m.lastMessageId), true);
  assert.equal(reach.isKnown('stan'), true);
  const before = threadReads;
  const m2 = msg('stan');
  await presence.noteArrivals('ada', [m2]);
  assert.equal(threadReads, before, 'no second lookup for a known person');
  assert.equal(arrival.isSpooled(m2.lastMessageId), true);
});

test('sending to someone is what lets their answer reach you', async () => {
  const orig = store.sendMessage;
  store.sendMessage = async (from, to, body) => ({ id: 'msg_out1', storedLength: body.length });
  try { await require('./deliver').deliver({ to: 'grace', message: 'hello' }); } finally { store.sendMessage = orig; }
  assert.equal(reach.isKnown('grace'), true);
  const before = threadReads; const m = msg('grace');
  await presence.noteArrivals('ada', [m]);
  assert.equal(arrival.isSpooled(m.lastMessageId), true);
  assert.equal(threadReads, before);
});

test('an open line counts as knowing them', async () => {
  line.open('ben');
  const m = msg('ben');
  await presence.noteArrivals('ada', [m]);
  assert.equal(arrival.isSpooled(m.lastMessageId), true);
});

test('a muted person never surfaces, and an open line with them is not answered', async () => {
  reach.mute('ben');
  const m = msg('ben');
  await presence.noteArrivals('ada', [m]);
  assert.equal(arrival.isSpooled(m.lastMessageId), false);
  arrival.record([msg('ben')], 'ada', {});
  const spooled = fs.readdirSync(arrival.spoolDir()).filter((f) => f.endsWith('.json')).pop().replace('.json', '');
  const r = await require('./line').vibe_answer.handler({ reply_to: spooled, message: 'here you go' });
  assert.match(r.display, /is muted on this machine/);
  assert.equal(reach.unmute('ben'), true);
});

test('quiet holds everything, and turning it off releases no burst', async () => {
  reach.setQuiet(true);
  const held = msg('stan');
  await presence.noteArrivals('ada', [held]);
  assert.equal(arrival.isSpooled(held.lastMessageId), false);
  reach.setQuiet(false);
  await presence.noteArrivals('ada', [held]);
  assert.equal(arrival.isSpooled(held.lastMessageId), false, 'what came in during quiet stays waiting');
  const next = msg('stan');
  await presence.noteArrivals('ada', [held, next]);
  assert.equal(arrival.isSpooled(next.lastMessageId), true, 'new messages arrive again');
});

test('reach state is local, private, and rejects a handle that is not one', () => {
  assert.throws(() => reach.mute('../../etc/passwd'), /not a handle/);
  assert.equal(fs.statSync(path.join(HOME, 'reach.json')).mode & 0o777, 0o600);
  const src = fs.readFileSync(path.join(__dirname, '..', 'reach.js'), 'utf8');
  assert.doesNotMatch(src, /fetch\(|https?:\/\/|require\('\.\/store'\)/, 'reach.js never talks to the network');
});

test('your line is set only from words given to vibe_start, and nothing is derived from the repository', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'start.js'), 'utf8');
  assert.doesNotMatch(src, /_work-context|gatherWithTimeout|recentCommits|branch:/);
  assert.equal(fs.existsSync(path.join(__dirname, '_work-context.js')), false);
  const beats = [];
  const orig = { heartbeat: store.heartbeat, getActiveUsersResult: store.getActiveUsersResult, getInboxResult: store.getInboxResult, getIdentityKind: store.getIdentityKind };
  store.heartbeat = async (h, l, ctx) => { beats.push([h, l, ctx]); return {}; };
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  store.getInboxResult = async () => ({ ok: true, threads: [] });
  store.getIdentityKind = async () => null;
  try {
    const start = require('./start');
    const none = await start.handler({});
    assert.match(none.display, /you have not said what you are working on/);
    assert.equal(beats.length, 0, 'no presence note is sent on its own');
    const set = await start.handler({ building: '  the scheduler lease  ' });
    assert.deepEqual(beats, [['ada', 'the scheduler lease', undefined]]);
    assert.match(set.display, /you say you are working on: "the scheduler lease"/);
    assert.equal(set.line, 'the scheduler lease');
  } finally { Object.assign(store, orig); }
});
