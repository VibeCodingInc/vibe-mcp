'use strict';
/**
 * Who started this turn, as Claude Code's transcript labels it
 * (hooks/arrival-hook.cjs transcriptOrigin).
 *
 * Seen live 2026-11-21: a wake-up the agent scheduled for itself fired
 * UserPromptSubmit and was recorded as the person's turn, with prompt text the
 * agent chose, so no prefix rule can catch it. The session transcript labels
 * the entry that starts each turn (turnOrigin human / scheduled / peer /
 * task_notification). Those fields are undocumented; the fixtures below have
 * the shapes observed that day (keys and label values only) with invented text.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const { transcriptOrigin, personPrompt, confirmTurn, TAIL_BYTES } = require('../hooks/arrival-hook.cjs');
const crypto = require('node:crypto');
const hash = (t) => crypto.createHash('sha256').update(String(t).trim(), 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-origin-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/w', sessionId: 's1', version: '2.9.0', gitBranch: 'main', timestamp: '2026-11-21T10:00:00.000Z' };
const human = (text, promptSource = 'typed') => ({ ...base, type: 'user', promptSource, turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const ENTRY = {
  typed: (t) => human(t),
  queued: (t) => human(t, 'queued'),
  suggestion_accepted: (t) => human(t, 'suggestion_accepted'),
  scheduled: (t) => ({ ...base, type: 'user', promptSource: 'system', turnOrigin: 'scheduled', isMeta: true, message: { role: 'user', content: t } }),
  peer: (t) => ({ ...base, type: 'user', promptSource: 'system', turnOrigin: 'peer', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: t } }),
  task_notification: (t) => ({ ...base, type: 'user', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: t } }),
  unlabelled: (t) => ({ ...base, type: 'user', message: { role: 'user', content: t } }),
};
const toolResult = { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
const assistant = (t) => ({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

function transcript(entries, prefix = '') {
  const file = path.join(root, `t${++n}.jsonl`);
  fs.writeFileSync(file, prefix + entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function hookEnv(dir) {
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { project, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS || '', VIBE_TURNS_DIR: path.join(dir, 'turns'), VIBE_ARRIVALS_DIR: path.join(dir, 'arrivals'), CLAUDE_PROJECT_DIR: project } };
}
const turnFiles = (dir) => { try { return fs.readdirSync(path.join(dir, 'turns')).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)); } catch { return []; } };

/** Run the hook on one prompt; returns { recorded, stdout, dir }. */
function run(prompt, transcriptPath, { hook = HOOK } = {}) {
  const dir = path.join(root, `run${++n}`);
  const { project, env } = hookEnv(dir);
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: `s${n}`, cwd: project, prompt, transcript_path: transcriptPath }),
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return { recorded: turnFiles(dir).length > 0, stdout: r.stdout, dir };
}

test('each origin kind: only a turn the transcript labels human counts', () => {
  const prompt = 'send it';
  for (const [kind, want] of [['typed', true], ['queued', true], ['suggestion_accepted', true], ['scheduled', false], ['peer', false], ['task_notification', false]]) {
    const file = transcript([ENTRY.typed('earlier words'), assistant('ok'), toolResult, ENTRY[kind](prompt)]);
    assert.equal(transcriptOrigin(prompt, file), want ? 'human' : 'other', kind);
    assert.equal(run(prompt, file).recorded, want, kind);
  }
});

test('a prompt given through claude -p or the Agent SDK ("sdk") is today\'s behaviour: a turn', () => {
  // Shape observed from `claude -p` (Claude Code 2.1.330): promptSource and turnOrigin "sdk", no origin.
  const sdk = (t) => ({ ...base, type: 'user', entrypoint: 'sdk-cli', promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: t } });
  assert.equal(transcriptOrigin('send it', transcript([sdk('earlier'), assistant('ok'), sdk('send it')])), 'unknown');
  assert.equal(run('send it', transcript([sdk('earlier'), assistant('ok'), sdk('send it')])).recorded, true);
  // Also after a scheduled wake earlier in the same session.
  assert.equal(run('send it', transcript([sdk('earlier'), ENTRY.scheduled('wake'), sdk('send it')])).recorded, true);
  // A scheduled wake in such a session is still not a turn.
  assert.equal(run('wake', transcript([sdk('earlier'), ENTRY.scheduled('wake')])).recorded, false);
  // An sdk-only transcript with no match: no labels, today's behaviour.
  assert.equal(transcriptOrigin('elsewhere', transcript([sdk('earlier')]), { tries: 1 }), 'unknown');
});

test('an origin.kind or promptSource without turnOrigin decides the same way', () => {
  const noTurnOrigin = { ...base, type: 'user', promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'go on' } };
  const file = transcript([ENTRY.typed('earlier'), noTurnOrigin]);
  assert.equal(transcriptOrigin('go on', file), 'other');
  const typedOnlySource = { ...base, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go on' } };
  assert.equal(transcriptOrigin('go on', transcript([ENTRY.typed('earlier'), typedOnlySource])), 'human');
});

