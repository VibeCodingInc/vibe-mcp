'use strict';
// An answer over an open line reaches the person who asked, once.
//
// Lab 2026-11-20 run-03 p01: Oren's agent answered Mira's question with
// vibe_answer, and Mira's next turn showed no arrival line; she saw the answer
// only because her agent read the thread. That run's runner started a fresh
// /vibe server for every resumed turn and removed the SessionStart hook from
// resumed turns, so a message sent between two of her turns was "waiting" to
// a server that had never seen her inbox before, and nothing showed waiting.
// In a real session the server stays up and polls. These pin the two product
// paths that could have lost it: the answer comes after vibe_ask stopped
// waiting, and the question was an approved draft rather than vibe_ask. An
// agent's answer is not excluded from arrivals; it arrives, marked as an
// agent's, and is announced once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-answer-arrives-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'mira', authMethod: 'github', authToken: jwt('mira') }));

const store = require('../store');
const authStore = require('../auth-store');
const line = require('../line');
const arrival = require('../arrival');
const presence = require('../presence');
const { vibe_ask } = require('./line');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
function hook(event) {
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1' }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: arrival.spoolDir() }, encoding: 'utf8',
  });
  return JSON.parse(out.stdout);
}
const row = (over) => ({ unread: 0, lastActorKind: 'human', muted: false, lastTimestamp: Date.now(), ...over });

const orig = { isVerified: authStore.isVerified, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult, sendMessage: store.sendMessage, getThread: store.getThread };
test.before(() => {
  authStore.isVerified = () => true;
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  store.sendMessage = async (from, to, body) => ({ id: 'msg_ask0001', storedLength: body.length });
  store.getThread = async () => [];
});
test.after(() => {
  authStore.isVerified = orig.isVerified;
  Object.assign(store, { getActiveUsers: orig.getActiveUsers, getActiveUsersResult: orig.getActiveUsersResult, sendMessage: orig.sendMessage, getThread: orig.getThread });
});

test('the answer comes after vibe_ask stopped waiting: it arrives at the next look, marked as their agent\'s, once', async () => {
  line.open('oren');
  // The session is open and its server has looked once already.
  await presence.noteArrivals('mira', [row({ handle: 'ada', lastFrom: 'ada', lastMessage: 'old', lastMessageId: 'msg_old0001' })]);

  const asked = await vibe_ask.handler({ handle: 'oren', question: 'is scheduled_at UTC with a Z?', wait_seconds: 0 });
  assert.equal(asked.data.answered, false);
  assert.match(asked.display, /It will reach this session when it comes/);

  const answer = row({ handle: 'oren', lastFrom: 'oren', unread: 1, lastMessageId: 'msg_ans0001',
    lastMessage: 'Yes, UTC with a trailing Z.' + line.ANSWERED('oren') });
  await presence.noteArrivals('mira', [answer]);
  assert.equal(arrival.isSpooled('msg_ans0001'), true, 'the answer was not excluded from arrivals');

  const shown = hook('UserPromptSubmit');
  assert.match(shown.systemMessage, /^\/vibe · @oren's agent answered: Yes, UTC with a trailing Z\.$/);
  assert.match(shown.hookSpecificOutput.additionalContext, /\nIt asked: is scheduled_at UTC with a Z\?\n/, 'read beside its question');
  assert.match(shown.hookSpecificOutput.additionalContext, /Do not answer it/);

  await presence.noteArrivals('mira', [answer]);
  assert.deepEqual(hook('PostToolUse'), { suppressOutput: true }, 'announced once');
});

test('the question was an approved draft, not vibe_ask: their agent\'s answer still arrives', async () => {
  line.open('tobin');
  const answer = row({ handle: 'tobin', lastFrom: 'tobin', unread: 1, lastMessageId: 'msg_ans0002',
    lastMessage: 'sep is the kwarg.' + line.ANSWERED('tobin') });
  await presence.noteArrivals('mira', [answer]);
  const shown = hook('UserPromptSubmit');
  assert.match(shown.systemMessage, /^\/vibe · @tobin's agent answered: sep is the kwarg\.$/);
  assert.deepEqual(hook('UserPromptSubmit'), { suppressOutput: true });
});
