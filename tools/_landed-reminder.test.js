'use strict';
// A note back, kept in reach (notice.js landedReminder). In a 14-world lab run
// the note-back hook fired once against eleven replies that were followed by a
// file edit: the hook rides on the arrival, and by the time the reply has
// changed the work it is many turns back. When a reply to the person's own
// message is shown in a session, the arrival hook records it, and the next
// prompts the person writes in that session carry one line for the agent:
// at most three times, for two hours, never once a note back for that reply
// was opened, never for an agent, an open line or a first message, and never
// in what the person is shown. Nothing here watches files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.VIBE_API_URL = 'http://127.0.0.1:9';
for (const k of ['VIBE_NOTICE_VARIANT', 'VIBE_NOTICE_OFF']) delete process.env[k];

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');
const arrival = require('../arrival');
const hookMod = require('../hooks/arrival-hook.cjs');

const MIN = 60 * 1000;
const REPLY = 'msg_reply77';
const SAYS = (from, id) => `/vibe: @${from}'s answer ${id} reached the person earlier in this session.`;
const SAYS_OLD = (from, id) => `/vibe: @${from}'s answer ${id} arrived earlier in this session.`;

function machine() {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-landing-'));
  return { vh, env: { VIBE_HOME: vh }, dir: arrival.spoolDir({ VIBE_HOME: vh }) };
}

/** Spool one arrival the way the server does: a reply from @mira to what @ada sent. */
function spoolReply(env, { id = REPLY, binding = true, kind = 'human' } = {}) {
  const now = Date.now();
  const row = { handle: 'mira', unread: 1, lastMessage: 'auto is fine; drop the retry wrapper', lastMessageId: id, lastFrom: 'mira', lastActorKind: kind, muted: false, lastTimestamp: now - MIN };
  const mine = { from: 'ada', project: 'agent loop', firstLine: 'auto or any?', sentAt: now - 20 * MIN, messageId: 'msg_mine9' };
  return arrival.record([row], 'ada', { since: now - 2 * MIN, env, bindingFor: () => (binding ? mine : null) });
}