test('the newest matching entry decides: a scheduled wake repeating words the person typed earlier is not a turn', () => {
  assert.equal(run('send it', transcript([ENTRY.typed('send it'), assistant('ok'), ENTRY.scheduled('send it')])).recorded, false);
  assert.equal(run('send it', transcript([ENTRY.scheduled('send it'), assistant('ok'), ENTRY.typed('send it')])).recorded, true);
});

test('a labelled transcript without this prompt yet: pending after a short wait in the hook', () => {
  const file = transcript([ENTRY.typed('something else'), ENTRY.scheduled('another thing')]);
  const t0 = Date.now();
  assert.equal(transcriptOrigin('send it', file), 'pending');
  const took = Date.now() - t0;
  assert.ok(took >= 80 && took < 400, `waited ${took}ms`);
  const r = run('send it', file);
  assert.equal(r.recorded, false, 'recorded before the entry said who wrote it');
});

test('the detached check decides once the entry is written, and records the prompt time', async () => {
  // Claude Code writes the entry after the hook returns: the hook hands off and exits.
  const cases = [['typed', true], ['queued', true], ['scheduled', false], ['peer', false], [null, false]];
  await Promise.all(cases.map(async ([kind, want]) => {
    const file = transcript([ENTRY.typed('earlier'), ENTRY.scheduled('wake')]);
    const dir = path.join(root, `late${++n}`);
    const { project, env } = hookEnv(dir);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: project, prompt: 'go ahead', transcript_path: file }), env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 1500, `the hook itself returned in ${Date.now() - t0}ms`);
    assert.equal(turnFiles(dir).length, 0, 'nothing recorded before the entry exists');
    await sleep(800);
    if (kind) fs.appendFileSync(file, JSON.stringify(ENTRY[kind]('go ahead')) + '\n');
    const got = await until(() => turnFiles(dir).length > 0, want ? 3000 : 6000);
    assert.equal(got, want, String(kind));
    if (want) {
      const at = JSON.parse(fs.readFileSync(path.join(dir, 'turns', turnFiles(dir)[0]), 'utf8')).at;
      assert.ok(at >= t0 && at < t0 + 1000, 'dated to the prompt, not to the check');
    }
  }));
});

test('confirmTurn: bounded, and records only a human entry', () => {
  const dir = path.join(root, `confirm${++n}`);
  fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
  const prev = process.env.VIBE_TURNS_DIR;
  process.env.VIBE_TURNS_DIR = path.join(dir, 'turns');
  try {
    const file = transcript([ENTRY.typed('a')]);
    const t0 = Date.now();
    assert.equal(confirmTurn([hash('missing'), file, String(Date.now()), path.join(dir, 'p')], { budgetMs: 300, pollMs: 50 }), false);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(confirmTurn([hash('a'), file, String(Date.now()), path.join(dir, 'p')], { budgetMs: 300, pollMs: 50 }), true);
    assert.equal(turnFiles(dir).length, 1);
    assert.equal(confirmTurn([hash('w'), transcript([ENTRY.typed('a'), ENTRY.scheduled('w')]), String(Date.now()), path.join(dir, 'p')], { budgetMs: 300, pollMs: 50 }), false);
    assert.equal(confirmTurn([hash('a'), path.join(root, 'none.jsonl'), '1', path.join(dir, 'p')], { budgetMs: 100 }), false);
  } finally {
    if (prev === undefined) delete process.env.VIBE_TURNS_DIR; else process.env.VIBE_TURNS_DIR = prev;
  }
});

test('a labelled transcript whose matching entry has no origin fields: no turn', () => {
  const file = transcript([ENTRY.typed('earlier'), ENTRY.unlabelled('send it')]);
  assert.equal(transcriptOrigin('send it', file), 'other');
  assert.equal(run('send it', file).recorded, false);
});

test('the entry is written 100 ms after the hook started: it is waited for', async () => {
  for (const [kind, want] of [['typed', true], ['scheduled', false]]) {
    const file = transcript([ENTRY.typed('earlier')]);
    const dir = path.join(root, `race${++n}`);
    const { project, env } = hookEnv(dir);
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const started = Date.now();
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: project, prompt: 'yes, send', transcript_path: file }));
    setTimeout(() => fs.appendFileSync(file, JSON.stringify(ENTRY[kind]('yes, send')) + '\n'), 100);
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 1500);
    assert.equal(await until(() => turnFiles(dir).length > 0, want ? 3000 : 1500), want, kind);
  }
});

test('no origin fields anywhere (an older Claude Code): today\'s behaviour, a turn', () => {
  const file = transcript([ENTRY.unlabelled('earlier'), assistant('ok'), ENTRY.unlabelled('check /vibe and reply to anything waiting')]);
  assert.equal(transcriptOrigin('check /vibe and reply to anything waiting', file), 'unknown');
  assert.equal(run('check /vibe and reply to anything waiting', file).recorded, true);
  // Not found and no labels: still a turn (after the bounded wait).
  assert.equal(run('not in the transcript', file).recorded, true);
});

