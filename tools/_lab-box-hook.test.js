'use strict';
// The lab's Send box hook (lab/box-hook.cjs) and how the population runner
// counts boxes. Nothing here starts Claude Code: the person-player is a tiny
// shell stub (--human-cmd), and the hook is run the way Claude Code runs an
// Elicitation hook (JSON on stdin, the answer on stdout).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'lab', 'box-hook.cjs');
const lab = () => import(path.join(ROOT, 'lab', 'population.mjs'));
const player = () => import(path.join(ROOT, 'lab', 'player.mjs'));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-hook-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let n = 0;

/** Run the hook with a stub player command; returns { action, log, out }. */
function runHook({ cmd, message = 'Send to @ben now? (18 characters)\nthe lease fixed it', input, ctx = {}, env = {} }) {
  const k = ++n;
  const ctxFile = path.join(DIR, `ctx-${k}.json`);
  const logFile = path.join(DIR, `boxes-${k}.jsonl`);
  const emptyDir = fs.mkdtempSync(path.join(DIR, 'empty-'));
  fs.writeFileSync(ctxFile, JSON.stringify({ name: 'Ada', role: 'engineer', persona: 'terse, careful', handle: 'ada', typed: 'tell ben the lease fixed it', earlier: 'You typed: hi', emptyDir, timeoutMs: 10000, player: { cmd }, ...ctx }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS || '', VIBE_LAB_BOX_CONTEXT: ctxFile, VIBE_LAB_BOX_LOG: logFile, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let o = null; try { o = JSON.parse(out); } catch {}
      let log = [];
      try { log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      resolve({ code, out, o, action: o && o.hookSpecificOutput && o.hookSpecificOutput.action, log });
    });
    child.stdin.end(input !== undefined ? input : JSON.stringify({ hook_event_name: 'Elicitation', mcp_server_name: 'vibe', message, requested_schema: { type: 'object', properties: {} } }));
  });
}

test('the player presses Accept: the hook answers accept, in the hook output shape, and logs the box', async () => {
  const r = await runHook({ cmd: 'cat > /dev/null; echo \'{"press":"accept","why":"that is what I asked for"}\'' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.o, { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: {} } });
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].message, 'Send to @ben now? (18 characters)\nthe lease fixed it');
  assert.equal(r.log[0].decision, 'accept');
  assert.equal(r.log[0].why, 'that is what I asked for');
});

test('the player presses Decline: decline', async () => {
  const r = await runHook({ cmd: 'cat > /dev/null; echo \'```json\n{"press":"Decline","why":"not now"}\n```\'' });
  assert.equal(r.action, 'decline');
  assert.equal(r.log[0].decision, 'decline');
  assert.equal(r.log[0].error, undefined);
});

for (const [name, opts, error] of [
  ['the player exits non-zero', { cmd: 'cat > /dev/null; echo \'{"press":"accept","why":"x"}\'; exit 2' }, 'player failed'],
  ['the player answers something else', { cmd: 'cat > /dev/null; echo \'{"press":"maybe","why":"x"}\'' }, 'player answer unreadable'],
  ['the player answers no JSON', { cmd: 'cat > /dev/null; echo yes' }, 'player answer unreadable'],
  ['the player times out', { cmd: 'cat > /dev/null; sleep 5; echo \'{"press":"accept"}\'', ctx: { timeoutMs: 200 } }, 'player timed out'],
  ['the hook deadline passes', { cmd: 'cat > /dev/null; sleep 5; echo \'{"press":"accept"}\'', env: { VIBE_LAB_BOX_DEADLINE_MS: '300' } }, 'timeout'],
  ['the hook input is not JSON', { cmd: 'echo \'{"press":"accept"}\'', input: 'not json' }, 'hook input is not JSON'],
  ['the hook input has no message', { cmd: 'echo \'{"press":"accept"}\'', input: JSON.stringify({ hook_event_name: 'Elicitation' }) }, 'no box message in the hook input'],
  ['there is no context file', { cmd: 'echo \'{"press":"accept"}\'', env: { VIBE_LAB_BOX_CONTEXT: path.join(DIR, 'missing.json') } }, 'context file unreadable'],
]) {
  test(`${name}: decline`, async () => {
    const r = await runHook(opts);
    assert.equal(r.code, 0);
    assert.equal(r.action, 'decline');
    assert.equal(r.log.length, 1);
    assert.equal(r.log[0].decision, 'decline');
    assert.equal(r.log[0].error, error);
  });
}

