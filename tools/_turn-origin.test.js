'use strict';
/**
 * Who started this turn, as Claude Code's transcript labels it.
 *
 * Seen live 2026-11-21: a wake-up the agent scheduled for itself fired
 * UserPromptSubmit and was recorded as the person's turn, with prompt text the
 * agent chose, so no prefix rule can catch it. The session transcript labels
 * the entry that starts each turn (turnOrigin human / scheduled / peer /
 * task_notification; "sdk" for claude -p and the Agent SDK). Those fields are
 * undocumented; the fixtures below have the shapes observed that day (keys and
 * label values only) with invented text.
 *
 * Claude Code writes a prompt's entry only after its UserPromptSubmit hooks
 * finish, so the hook takes one quick look and, in a labelling transcript,
 * usually records a PENDING turn; vibe_send settles it (turns.js judge). This
 * file covers the hook's quick look and the send-time settling through judge;
 * _turn-origin-send.test.js covers vibe_send end to end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const { transcriptOrigin, personPrompt, TAIL_BYTES } = require('../hooks/arrival-hook.cjs');
const turns = require('../turns');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-origin-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const sha = (t) => crypto.createHash('sha256').update(String(t).trim(), 'utf8').digest('hex');

const base = () => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/w', sessionId: 's1', version: '2.1.330', gitBranch: 'main', timestamp: new Date().toISOString() });
const human = (text, promptSource = 'typed') => ({ ...base(), type: 'user', promptSource, turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const ENTRY = {
  typed: (t) => human(t),
  queued: (t) => human(t, 'queued'),
  suggestion_accepted: (t) => human(t, 'suggestion_accepted'),
  scheduled: (t) => ({ ...base(), type: 'user', promptSource: 'system', turnOrigin: 'scheduled', isMeta: true, message: { role: 'user', content: t } }),
  peer: (t) => ({ ...base(), type: 'user', promptSource: 'system', turnOrigin: 'peer', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: t } }),
  task_notification: (t) => ({ ...base(), type: 'user', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: t } }),
  // Shape observed from `claude -p` (Claude Code 2.1.330).
  sdk: (t) => ({ ...base(), type: 'user', entrypoint: 'sdk-cli', promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: t } }),
  unlabelled: (t) => ({ ...base(), type: 'user', message: { role: 'user', content: t } }),
};
const toolResult = () => ({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const assistant = (t) => ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

function transcript(entries) {
  const file = path.join(root, `t${++n}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const append = (file, e) => fs.appendFileSync(file, JSON.stringify(e) + '\n');

/** A scratch project with its own turns dir; run(prompt, transcript) runs the real hook there. */
function project() {
  const dir = path.join(root, `p${++n}`);
  const proj = path.join(dir, 'project');
  fs.mkdirSync(proj, { recursive: true });
  const env = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS || '', VIBE_TURNS_DIR: path.join(dir, 'turns'), VIBE_ARRIVALS_DIR: path.join(dir, 'arrivals'), CLAUDE_PROJECT_DIR: proj };
  const p = {
    dir, proj, env,
    run(prompt, transcriptPath, { hook = HOOK } = {}) {
      const r = spawnSync(process.execPath, [hook], {
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: `s${n}`, cwd: proj, prompt, transcript_path: transcriptPath }),
        env, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(r.status, 0, r.stderr);
      return r;
    },
    record: () => turns.turnRecord(proj, env),
    /** What vibe_send's check says for a rev shown at revAt. */
    judge: (revAt) => turns.judge(revAt, { env, cwd: () => proj, host: 'claude-code' }),
  };
  return p;
}
/** The outcome of the hook's quick look, as recorded: 'confirmed' | 'pending' | 'none'. */
function outcome(p, prompt, file, opts) {
  const before = p.record();
  p.run(prompt, file, opts);
  const after = p.record();
  if (after.pending && (!before.pending || after.pending.at !== before.pending.at)) return 'pending';
  if (after.at !== null && after.at !== before.at) return 'confirmed';
  return 'none';
}
const tick = () => { const t = Date.now(); while (Date.now() === t) { /* next ms */ } return t; };