test('no transcript, or an unreadable one: today\'s behaviour, a turn', () => {
  const noRead = path.join(root, 'noread.jsonl');
  fs.writeFileSync(noRead, JSON.stringify(ENTRY.scheduled('send it')) + '\n');
  fs.chmodSync(noRead, 0o000);
  const cases = [undefined, '', path.join(root, 'missing.jsonl'), root, 42];
  if (process.getuid && process.getuid() !== 0) cases.push(noRead);
  for (const p of cases) {
    assert.equal(transcriptOrigin('send it', p), 'unknown', String(p));
    assert.equal(run('send it', p).recorded, true, String(p));
  }
  fs.chmodSync(noRead, 0o600);
});

test('the wrapper rules still come first: a typed-looking entry for a hand-back is not a turn', () => {
  const text = 'Another Claude session sent a message: done';
  assert.equal(run(text, transcript([ENTRY.typed(text)])).recorded, false);
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
  for (let i = 0; i < 1300; i++) filler.push(assistant(`${i} ${big}`), toolResult);
  // The person typed it long ago (outside the tail); the newest is a scheduled wake.
  const file = transcript([ENTRY.typed('send it'), ...filler, ENTRY.scheduled('send it')]);
  assert.ok(fs.statSync(file).size > 5 * 1024 * 1024);
  let t0 = Date.now();
  assert.equal(transcriptOrigin('send it', file), 'other');
  assert.ok(Date.now() - t0 < 300, `${Date.now() - t0}ms`);
  // A typed match older than the tail is not seen: labels in the tail, no match yet.
  const old = transcript([ENTRY.typed('only long ago'), ...filler, ENTRY.typed('latest')]);
  t0 = Date.now();
  assert.equal(transcriptOrigin('only long ago', old), 'pending');
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  // And through the hook, end to end.
  t0 = Date.now();
  assert.equal(run('send it', file).recorded, false);
  assert.equal(run('latest', old).recorded, true);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
});

test('a multi-byte character split at the tail boundary does not break the read', () => {
  const prompt = 'ship it 🚀 — ça va';
  const head = JSON.stringify(ENTRY.typed('earlier')) + '\n';
  const last = JSON.stringify(ENTRY.typed(prompt)) + '\n';
  const splits = new Set();
  // A line of 4-byte characters wider than the window, then ASCII padding of
  // 0-3 bytes: the window's first byte lands at every position inside a character.
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
    assert.equal(transcriptOrigin(`${prompt}!`, file, { tries: 1 }), 'pending');
  }
  assert.deepEqual([...splits].sort(), [0, 1, 2, 3], 'every split position was tried');
});

test('a window that starts exactly on a line keeps that whole line', () => {
  const filler = JSON.stringify(assistant('a'.repeat(1000))) + '\n';
  const bare = JSON.stringify({ ...ENTRY.scheduled('wake'), pad: '' });
  const line = JSON.stringify({ ...ENTRY.scheduled('wake'), pad: 'q'.repeat(TAIL_BYTES - Buffer.byteLength(bare) - 1) }) + '\n';
  assert.equal(Buffer.byteLength(line), TAIL_BYTES);
  const file = path.join(root, `edge${++n}.jsonl`);
  fs.writeFileSync(file, filler + line);
  // Dropped as a cut line, this would be "no labels": a turn. Kept, it is the scheduled wake.
  assert.equal(transcriptOrigin('wake', file), 'other');
});

test('the stuck nudge follows the same decision', () => {
  const said = "I'm stuck on the migration";
  const typed = run(said, transcript([ENTRY.typed(said)]));
  assert.match(typed.stdout, /they are stuck/);
  const sched = run(said, transcript([ENTRY.typed('earlier'), ENTRY.scheduled(said)]));
  assert.doesNotMatch(sched.stdout, /they are stuck/);
  assert.equal(sched.recorded, false);
});

test('nothing from the transcript is written or printed', () => {
  const secret = 'SECRET-PROMPT-TEXT-1234';
  const file = transcript([ENTRY.typed(`earlier ${secret}`), ENTRY.typed(secret)]);
  const r = run(secret, file);
  assert.equal(r.recorded, true);
  assert.doesNotMatch(r.stdout, /SECRET-PROMPT/);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(r.dir)) {
    const body = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(body, /SECRET-PROMPT|earlier/, f);
    if (/\.json$/.test(f) && f.includes(`${path.sep}turns${path.sep}`)) assert.deepEqual(Object.keys(JSON.parse(body)), ['at']);
  }
});

test('the installed copy (the file alone in another folder) makes the same decision', () => {
  const home = path.join(root, `installed${++n}`, 'hooks');
  fs.mkdirSync(home, { recursive: true });
  const copy = path.join(home, 'arrival-hook.cjs');
  fs.copyFileSync(HOOK, copy);
  assert.equal(run('send it', transcript([ENTRY.typed('x'), ENTRY.scheduled('send it')]), { hook: copy }).recorded, false);
  assert.equal(run('send it', transcript([ENTRY.scheduled('x'), ENTRY.typed('send it')]), { hook: copy }).recorded, true);
});

test('personPrompt never throws', () => {
  for (const input of [null, undefined, {}, { prompt: 'x', transcript_path: {} }, { prompt: 'x', transcript_path: '\0bad' }]) {
    assert.doesNotThrow(() => personPrompt(input));
  }
});