test('the player is asked with the persona, what they typed, and the box as the host draws it; it sees no /vibe variables', async () => {
  const rec = path.join(DIR, 'rec');
  fs.mkdirSync(rec, { recursive: true });
  const message = 'Send to @ben now? (40 characters)\nline two\nline three\nline four\nline five';
  const cmd = `cat > ${JSON.stringify(path.join(rec, 'stdin.txt'))}; env > ${JSON.stringify(path.join(rec, 'env.txt'))}; echo '{"press":"decline","why":"t"}'`;
  const r = await runHook({ cmd, message, env: { VIBE_HOME: '/nope/.vibe', SLASHVIBE_X: 'y' } });
  assert.equal(r.action, 'decline');
  const stdin = fs.readFileSync(path.join(rec, 'stdin.txt'), 'utf8');
  const { HUMAN_SYSTEM } = await player();
  assert.ok(stdin.startsWith(`${HUMAN_SYSTEM}\n\n`));
  for (const s of ['You are Ada (@ada), engineer.', 'About you: terse, careful', 'tell ben the lease fixed it', 'Earlier in this same Claude Code session:\nYou typed: hi',
    'MCP server "vibe" requests your input\nSend to @ben now? (40 characters)\nline two\nline three\n… (+2 more lines)\n[ Accept ]   [ Decline ]', 'Do you, Ada, press Accept or Decline?']) {
    assert.ok(stdin.includes(s), s);
  }
  assert.ok(!stdin.includes('line four'), 'only what the host shows');
  const env = fs.readFileSync(path.join(rec, 'env.txt'), 'utf8');
  assert.doesNotMatch(env, /^(VIBE_|SLASHVIBE_)/m);
});

test('parseBox reads only accept or decline', async () => {
  const { parseBox } = await player();
  assert.deepEqual(parseBox('{"press":"accept","why":"w"}'), { press: 'accept', why: 'w' });
  assert.deepEqual(parseBox('sure: {"press":" DECLINE "}'), { press: 'decline', why: '' });
  for (const bad of ['', 'accept', '{"press":"yes"}', '{"reply":"accept"}', '{"press":1}']) assert.equal(parseBox(bad), null, bad);
});

// ── the runner ───────────────────────────────────────────────────────────────

test('installBoxHook adds an Elicitation hook for the lab server running box-hook.cjs; the context file holds no /vibe credentials', async () => {
  const { installBoxHook, writeBoxContext, readBoxLog } = await lab();
  const settings = path.join(DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [] }] } }));
  const id = { boxContext: path.join(DIR, 'ctx-run.json'), boxLog: path.join(DIR, 'log-run.jsonl') };
  const s = installBoxHook(settings, id);
  assert.ok(s.hooks.UserPromptSubmit, 'other hooks kept');
  assert.equal(s.hooks.Elicitation.length, 1);
  assert.equal(s.hooks.Elicitation[0].matcher, 'vibe');
  const cmd = s.hooks.Elicitation[0].hooks[0].command;
  assert.ok(cmd.includes('box-hook.cjs') && cmd.includes(id.boxContext) && cmd.includes(id.boxLog));
  const ctx = writeBoxContext(id, { person: { name: 'Ada', role: 'r', persona: 'p', says: 's' }, handle: 'ada', typed: 't', earlier: '', opts: { humanCmd: 'my-player', humanModel: 'sonnet' }, emptyDir: DIR, emptyMcp: '/x.json' });
  assert.deepEqual(ctx.player, { cmd: 'my-player' });
  assert.equal(fs.statSync(id.boxContext).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(id.boxContext, 'utf8'), /VIBE_|token/i);
  fs.writeFileSync(id.boxLog, '{"message":"To @ben: a","decision":"accept"}\nnot json\n{"message":"To @ben: b","decision":"decline"}\n');
  assert.deepEqual(readBoxLog(id.boxLog).map((b) => b.decision), ['accept', 'decline']);
});

test('the box refusals are counted as refused: nothing went out', async () => {
  const { sendOutcome } = await lab();
  for (const t of [
    'Not sent. It is still a draft for @ben. Do not send it again unless they ask.',
    'Not sent: the /vibe account signed in here changed while the confirmation box was open.',
    'Not sent: another /vibe confirmation box is open. Wait until it is answered.',
    'Not sent: the draft to @ben changed while the confirmation box was open. Show it again with vibe_prepare.',
    "Not sent: a hook on this machine is set to answer /vibe's confirmation box (~/.claude/settings.json). Remove it to send.",
  ]) assert.equal(sendOutcome(t), 'refused', t);
});