// ── the hook's quick look ──────────────────────────────────────────────────

test('each origin kind, entry already written: human confirmed, the rest recorded as nothing', () => {
  const prompt = 'send it';
  for (const [kind, want] of [['typed', 'confirmed'], ['queued', 'confirmed'], ['suggestion_accepted', 'confirmed'], ['scheduled', 'none'], ['peer', 'none'], ['task_notification', 'none'], ['sdk', 'confirmed']]) {
    const file = transcript([ENTRY.typed('earlier words'), assistant('ok'), toolResult(), ENTRY[kind](prompt)]);
    assert.equal(outcome(project(), prompt, file), want, kind);
  }
});

test('the entry not written yet in a labelling transcript: a pending turn, holding no prompt text', () => {
  const p = project();
  const file = transcript([ENTRY.typed('earlier'), assistant('ok')]);
  p.run('first, typed', transcript([ENTRY.typed('first, typed')])); // a confirmed turn to sit beside
  const confirmed = p.record().at;
  const t0 = Date.now();
  p.run('SECRET-WORDS send it', file);
  assert.ok(Date.now() - t0 < 1500);
  const rec = p.record();
  assert.equal(rec.at, confirmed, 'the last confirmed turn is kept');
  assert.equal(rec.pending.sha256, sha('SECRET-WORDS send it'));
  assert.equal(rec.pending.transcript, file);
  const raw = fs.readdirSync(path.join(p.dir, 'turns')).map((f) => fs.readFileSync(path.join(p.dir, 'turns', f), 'utf8')).join('\n');
  assert.doesNotMatch(raw, /SECRET-WORDS|earlier/);
});

test('the quick look does not wait: a labelling transcript without the entry answers at once', () => {
  const file = transcript([ENTRY.typed('earlier'), ENTRY.scheduled('another thing')]);
  const t0 = Date.now();
  assert.equal(transcriptOrigin('send it', file), 'pending');
  assert.ok(Date.now() - t0 < 50, `${Date.now() - t0}ms`);
});

test('an unlabelled matching entry in a labelling transcript is pending, not confirmed', () => {
  assert.equal(transcriptOrigin('send it', transcript([ENTRY.typed('earlier'), ENTRY.unlabelled('send it')])), 'pending');
});

test('origin.kind or promptSource without turnOrigin decide the same way', () => {
  const noTurnOrigin = { ...base(), type: 'user', promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'go on' } };
  assert.equal(transcriptOrigin('go on', transcript([ENTRY.typed('earlier'), noTurnOrigin])), 'other');
  const typedOnlySource = { ...base(), type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go on' } };
  assert.equal(transcriptOrigin('go on', transcript([ENTRY.typed('earlier'), typedOnlySource])), 'human');
});

test('the newest matching entry decides, and an old entry with the same words is not this prompt', () => {
  assert.equal(transcriptOrigin('send it', transcript([ENTRY.typed('send it'), assistant('ok'), ENTRY.scheduled('send it')])), 'other');
  assert.equal(transcriptOrigin('send it', transcript([ENTRY.scheduled('send it'), assistant('ok'), ENTRY.typed('send it')])), 'human');
  // Typed an hour ago: a match for an earlier prompt, not this one. Pending.
  const old = { ...ENTRY.typed('check /vibe'), timestamp: new Date(Date.now() - 3600e3).toISOString() };
  assert.equal(transcriptOrigin('check /vibe', transcript([old, assistant('ok')])), 'pending');
});

