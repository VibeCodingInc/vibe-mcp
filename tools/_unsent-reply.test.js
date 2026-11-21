/**
 * A reply drafted and never chosen about is brought back, once.
 *
 * Lab 2026-11-21: someone's message arrived, the agent prepared a reply
 * (vibe_prepare: a preview, nothing sent), the person was pulled away and never
 * chose Send or Cancel, and nothing ever said so again: the other person waited
 * for good. Now the person is told in one line, at session start (once per
 * session per draft) or mid-session through the arrival hook (once per draft,
 * after it has sat unchosen for 30 minutes), and vibe_people marks the
 * conversation. Nothing here sends: no message is posted on any path below.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');
const unsent = require('../unsent');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;
const HOUR = 3600e3;

function homeFor(handle, knownHandles = []) {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-unsent-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(knownHandles.map((h) => [h, 1])) }));
  return vh;
}
function draft(over = {}) {
  const at = over.revAt || Date.now() - 3 * HOUR;
  return { id: 'w1a2b3c4d', status: 'previewed', createdAt: at, from: 'oren', to: 'mira', body: 'UTC with a Z.', replyTo: null, refs: [], context: { project: null }, firstRev: 'abcd1234', revFor: 'abcd1234', revAt: at, ...over };
}
function writeDrafts(vh, drafts) { fs.writeFileSync(path.join(vh, 'drafts.json'), JSON.stringify(drafts)); }
function sitDown(vh, apiUrl, session) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: session }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve({ out: JSON.parse(out), raw: out }); });
  });
}
function arrivalHook(vh, event, session) {
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, session_id: session }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: path.join(vh, 'arrivals'), VIBE_TURNS_DIR: path.join(vh, 'turns') }, encoding: 'utf8',
  });
  return JSON.parse(out.stdout);
}
const draftLine = (out) => String(out.systemMessage || '').split('\n').filter((l) => /drafted but not sent/.test(l)).join('\n');
const startStub = async (people) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people });
const sends = (stub) => stub.effects.filter((e) => ['SEND', 'READ_CURSOR', 'MINT_INVITE'].includes(e.effect));
const LINE = '/vibe · your reply to @mira is drafted but not sent (prepared 3 hours ago) · send it, change it, or drop it?';

// ── which drafts count ──────────────────────────────────────────────────────

test('openReplies: only an open draft, by me, to someone who wrote last, within a draft\'s life', () => {
  const now = Date.now();
  const threads = [
    { handle: 'mira', lastFrom: 'mira', unread: 0 },          // read, but she wrote last: still waiting on oren
    { handle: 'ada', lastFrom: 'oren', unread: 1 },            // oren wrote last: answered
    { handle: 'sam', lastFrom: 'sam', unread: 1, muted: true },
  ];
  const ids = (drafts, opts = {}) => unsent.openReplies(drafts, threads, 'oren', { now, ...opts }).map((r) => r.id);
  assert.deepEqual(ids([draft()]), ['w1a2b3c4d']);
  assert.deepEqual(ids([draft({ to: 'ada' })]), [], 'the conversation ends on their own words');
  assert.deepEqual(ids([draft({ to: 'sam' })]), [], 'muted');
  assert.deepEqual(ids([draft({ to: 'zed' })]), [], 'no conversation at all');
  for (const status of ['sent', 'cancelled', 'sending', 'unknown', 'held']) assert.deepEqual(ids([draft({ status })]), [], status);
  assert.deepEqual(ids([draft({ held: true })]), [], 'a message held for a newcomer is not a reply');
  assert.deepEqual(ids([draft({ from: 'someoneelse' })]), [], 'another account\'s draft');
  assert.deepEqual(ids([draft({ createdAt: now - 25 * HOUR, revAt: now - 25 * HOUR })]), [], 'past a draft\'s 24h life');
  assert.deepEqual(ids([draft({ revAt: now - 10 * 60e3 })], { minAgeMs: unsent.MID_SESSION_AFTER_MS }), [], 'too fresh for mid-session');
  assert.deepEqual(ids([draft({ revAt: now - 40 * 60e3 })], { minAgeMs: unsent.MID_SESSION_AFTER_MS }), ['w1a2b3c4d']);
  assert.deepEqual(ids([draft()], { isMuted: (h) => h === 'mira' }), [], 'muted locally');
});

test('render: one plain line for the person; the model is told what it may do and that it never acts alone', () => {
  const r = unsent.render({ id: 'w1a2b3c4d', to: 'mira', at: Date.now() - 3 * HOUR });
  assert.equal(r.line, LINE);
  assert.equal(r.context, [
    '/vibe: the person has a reply to @mira drafted but not sent (draft w1a2b3c4d, prepared 3 hours ago), and @mira wrote last in that conversation, so @mira may still be waiting.',
    'The person has been shown this one line.',
    'If they want to send or change it, open it with vibe_prepare {id: "w1a2b3c4d"} so they see the exact text again, and call vibe_send only after they choose Send. If they want to drop it, call vibe_discard {id: "w1a2b3c4d"}.',
    'Do not send, change or drop it on your own, and do not bring it up again.',
  ].join('\n'));
  assert.ok(!/!/.test(r.line + r.context), 'no exclamation marks');
});

// ── session start ───────────────────────────────────────────────────────────

test('session start: said once per session per draft, and never sends', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    stub.post('mira', 'oren', 'does scheduled_at come back as UTC with a Z?');
    const vh = homeFor('oren', ['mira']);
    writeDrafts(vh, [draft()]);
    const first = await sitDown(vh, stub.url, 'sessA');
    assert.equal(draftLine(first.out), LINE);
    assert.match(first.out.hookSpecificOutput.additionalContext, /draft w1a2b3c4d, prepared 3 hours ago/);
    assert.ok(!draftLine(first.out).includes('scheduled_at'), 'their words are not in the draft line');

    assert.equal(draftLine((await sitDown(vh, stub.url, 'sessA')).out), '', 'a resume of the same session: not again');
    assert.equal(draftLine((await sitDown(vh, stub.url, 'sessB')).out), LINE, 'a new session: once more');
    assert.deepEqual(sends(stub), [], 'nothing was sent, marked read or minted');
    assert.equal(JSON.parse(fs.readFileSync(path.join(vh, 'drafts.json'), 'utf8'))[0].status, 'previewed', 'the draft is untouched');
  } finally { await stub.close(); }
});

test('session start: nothing for a draft already chosen about, or a conversation already answered', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    stub.post('mira', 'oren', 'question');
    const vh = homeFor('oren', ['mira']);
    writeDrafts(vh, [draft({ status: 'cancelled' })]);
    assert.equal(draftLine((await sitDown(vh, stub.url, 's1')).out), '', 'cancelled');
    writeDrafts(vh, [draft()]);
    stub.post('oren', 'mira', 'answered from the terminal instead');
    assert.equal(draftLine((await sitDown(vh, stub.url, 's2')).out), '', 'their words are no longer the last');
  } finally { await stub.close(); }
});

test('session start without an open draft asks for nothing more', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    stub.post('mira', 'oren', 'question');
    const vh = homeFor('oren', ['mira']);
    const reads = () => stub.effects.filter((e) => e.effect === 'read_threads').length;
    await sitDown(vh, stub.url, 's1');
    const without = reads();
    writeDrafts(vh, [draft()]);
    await sitDown(vh, stub.url, 's2');
    const withDraft = reads() - without;
    assert.equal(withDraft, without + 1, 'exactly one more conversation-list read, and only when a draft is open');
  } finally { await stub.close(); }
});

// ── mid-session ─────────────────────────────────────────────────────────────

const threadsWaiting = [{ handle: 'mira', lastFrom: 'mira', unread: 1 }];

test('mid-session: after 30 minutes unchosen, the arrival hook says it once', () => {
  const vh = homeFor('oren', ['mira']);
  const env = { VIBE_HOME: vh };
  writeDrafts(vh, [draft({ revAt: Date.now() - 10 * 60e3 })]);
  assert.deepEqual(unsent.spool(threadsWaiting, 'oren', { env }), [], '10 minutes: not yet');
  writeDrafts(vh, [draft({ revAt: Date.now() - 40 * 60e3 })]);
  assert.equal(unsent.spool(threadsWaiting, 'oren', { env }).length, 1);
  const shown = arrivalHook(vh, 'UserPromptSubmit', 'sess1');
  assert.equal(shown.systemMessage, '/vibe · your reply to @mira is drafted but not sent (prepared 40 minutes ago) · send it, change it, or drop it?');
  assert.match(shown.hookSpecificOutput.additionalContext, /vibe_prepare \{id: "w1a2b3c4d"\}/);
  assert.deepEqual(arrivalHook(vh, 'PostToolUse', 'sess1'), { suppressOutput: true }, 'once');
  assert.deepEqual(unsent.spool(threadsWaiting, 'oren', { env }), [], 'never spooled again for this draft');
  assert.equal(unsent.told('w1a2b3c4d', 'sess1', env), true, 'the hook marks the session with the name unsent.js reads');
});

test('mid-session: a draft sent or dropped before the hook runs is not mentioned', () => {
  const vh = homeFor('oren', ['mira']);
  const env = { VIBE_HOME: vh };
  writeDrafts(vh, [draft({ revAt: Date.now() - 40 * 60e3 })]);
  assert.equal(unsent.spool(threadsWaiting, 'oren', { env }).length, 1);
  writeDrafts(vh, [draft({ revAt: Date.now() - 40 * 60e3, status: 'cancelled' })]);
  assert.deepEqual(arrivalHook(vh, 'UserPromptSubmit', 'sess1'), { suppressOutput: true });
});

test('mid-session: not repeated in a session already told at start', () => {
  const vh = homeFor('oren', ['mira']);
  const env = { VIBE_HOME: vh };
  writeDrafts(vh, [draft()]);
  unsent.markTold('w1a2b3c4d', 'sess1', env);   // what the session-start hook records after saying it
  assert.deepEqual(unsent.spool(threadsWaiting, 'oren', { env }), []);
  assert.deepEqual(arrivalHook(vh, 'UserPromptSubmit', 'sess1'), { suppressOutput: true });
});