test('a send that went out after an accepted box is not unattended; one without a box or a reply is', async () => {
  const { analyse } = await lab();
  const ev = [];
  const at = (e) => { const x = { i: ev.length, who: 'ada', day: 1, entry: 0, session_id: 's1', ...e }; ev.push(x); return x; };
  let k = 0;
  const call = (tool, input, text) => { const id = `t${++k}`; at({ kind: 'tool', name: `mcp__vibe__${tool}`, id, input }); at({ kind: 'returned', tool_use_id: id, name: `mcp__vibe__${tool}`, text }); };
  const preview = (d) => `Send to @ben · Edit · Cancel — nothing has been sent.  _(draft ${d} · rev r1)_`;
  at({ kind: 'prompt', text: 'tell ben', session: 'new' });
  // b1: shown, Send called, box declined: refused.
  call('vibe_prepare', { handle: 'ben', message: 'one' }, preview('b1'));
  call('vibe_send', { id: 'b1', rev: 'r1' }, 'Not sent. It is still a draft for @ben. Do not send it again unless they ask.');
  // b2: shown, Send called, box accepted: sent.
  call('vibe_prepare', { handle: 'ben', message: 'two' }, preview('b2'));
  call('vibe_send', { id: 'b2', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_2_');
  // b3: sent with neither a box nor a reply.
  call('vibe_prepare', { handle: 'ben', message: 'three' }, preview('b3'));
  call('vibe_send', { id: 'b3', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_3_');
  // The runner folds the turn's boxes after its events.
  at({ kind: 'box', text: 'Send to @ben now? (3 characters)\none', decision: 'decline', simulator_only: { why: 'no' } });
  at({ kind: 'box', text: 'Send to @ben now? (3 characters)\ntwo', decision: 'accept', simulator_only: { why: 'yes' } });
  const s = analyse({ world: { id: 'w', archetype: 'a', relationship: 'established', open_line: false, timeline: [{}] }, transcript: ev, turnsLog: [], wire: [], handles: ['ada', 'ben'], started: Date.now() });
  assert.equal(s.boxes_shown, 2);
  assert.equal(s.boxes_accepted, 1);
  assert.equal(s.boxes_declined, 1);
  assert.equal(s.refused_sends.count, 1);
  assert.equal(s.sends_after_an_accepted_box.count, 1);
  assert.equal(s.sends_after_an_accepted_box.list[0].draft, 'b2');
  assert.deepEqual(s.sends_without_human_reply_between_prepare_and_send.list.map((x) => x.draft), ['b3'], 'one accepted box covers one send');
});

test('--no-box runs the turn-check path; the summary records which path a run took', async () => {
  const { parseArgs, writePopulation } = await lab();
  assert.equal(parseArgs(['w.json', '--out', 'o']).noBox, false);
  assert.equal(parseArgs(['w.json', '--out', 'o', '--no-box']).noBox, true);
  const out = fs.mkdtempSync(path.join(DIR, 'pop-'));
  const agg = writePopulation(out, [{ file: 'w.json', id: 'w', summary: { id: 'w', archetype: 'a', box_path: false, sends_on_wire: 2, boxes_shown: 0 } }], { noBox: true });
  assert.equal(agg.box_path, false);
  assert.deepEqual(agg.failed, []);
  assert.match(fs.readFileSync(path.join(out, 'population-summary.md'), 'utf8'), /Send box: off \(--no-box/);
});

test('on the box path, sends on the wire with no box shown is FAILED, loudly', async () => {
  const { boxExpectationFailure, writePopulation } = await lab();
  assert.match(boxExpectationFailure({ box_path: true, sends_on_wire: 3, boxes_shown: 0 }), /^FAILED: 3 send\(s\) went out on the box path and no Send box was shown$/);
  assert.equal(boxExpectationFailure({ box_path: true, sends_on_wire: 3, boxes_shown: 1 }), null);
  assert.equal(boxExpectationFailure({ box_path: true, sends_on_wire: 0, boxes_shown: 0 }), null, 'nothing went out: nothing to check');
  assert.equal(boxExpectationFailure({ box_path: false, sends_on_wire: 3, boxes_shown: 0 }), null, '--no-box expects none');
  const out = fs.mkdtempSync(path.join(DIR, 'pop-'));
  const summary = { id: 'w', archetype: 'a', box_path: true, sends_on_wire: 3, boxes_shown: 0, failed: boxExpectationFailure({ box_path: true, sends_on_wire: 3, boxes_shown: 0 }) };
  const agg = writePopulation(out, [{ file: 'w.json', id: 'w', summary }], {});
  assert.equal(agg.box_path, true);
  assert.equal(agg.failed.length, 1, 'the run exits non-zero');
  assert.match(agg.failed[0].error, /no Send box was shown/);
  assert.match(fs.readFileSync(path.join(out, 'population-summary.md'), 'utf8'), /## Failed[\s\S]*no Send box was shown/);
});

test('box-hook.cjs reads the documented hook input field `message` first', async () => {
  const { boxMessage } = require(HOOK);
  assert.equal(boxMessage({ message: 'documented', elicitation: { message: 'other' }, params: { message: 'third' } }), 'documented');
});