test('no labels anywhere (an older Claude Code), no transcript, or an unreadable one: confirmed, as today', () => {
  const unl = transcript([ENTRY.unlabelled('earlier'), assistant('ok'), ENTRY.unlabelled('check /vibe and reply to anything waiting')]);
  assert.equal(outcome(project(), 'check /vibe and reply to anything waiting', unl), 'confirmed');
  assert.equal(outcome(project(), 'not in the transcript', unl), 'confirmed');
  const noRead = path.join(root, 'noread.jsonl');
  fs.writeFileSync(noRead, JSON.stringify(ENTRY.scheduled('send it')) + '\n');
  fs.chmodSync(noRead, 0o000);
  const cases = [undefined, '', path.join(root, 'missing.jsonl'), root, 42];
  if (process.getuid && process.getuid() !== 0) cases.push(noRead);
  for (const p of cases) {
    assert.equal(transcriptOrigin('send it', p), 'unknown', String(p));
    assert.equal(outcome(project(), 'send it', p), 'confirmed', String(p));
  }
  fs.chmodSync(noRead, 0o600);
});

test('the lab pattern (claude -p --resume, every entry "sdk"): confirmed at the hook, nothing pending', () => {
  const p = project();
  const file = transcript([ENTRY.sdk('day one'), assistant('ok')]);
  assert.equal(outcome(p, 'send it', file), 'confirmed'); // its own entry is written later; no labels in the tail
  append(file, ENTRY.sdk('send it'));
  assert.equal(p.record().pending, null);
  // An sdk session that had a scheduled wake earlier is labelling: pending, then settled as sdk.
  const q = project();
  const f2 = transcript([ENTRY.sdk('day one'), ENTRY.scheduled('wake'), assistant('ok')]);
  const shownAt = tick();
  assert.equal(outcome(q, 'send it', f2), 'pending');
  append(f2, ENTRY.sdk('send it'));
  assert.equal(q.judge(shownAt).check, 'passed');
});

test('the wrapper rules still come first: a typed-looking entry for a hand-back is not a turn', () => {
  const text = 'Another Claude session sent a message: done';
  assert.equal(outcome(project(), text, transcript([ENTRY.typed(text)])), 'none');
});

test('message content as an array of blocks (text with an image) is matched', () => {
  const entry = { ...human(''), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '[Image #1] send it' }] } };
  assert.equal(transcriptOrigin('[Image #1] send it', transcript([entry])), 'human');
  const sched = { ...ENTRY.scheduled(''), message: { role: 'user', content: [{ type: 'text', text: 'wake' }, { type: 'text', text: ' up' }] } };
  assert.equal(transcriptOrigin('wake up', transcript([ENTRY.typed('x'), sched])), 'other');
});

test('prompts that need JSON escaping are matched exactly', () => {
  for (const p of ['say "send it" \\ now', 'line one\nline two\r\n\ttabbed', 'émoji 🚀 and 漢字', '   separators', '</script><b>x</b>', 'a "user" in quotes']) {
    assert.equal(transcriptOrigin(p, transcript([ENTRY.typed('earlier'), ENTRY.typed(p)])), 'human', JSON.stringify(p));
    assert.equal(transcriptOrigin(p, transcript([ENTRY.typed('earlier'), ENTRY.scheduled(p)])), 'other', JSON.stringify(p));
  }
});

test('a 5 MB transcript: only the tail is read, and quickly', () => {
  const filler = [];
  const big = 'x'.repeat(4000);
  for (let i = 0; i < 1300; i++) filler.push(assistant(`${i} ${big}`), toolResult());
  const file = transcript([ENTRY.typed('send it'), ...filler, ENTRY.scheduled('send it')]);
  assert.ok(fs.statSync(file).size > 5 * 1024 * 1024);
  let t0 = Date.now();
  assert.equal(transcriptOrigin('send it', file), 'other');
  assert.ok(Date.now() - t0 < 300, `${Date.now() - t0}ms`);
  // A typed match older than the tail is not seen: pending.
  const old = transcript([ENTRY.typed('only long ago'), ...filler, ENTRY.typed('latest')]);
  t0 = Date.now();
  assert.equal(transcriptOrigin('only long ago', old), 'pending');
  assert.ok(Date.now() - t0 < 300, `${Date.now() - t0}ms`);
  t0 = Date.now();
  assert.equal(outcome(project(), 'send it', file), 'none');
  assert.equal(outcome(project(), 'latest', old), 'confirmed');
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  // And at send time, through judge.
  const p = project();
  const shownAt = tick();
  p.run('only long ago', old);
  t0 = Date.now();
  assert.equal(p.judge(shownAt).why, 'turn_unconfirmed');
  assert.ok(Date.now() - t0 < 300, `${Date.now() - t0}ms`);
});