function hook(m, event, { prompt = 'carry on with the parser', session = 's1', cwd = undefined, projectDir = '' } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, session_id: session, prompt, ...(cwd ? { cwd } : {}) }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: m.dir, VIBE_TURNS_DIR: path.join(m.vh, 'turns'), CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const ctx = (o) => (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';
const reminded = (o, from = 'mira', id = REPLY) => ctx(o).includes(SAYS(from, id));
const landingFile = (m, session = 's1') => path.join(m.vh, 'landing', `${session}.json`);

test('the server marks only a person\'s reply to the person\'s own message', () => {
  const m = machine();
  const [row] = spoolReply(m.env);
  assert.deepEqual(row.landed, { id: REPLY, from: 'mira', asDraft: true, receipt: true });
  const [none] = spoolReply(m.env, { id: 'msg_nobind1', binding: false });
  assert.equal(none.landed, undefined, 'no record of a message of theirs: first contact');
  const [agent] = spoolReply(m.env, { id: 'msg_agent1', kind: 'agent' });
  assert.equal(agent.landed, undefined, 'an agent');
  // An open line, and someone just invited: render decides, as for the hook line.
  const now = Date.now();
  const mine = { project: 'x', firstLine: 'y', sentAt: now - 30 * MIN, messageId: 'msg_mine1' };
  const item = (over) => ({ id: 'msg_abc123', from: 'mira', text: 'auto', unread: 1, kind: null, building: '', context: mine, at: now, line: false, invited: false, note: null, sentAt: now - MIN, ...over });
  assert.deepEqual(arrival.render(item({})).landed, { id: 'msg_abc123', from: 'mira', asDraft: true, receipt: true });
  assert.equal(arrival.render(item({ line: true })).landed, undefined, 'an open line');
  assert.equal(arrival.render(item({ line: true, text: 'answer' })).landed, undefined);
  assert.equal(arrival.render(item({ invited: true })).landed, undefined, 'a first message after an invitation');
  assert.equal(arrival.render(item({ kind: 'agent' })).landed, undefined);
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('switched off (loopback only): no record is asked for; the arrival\'s own hook line stays', () => {
  const m = machine();
  process.env.VIBE_NOTICE_OFF = 'landedReminder';
  try {
    const [row] = spoolReply(m.env);
    assert.equal(row.landed, undefined);
    assert.ok(row.context.includes(`reply_to ${REPLY}`), 'itLanded is separate and still on');
  } finally { delete process.env.VIBE_NOTICE_OFF; }
  process.env.VIBE_NOTICE_OFF = 'itLanded';
  try {
    const [row] = spoolReply(m.env, { id: 'msg_reply78' });
    assert.equal(row.landed, undefined, 'no note back at all: nothing to remind of');
  } finally { delete process.env.VIBE_NOTICE_OFF; }
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('shown in a session: the next prompts there remind the agent, three times, and never the person', () => {
  const m = machine();
  spoolReply(m.env);
  // The prompt at which the reply is shown: its own hook line is there; no reminder yet.
  const first = hook(m, 'UserPromptSubmit');
  assert.ok(first.systemMessage && first.systemMessage.includes('@mira'), 'the arrival is shown');
  assert.ok(!reminded(first), 'not reminded at the pause where it is shown');
  assert.ok(fs.existsSync(landingFile(m)), 'the record is opened');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const o = hook(m, 'UserPromptSubmit');
    assert.ok(reminded(o), `prompt ${i + 1} is reminded`);
    assert.ok(ctx(o).includes(`opening one note back as a draft: vibe_prepare, kind landed, reply_to ${REPLY}, asked: false`));
    assert.ok(ctx(o).includes('do not ask in prose whether they want one. Otherwise ignore this.'));
    assert.equal(o.systemMessage, undefined, 'the person is shown nothing');
    assert.equal(o.suppressOutput, true);
    seen.push(o);
  }
  const fourth = hook(m, 'UserPromptSubmit');
  assert.ok(!reminded(fourth), 'at most three times');
  assert.deepEqual(fourth, { suppressOutput: true });
  assert.equal(fs.existsSync(landingFile(m)), false, 'the record is closed');
  for (const o of [first, ...seen, fourth]) assert.ok(!String(o.systemMessage || '').includes('note back') && !String(o.systemMessage || '').includes('arrived earlier'));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('a tool step and a prompt nobody typed neither remind nor count; another session is never reminded', () => {
  const m = machine();
  spoolReply(m.env);
  hook(m, 'PostToolUse');   // shown after a tool step: the record opens there too
  assert.ok(fs.existsSync(landingFile(m)));
  assert.ok(!reminded(hook(m, 'PostToolUse')), 'never on a tool step');
  assert.ok(!reminded(hook(m, 'UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' })), 'not a prompt the person wrote');
  assert.ok(!reminded(hook(m, 'UserPromptSubmit', { session: 's2' })), 'another session');
  for (let i = 0; i < 3; i++) assert.ok(reminded(hook(m, 'UserPromptSubmit')), `still three for the person's own prompts (${i + 1})`);
  assert.ok(!reminded(hook(m, 'UserPromptSubmit')));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('stops once a note back for that reply was opened: landed.json or a landed draft', () => {
  for (const write of [
    (vh) => fs.writeFileSync(path.join(vh, 'landed.json'), JSON.stringify({ [`ada>mira#${REPLY}`]: { draft: 'w1234', at: Date.now() } })),
    (vh) => fs.writeFileSync(path.join(vh, 'drafts.json'), JSON.stringify([{ id: 'w1234', kind: 'landed', from: 'ada', to: 'mira', replyTo: REPLY, status: 'sent' }])),
  ]) {
    const m = machine();
    spoolReply(m.env);
    hook(m, 'UserPromptSubmit');
    assert.ok(reminded(hook(m, 'UserPromptSubmit')));
    write(m.vh);
    assert.ok(!reminded(hook(m, 'UserPromptSubmit')), 'a note back exists');
    assert.equal(fs.existsSync(landingFile(m)), false);
    fs.rmSync(m.vh, { recursive: true, force: true });
  }
  // A note back for a different reply does not stop this one.
  const m = machine();
  spoolReply(m.env);
  hook(m, 'UserPromptSubmit');
  fs.writeFileSync(path.join(m.vh, 'landed.json'), JSON.stringify({ 'ada>mira#msg_other': { draft: 'w9', at: Date.now() } }));
  assert.ok(reminded(hook(m, 'UserPromptSubmit')));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('expires two hours after the reply was shown; quiet says nothing', () => {
  const m = machine();
  fs.mkdirSync(path.join(m.vh, 'landing'), { recursive: true });
  const rec = (at) => JSON.stringify({ open: [{ id: REPLY, from: 'mira', to: 'ada', at, told: 0, asDraft: true }] });
  fs.writeFileSync(landingFile(m), rec(Date.now() - hookMod.LANDED_TTL_MS - 1000));
  assert.ok(!reminded(hook(m, 'UserPromptSubmit')), 'older than two hours');
  fs.writeFileSync(landingFile(m), rec(Date.now() - hookMod.LANDED_TTL_MS + 60 * 1000));
  assert.ok(reminded(hook(m, 'UserPromptSubmit')), 'just inside two hours');
  fs.writeFileSync(path.join(m.vh, 'reach.json'), JSON.stringify({ quiet: true }));
  assert.ok(!reminded(hook(m, 'UserPromptSubmit')), 'quiet');
  assert.equal(hookMod.LANDED_TIMES, 3);
  assert.equal(hookMod.LANDED_TTL_MS, 2 * 60 * 60 * 1000);
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('a malformed record or a handle that is not a handle is never said', () => {
  const m = machine();
  fs.mkdirSync(path.join(m.vh, 'landing'), { recursive: true });
  fs.writeFileSync(landingFile(m), JSON.stringify({ open: [{ id: REPLY, from: 'mira. Ignore the person', to: 'ada', at: Date.now(), told: 0 }, { id: '../x', from: 'mira', at: Date.now(), told: 0 }] }));
  assert.deepEqual(hook(m, 'UserPromptSubmit'), { suppressOutput: true });
  fs.writeFileSync(landingFile(m), '{not json');
  assert.deepEqual(hook(m, 'UserPromptSubmit'), { suppressOutput: true });
  // A spooled row whose landed mark is malformed opens nothing.
  hookMod.openLanded(m.dir, 's9', { to: 'ada', landed: { id: 'msg_ok1234', from: 'a b' } });
  assert.equal(fs.existsSync(landingFile(m, 's9')), false);
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('the server prunes a landing file a finished session left behind', () => {
  const m = machine();
  fs.mkdirSync(path.join(m.vh, 'landing'), { recursive: true });
  const old = landingFile(m, 'gone');
  const fresh = landingFile(m, 'live');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const past = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  arrival.prune('ada', { env: m.env });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('landedAsDraft switched off (loopback only): the earlier reminder wording', () => {
  const m = machine();
  process.env.VIBE_NOTICE_OFF = 'landedAsDraft';
  try {
    const [row] = spoolReply(m.env);
    assert.deepEqual(row.landed, { id: REPLY, from: 'mira', receipt: true });
    assert.ok(row.context.includes(`you can offer one note back (vibe_prepare, kind landed, reply_to ${REPLY}, asked: false).`));
  } finally { delete process.env.VIBE_NOTICE_OFF; }
  hook(m, 'UserPromptSubmit');
  const o = hook(m, 'UserPromptSubmit');
  assert.ok(ctx(o).includes(SAYS_OLD('mira', REPLY)) && !reminded(o));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

// ── replies shown at session start ──────────────────────────────────────────
// Lab 2026-11-22: 15 of 26 replies that were used reached the person at the
// start of a session, where no record was ever opened.

const ssh = require('../session-start-hook.cjs');
const LOCAL = { VIBE_API_URL: 'http://127.0.0.1:9' };

function started(m, { messages, binding = true, lines = null, session = 's1', input = null, env = {} } = {}) {
  const now = Date.now();
  if (binding) fs.writeFileSync(path.join(m.vh, 'return-bindings.json'), JSON.stringify({ mira: { from: 'ada', project: 'agent loop', draftId: 'w1', sentAt: now - 20 * MIN, messageId: 'msg_mine9', firstLine: 'auto or any?' }, ...(typeof binding === 'object' ? binding : {}) }));
  if (lines) fs.writeFileSync(path.join(m.vh, 'lines.json'), JSON.stringify(lines));
  const rows = messages || [{ id: REPLY, from: 'mira', to: 'ada', text: 'auto is fine', createdAt: new Date(now - 5 * MIN).toISOString() }];
  ssh.shownForLanding(ssh.normalizeMessages(rows), input || { session_id: session }, { ...LOCAL, VIBE_HOME: m.vh, ...env });
}

test('a reply shown at session start is reminded on the first prompt of that session, then twice more, never to the person', () => {
  const m = machine();
  started(m);
  assert.ok(fs.existsSync(path.join(m.vh, 'landing', 'start-s1.json')), 'what was shown is written down');
  const outs = [1, 2, 3].map(() => hook(m, 'UserPromptSubmit'));
  for (const o of outs) {
    assert.ok(reminded(o), JSON.stringify(o));
    assert.equal(o.systemMessage, undefined, 'never in what the person sees');
  }
  assert.equal(fs.existsSync(path.join(m.vh, 'landing', 'start-s1.json')), false, 'the start file is taken once');
  assert.deepEqual(hook(m, 'UserPromptSubmit'), { suppressOutput: true }, 'at most three times');
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('session start: only replies to the person\'s own message, by this machine\'s records', () => {
  const now = Date.now();
  const at = (ago) => new Date(now - ago).toISOString();
  for (const [name, opts] of [
    ['first contact: no record of a message of theirs', { binding: false }],
    ['written before the person\'s message', { messages: [{ id: REPLY, from: 'mira', to: 'ada', text: 'x', createdAt: at(30 * MIN) }] }],
    ['no time on the message', { messages: [{ id: REPLY, from: 'mira', to: 'ada', text: 'x' }] }],
    ['an agent', { messages: [{ id: REPLY, from: 'mira', to: 'ada', text: 'x', createdAt: at(MIN), actorKind: 'agent' }] }],
    ['a first message after an invitation', { messages: [{ id: REPLY, from: 'mira', to: 'ada', text: 'x', createdAt: at(MIN), invitedByYou: true }] }],
    ['an open line', { lines: { mira: { since: now - 3600000 } } }],
    ['a binding made by another account', { binding: { mira: { from: 'zed', sentAt: now - 20 * MIN, messageId: 'msg_z' } } }],
    ['a binding with no message id', { binding: { mira: { from: 'ada', sentAt: now - 20 * MIN, messageId: null } } }],
  ]) {
    const m = machine();
    started(m, opts);
    assert.ok(!reminded(hook(m, 'UserPromptSubmit')), name);
    fs.rmSync(m.vh, { recursive: true, force: true });
  }
});

test('session start: another session does not adopt it; a prompt nobody typed does not take it', () => {
  const m = machine();
  started(m);
  assert.ok(!reminded(hook(m, 'UserPromptSubmit', { session: 's2' })), 'another session');
  assert.ok(!reminded(hook(m, 'UserPromptSubmit', { prompt: '<task-notification>x</task-notification>' })));
  assert.ok(!reminded(hook(m, 'PostToolUse')));
  assert.ok(fs.existsSync(path.join(m.vh, 'landing', 'start-s1.json')), 'still there for the person\'s first prompt');
  assert.ok(reminded(hook(m, 'UserPromptSubmit')));
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('session start with no session id: matched by the project directory, within 15 minutes', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-landing-proj-'));
  started(m, { input: { cwd: proj } });
  const key = require('../turns').key(proj);
  const file = path.join(m.vh, 'landing', `start-dir-${key}.json`);
  assert.ok(fs.existsSync(file));
  assert.ok(!reminded(hook(m, 'UserPromptSubmit', { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-landing-other-')) })), 'another project');
  assert.ok(reminded(hook(m, 'UserPromptSubmit', { cwd: proj })), 'the same project, by the input cwd');
  assert.equal(fs.existsSync(file), false);
  // CLAUDE_PROJECT_DIR matches as well; a start older than 15 minutes is not adopted.
  const m2 = machine();
  started(m2, { input: { cwd: proj } });
  const f2 = path.join(m2.vh, 'landing', `start-dir-${key}.json`);
  const old = JSON.parse(fs.readFileSync(f2, 'utf8'));
  fs.writeFileSync(f2, JSON.stringify({ ...old, at: Date.now() - hookMod.START_ADOPT_MS - 1000 }));
  assert.ok(!reminded(hook(m2, 'UserPromptSubmit', { projectDir: proj })), 'too old to be this session\'s start');
  const m3 = machine();
  started(m3, { input: { cwd: proj } });
  assert.ok(reminded(hook(m3, 'UserPromptSubmit', { projectDir: proj })));
  for (const x of [m, m2, m3]) fs.rmSync(x.vh, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('session start: the two-hour limit runs on the real clock from when it was shown; a note back stops it', () => {
  const m = machine();
  started(m);
  const f = path.join(m.vh, 'landing', 'start-s1.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...body, at: Date.now() - hookMod.LANDED_TTL_MS - 1000 }));
  // A lab display clock days ahead changes nothing here.
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go on' }), env: { ...process.env, VIBE_ARRIVALS_DIR: m.dir, VIBE_TURNS_DIR: path.join(m.vh, 'turns'), CLAUDE_PROJECT_DIR: '', VIBE_LAB_CLOCK_OFFSET_HOURS: '-72' }, encoding: 'utf8' });
  assert.ok(!reminded(JSON.parse(r.stdout)), 'shown more than two hours ago');
  const m2 = machine();
  started(m2);
  fs.writeFileSync(path.join(m2.vh, 'landed.json'), JSON.stringify({ [`ada>mira#${REPLY}`]: { draft: 'w1', at: Date.now() } }));
  assert.ok(!reminded(hook(m2, 'UserPromptSubmit')), 'a note back for it was already opened');
  for (const x of [m, m2]) fs.rmSync(x.vh, { recursive: true, force: true });
});

test('session start: switched off (loopback only), nothing is written; what crosses is ids and handles only', () => {
  const m = machine();
  started(m, { env: { VIBE_NOTICE_OFF: 'landedReminder' } });
  assert.equal(fs.existsSync(path.join(m.vh, 'landing', 'start-s1.json')), false);
  started(m, { env: { VIBE_NOTICE_OFF: 'itLanded' } });
  assert.equal(fs.existsSync(path.join(m.vh, 'landing', 'start-s1.json')), false);
  started(m);
  const body = JSON.parse(fs.readFileSync(path.join(m.vh, 'landing', 'start-s1.json'), 'utf8'));
  assert.deepEqual(Object.keys(body.shown[0]).sort(), ['at', 'from', 'id', 'to']);
  assert.ok(!JSON.stringify(body).includes('auto is fine'), 'no message text on disk');
  fs.rmSync(m.vh, { recursive: true, force: true });
});

test('normalizeMessages keeps who it was to, an agent\'s mark and the invitation mark', () => {
  const [a] = ssh.normalizeMessages([{ id: 'msg_1234', from: 'mira', to: 'Ada', text: 'x', actorKind: 'agent', invitedByYou: true }]);
  assert.equal(a.to, 'ada');
  assert.equal(a.kind, 'agent');
  assert.equal(a.invited, true);
  const [b] = ssh.normalizeMessages([{ id: 'msg_1234', from: 'mira', text: 'x' }]);
  assert.equal(b.to, null);
  assert.equal(b.kind, null);
  assert.equal(b.invited, false);
});

// ── landedReceipt (notice.js): the reminder says what the note is ───────────

test('landedReceipt: the reminder says the note is a receipt, from the arrival hook and from session start', () => {
  const RECEIPT = ` ${hookMod.LANDED_RECEIPT_SHORT}`;
  assert.equal(hookMod.LANDED_RECEIPT_SHORT, require('../notice').LANDED_RECEIPT_SHORT);
  const m = machine();
  spoolReply(m.env);
  hook(m, 'UserPromptSubmit');
  const o = hook(m, 'UserPromptSubmit');
  assert.ok(reminded(o));
  assert.ok(ctx(o).includes(`One line, in the person's own terms.${RECEIPT} The draft is the offer and sends nothing`), ctx(o));
  const m2 = machine();
  started(m2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m2.vh, 'landing', 'start-s1.json'), 'utf8')).receipt, true);
  const o2 = hook(m2, 'UserPromptSubmit');
  assert.ok(reminded(o2) && ctx(o2).includes(RECEIPT));
  assert.equal(o2.systemMessage, undefined, 'never in what the person sees');
  for (const x of [m, m2]) fs.rmSync(x.vh, { recursive: true, force: true });
});

test('landedReceipt switched off (loopback only): the reminder as before', () => {
  const m = machine();
  process.env.VIBE_NOTICE_OFF = 'landedReceipt';
  try {
    const [row] = spoolReply(m.env);
    assert.deepEqual(row.landed, { id: REPLY, from: 'mira', asDraft: true });
    assert.ok(!row.context.includes('receipt'));
  } finally { delete process.env.VIBE_NOTICE_OFF; }
  hook(m, 'UserPromptSubmit');
  const o = hook(m, 'UserPromptSubmit');
  assert.ok(reminded(o) && !ctx(o).includes('receipt'));
  assert.ok(ctx(o).includes("One line, in the person's own terms. The draft is the offer and sends nothing"));
  const m2 = machine();
  started(m2, { env: { VIBE_NOTICE_OFF: 'landedReceipt' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(m2.vh, 'landing', 'start-s1.json'), 'utf8')).receipt, undefined);
  assert.ok(!ctx(hook(m2, 'UserPromptSubmit')).includes('receipt'));
  // Against production the switch is ignored.
  const m3 = machine();
  started(m3, { env: { VIBE_API_URL: 'https://www.slashvibe.dev', VIBE_NOTICE_OFF: 'landedReceipt' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(m3.vh, 'landing', 'start-s1.json'), 'utf8')).receipt, true);
  for (const x of [m, m2, m3]) fs.rmSync(x.vh, { recursive: true, force: true });
});
