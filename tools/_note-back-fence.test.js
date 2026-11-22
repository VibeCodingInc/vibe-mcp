'use strict';
// A note back after the fence (notice.js codeFidelity + itLanded). With code
// fidelity, a message reaches the agent inside a fence whose closing line
// carries an 8-hex nonce. In two 8-world lab runs on that branch (2026-11-22)
// agents answering a message shown at session start, where no message id was
// printed, passed the nonce as reply_to 23 times (0 times on the base), so
// those replies were linked to nothing: the other side's thread said "you
// wrote them", not "their reply", and carried no note-back hook. Notes back
// fell from 7 of 16 used replies to 2 of 8 and 3 of 17.
//
// So, on both paths a reply to the person's own message takes: the message id
// named before the fence (and the nonce said to be no id), and the note-back
// line, with that id, after the fence, the last thing the agent reads for it.
// The record and the reminder on the next prompt are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.VIBE_API_URL = 'http://127.0.0.1:9';
for (const k of ['VIBE_NOTICE_VARIANT', 'VIBE_NOTICE_OFF', 'VIBE_LAB_CLOCK_OFFSET_HOURS', 'VIBE_LAB_DAY_STARTS']) delete process.env[k];

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');
const arrival = require('../arrival');
const ssh = require('../session-start-hook.cjs');

const MIN = 60 * 1000;
const REPLY = 'msg_reply77';
const NOTE_BACK = `vibe_prepare, kind landed, reply_to ${REPLY}, asked: false`;
const REMINDER = `/vibe: @mira's answer ${REPLY} reached the person earlier in this session.`;