test('a multi-byte character split at the tail boundary does not break the read', () => {
  const prompt = 'ship it 🚀 — ça va';
  const head = JSON.stringify(ENTRY.typed('earlier')) + '\n';
  const last = JSON.stringify(ENTRY.typed(prompt)) + '\n';
  const splits = new Set();
  for (let j = 0; j < 4; j++) {
    const middle = JSON.stringify(assistant('🚀'.repeat(TAIL_BYTES / 4) + 'a'.repeat(j))) + '\n';
    const file = path.join(root, `mb${++n}.jsonl`);
    fs.writeFileSync(file, head + middle + last);
    const buf = fs.readFileSync(file);
    const start = buf.length - TAIL_BYTES;
    assert.ok(start > Buffer.byteLength(head) && start < Buffer.byteLength(head + middle), 'the window starts inside the long line');
    let into = 0;
    while ((buf[start - into] & 0xc0) === 0x80) into++;
    splits.add(into);
    assert.equal(transcriptOrigin(prompt, file), 'human', `window ${into} bytes into a character`);
    assert.equal(transcriptOrigin(`${prompt}!`, file), 'pending');
  }
  assert.deepEqual([...splits].sort(), [0, 1, 2, 3], 'every split position was tried');
});

test('a window that starts exactly on a line keeps that whole line', () => {
  const filler = JSON.stringify(assistant('a'.repeat(1000))) + '\n';
  const e = ENTRY.scheduled('wake');
  const bare = JSON.stringify({ ...e, pad: '' });
  const line = JSON.stringify({ ...e, pad: 'q'.repeat(TAIL_BYTES - Buffer.byteLength(bare) - 1) }) + '\n';
  assert.equal(Buffer.byteLength(line), TAIL_BYTES);
  const file = path.join(root, `edge${++n}.jsonl`);
  fs.writeFileSync(file, filler + line);
  // Dropped as a cut line, this would be "no labels": a turn. Kept, it is the scheduled wake.
  assert.equal(transcriptOrigin('wake', file), 'other');
});

test('the stuck nudge: shown unless the quick look already said not the person', () => {
  const said = "I'm stuck on the migration";
  assert.match(project().run(said, transcript([ENTRY.typed(said)])).stdout, /they are stuck/);
  assert.match(project().run(said, transcript([ENTRY.typed('earlier')])).stdout, /they are stuck/, 'pending: shown');
  assert.doesNotMatch(project().run(said, transcript([ENTRY.typed('earlier'), ENTRY.scheduled(said)])).stdout, /they are stuck/);
});

test('nothing from the transcript is printed by the hook', () => {
  const secret = 'SECRET-PROMPT-TEXT-1234';
  const p = project();
  const r = p.run(secret, transcript([ENTRY.typed(`earlier ${secret}`), ENTRY.typed(secret)]));
  assert.doesNotMatch(r.stdout, /SECRET-PROMPT/);
  assert.deepEqual(Object.keys(p.record()).sort(), ['at', 'pending']);
  assert.equal(p.record().pending, null);
});

test('the installed copy (the file alone in another folder) makes the same decision', () => {
  const home = path.join(root, `installed${++n}`, 'hooks');
  fs.mkdirSync(home, { recursive: true });
  const copy = path.join(home, 'arrival-hook.cjs');
  fs.copyFileSync(HOOK, copy);
  assert.equal(outcome(project(), 'send it', transcript([ENTRY.typed('x'), ENTRY.scheduled('send it')]), { hook: copy }), 'none');
  assert.equal(outcome(project(), 'send it', transcript([ENTRY.scheduled('x'), ENTRY.typed('send it')]), { hook: copy }), 'confirmed');
  assert.equal(outcome(project(), 'send it', transcript([ENTRY.typed('x')]), { hook: copy }), 'pending');
});