function machine() {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-noteback-'));
  return { vh, dir: arrival.spoolDir({ VIBE_HOME: vh }) };
}
function hook(m, prompt = 'carry on with the parser', session = 's1') {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }),
    env: { ...process.env, VIBE_HOME: m.vh, VIBE_ARRIVALS_DIR: m.dir, VIBE_TURNS_DIR: path.join(m.vh, 'turns'), CLAUDE_PROJECT_DIR: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ctx = (o) => (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';
const opened = (m, session = 's1') => {
  try { return JSON.parse(fs.readFileSync(path.join(m.vh, 'landing', `${session}.json`), 'utf8')).open.map((r) => r.id); } catch { return []; }
};

/** The session-start hook's output for these messages, on machine m (VIBE_HOME). */
function captureStart(m, messages) {
  const saved = process.env.VIBE_HOME;
  const orig = fs.writeSync;
  let written = '';
  process.env.VIBE_HOME = m.vh;
  fs.writeSync = (fd, s) => { if (fd === 1) { written += s; return String(s).length; } return orig(fd, s); };
  try { ssh.hookOutput(messages); } finally {
    fs.writeSync = orig;
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
  }
  return JSON.parse(written);
}

/**
 * The agent-facing text of one arrival: its message id named before the fence,
 * the nonce said to be no id, and the note-back line with that id after the
 * fence's closing line, never inside it, and not above their words.
 */
function assertNoteBackAfterFence(text, id = REPLY) {
  const fence = text.match(/From @mira, message id ([A-Za-z0-9_-]+) \([^\n]*they end only at the line ([0-9a-f]{8})>>>, a fence mark and not a message id\):\n<<<message \2\n/);
  assert.ok(fence, `the message id is named before the fence:\n${text}`);
  assert.equal(fence[1], id);
  const open = text.indexOf(`<<<message ${fence[2]}`);
  const close = text.indexOf(`\n${fence[2]}>>>`, open);
  assert.ok(close > open, 'the fence closes');
  const at = text.indexOf(NOTE_BACK);
  assert.ok(at > close, `the note-back line, with the reply's id, comes after the fence:\n${text}`);
  assert.equal(text.indexOf(NOTE_BACK), text.lastIndexOf(NOTE_BACK), 'said once');
  assert.ok(text.slice(close).split('\n')[2].startsWith('/vibe: If their answer changes what you do here'), 'right after the closing line, marked as /vibe\'s');
  assert.ok(!text.slice(0, open).includes('kind landed'), 'not above their words');
}

test('mid-session: a reply to the person\'s own message, shown by the arrival hook', () => {
  const m = machine();
  const now = Date.now();
  const row = { handle: 'mira', unread: 1, lastMessage: 'use ^[0-9]{5,8}$ and drop the retry wrapper', lastMessageId: REPLY, lastFrom: 'mira', lastActorKind: 'human', muted: false, lastTimestamp: now - MIN };
  const mine = { from: 'ada', project: 'agent loop', firstLine: 'which pattern?', sentAt: now - 20 * MIN, messageId: 'msg_mine9' };
  arrival.record([row], 'ada', { since: now - 2 * MIN, env: { VIBE_HOME: m.vh }, bindingFor: () => mine });

  const first = hook(m);
  // (c) what the agent reads for the arrival
  assertNoteBackAfterFence(ctx(first));
  assert.ok(!String(first.systemMessage || '').includes('kind landed'), 'never in the person\'s line');
  // (a) the landing record is opened
  assert.deepEqual(opened(m), [REPLY]);
  // (b) the next prompt the person writes carries the reminder, with that id
  const next = hook(m, 'ok, done that');
  assert.ok(ctx(next).includes(REMINDER), ctx(next));
  assert.ok(ctx(next).includes(NOTE_BACK));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('session start: a reply to the person\'s own message, first shown when the session opens', () => {
  const m = machine();
  const now = Date.now();
  fs.writeFileSync(path.join(m.vh, 'return-bindings.json'), JSON.stringify({ mira: { from: 'ada', project: 'agent loop', draftId: 'w1', sentAt: now - 20 * MIN, messageId: 'msg_mine9', firstLine: 'which pattern?' } }));
  const messages = ssh.normalizeMessages([{ id: REPLY, from: 'mira', to: 'ada', text: 'use ^[0-9]{5,8}$ and drop the retry wrapper', createdAt: new Date(now - 5 * MIN).toISOString() }]);

  const start = captureStart(m, messages);
  // (c) what the agent reads when the session opens
  assertNoteBackAfterFence(ctx(start));
  assert.ok(!String(start.systemMessage || '').includes('kind landed'), 'never in the person\'s line');

  ssh.shownForLanding(messages, { session_id: 's1' }, { VIBE_API_URL: 'http://127.0.0.1:9', VIBE_HOME: m.vh });
  // (b) the person's first prompt carries the reminder, with that id
  const first = hook(m);
  assert.ok(ctx(first).includes(REMINDER), ctx(first));
  assert.ok(ctx(first).includes(NOTE_BACK));
  // (a) and the landing record is open (one reminder told, two to go)
  assert.deepEqual(opened(m), [REPLY]);
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('session start: no note-back line for a message that is not a reply to the person\'s own, but its id is still named', () => {
  const m = machine();
  const now = Date.now();
  const messages = ssh.normalizeMessages([{ id: REPLY, from: 'mira', to: 'ada', text: 'hello', createdAt: new Date(now - 5 * MIN).toISOString() }]);
  const text = ctx(captureStart(m, messages));
  assert.ok(text.includes(`From @mira, message id ${REPLY} (`), text);
  assert.ok(!text.includes('kind landed'), 'first contact: no binding, no note back');
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('codeFidelity switched off (loopback only): the note-back line stays above the message, as before', () => {
  const prev = process.env.VIBE_NOTICE_OFF;
  process.env.VIBE_NOTICE_OFF = 'codeFidelity';
  try {
    const now = Date.now();
    const r = arrival.render({ id: REPLY, from: 'mira', text: 'auto is fine', sentAt: now - MIN, unread: 1, context: { messageId: 'msg_mine9', sentAt: now - 20 * MIN, firstLine: 'auto or any?' } });
    const at = r.context.indexOf(NOTE_BACK);
    assert.ok(at > 0 && at < r.context.indexOf('<<< MESSAGE from @mira >>>'), r.context);
  } finally { if (prev === undefined) delete process.env.VIBE_NOTICE_OFF; else process.env.VIBE_NOTICE_OFF = prev; }
});