test('personPrompt never throws', () => {
  for (const input of [null, undefined, {}, { prompt: 'x', transcript_path: {} }, { prompt: 'x', transcript_path: '\0bad' }]) {
    assert.doesNotThrow(() => personPrompt(input));
  }
});

// ── settled at send time (turns.js judge) ──────────────────────────────────

function pendingAfterShowing(entries = [ENTRY.typed('earlier'), assistant('ok')], prompt = 'yes, send it') {
  const p = project();
  p.run('earlier', transcript([ENTRY.typed('earlier')])); // a confirmed turn before the showing
  const shownAt = tick();
  tick();
  const file = transcript(entries);
  p.run(prompt, file);
  assert.ok(p.record().pending, 'pending recorded');
  return { p, shownAt, file, prompt };
}

test('pending, then the human entry is written: the send passes and the turn is promoted', () => {
  for (const kind of ['typed', 'queued', 'suggestion_accepted']) {
    const { p, shownAt, file, prompt } = pendingAfterShowing();
    const pendingAt = p.record().pending.at;
    append(file, ENTRY[kind](prompt));
    assert.equal(p.judge(shownAt).check, 'passed', kind);
    assert.deepEqual(p.record(), { at: pendingAt, pending: null }, 'promoted to confirmed');
    assert.equal(p.judge(shownAt).check, 'passed', 'and stays passed without reading again');
  }
});

test('pending, then a non-human label: refused, and the pending turn is cleared', () => {
  for (const kind of ['scheduled', 'peer', 'task_notification']) {
    const { p, shownAt, file, prompt } = pendingAfterShowing();
    const confirmed = p.record().at;
    append(file, ENTRY[kind](prompt));
    assert.deepEqual(p.judge(shownAt), { check: 'needs_turn', why: 'no_turn_since_shown' }, kind);
    assert.deepEqual(p.record(), { at: confirmed, pending: null });
  }
  // An unlabelled entry in a labelling transcript is not the person's either.
  const { p, shownAt, file, prompt } = pendingAfterShowing();
  append(file, ENTRY.unlabelled(prompt));
  assert.equal(p.judge(shownAt).why, 'no_turn_since_shown');
  assert.equal(p.record().pending, null);
});

test('pending, and the entry never appears: refused as unconfirmed, pending kept so a late entry still counts', () => {
  const { p, shownAt, file, prompt } = pendingAfterShowing();
  assert.deepEqual(p.judge(shownAt), { check: 'needs_turn', why: 'turn_unconfirmed' });
  assert.ok(p.record().pending, 'kept');
  append(file, ENTRY.typed(prompt));
  assert.equal(p.judge(shownAt).check, 'passed');
});

test('pending, and the transcript has moved or been deleted: refused as unconfirmed', () => {
  const a = pendingAfterShowing();
  fs.renameSync(a.file, `${a.file}.moved`);
  assert.equal(a.p.judge(a.shownAt).why, 'turn_unconfirmed');
  const b = pendingAfterShowing();
  fs.rmSync(b.file);
  assert.equal(b.p.judge(b.shownAt).why, 'turn_unconfirmed');
});

test('two pending prompts in a row: only the newest is kept and settled', () => {
  const { p, shownAt, file } = pendingAfterShowing(undefined, 'first');
  tick();
  p.run('second', file);
  const rec = p.record();
  assert.equal(rec.pending.sha256, sha('second'), 'the newest pending replaced the earlier one');
  // Only "first" is the person's: the newest ("second") decides, and it never appears.
  append(file, ENTRY.typed('first'));
  assert.equal(p.judge(shownAt).why, 'turn_unconfirmed');
  append(file, ENTRY.typed('second'));
  assert.equal(p.judge(shownAt).check, 'passed');
});

test('a pending turn from before the showing does not count', () => {
  const p = project();
  const file = transcript([ENTRY.typed('earlier')]);
  p.run('before', file);
  append(file, ENTRY.typed('before'));
  const shownAt = tick();
  tick();
  assert.equal(p.judge(shownAt).why, 'no_turn_since_shown');
});
