'use strict';
// The Send box: where the host can show one (MCP elicitation), vibe_send sends
// only after BOTH the turn check (the person typed after the draft was last
// shown, in this session) AND an Accept in a box /vibe opened, for the exact
// text, the same rev and the same account.
//
// The turn check alone counts any prompt, even "no, don't send". The box is
// the person's own answer, which the model never sees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';   // never production
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT;
delete process.env.VIBE_AGENT_MINT_FILE;
delete process.env.VIBE_LAB_BOX_HOOK;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-project-'));
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-claude-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.CLAUDE_CONFIG_DIR = USERDIR;
const jwt = (h, extra = {}) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400, ...extra })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const config = require('../config');
const drafts = require('./drafts');
const turns = require('../turns');
const agentAuth = require('../agent-auth');
const confirmBox = require('../confirm-box');

// The turn check is live: the hook has recorded turns for this project.
turns.record(PROJECT, Date.now() - 60_000);
/** The person types something: a turn strictly after everything shown so far. */
function personTurn() { const t = Date.now(); while (Date.now() <= t) { /* next ms */ } turns.record(PROJECT, Date.now()); }
const tick = () => { const t = Date.now(); while (Date.now() <= t) { /* next ms */ } };

async function withWire(fn) {
  const sends = [];
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body, type, payload, opts) => { sends.push({ from, to, body, opts }); return { id: `msg_${sends.length}`, storedLength: body.length }; };
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    return { ok: true, status: 200, json: async () => ({ handle: h, kind: 'human' }) };
  };
  try { await fn(sends); } finally { Object.assign(store, orig); global.fetch = origFetch; }
}

/** A client that answers every box with `answer` (an object, or a function of the params and the call number). */
function fakeBox(answer, { protocolVersion = '2025-11-25', timeoutMs } = {}) {
  const asked = [];
  const box = {
    protocolVersion,
    asked,
    request: async (params, opts) => { asked.push({ params, signal: opts && opts.signal }); return typeof answer === 'function' ? answer(params, asked.length, opts) : answer; },
  };
  if (timeoutMs) box.timeoutMs = timeoutMs;
  return box;
}
const accept = { action: 'accept', content: {} };
const NOT_ACCEPTED = 'Not sent. It is still a draft for @linus. Do not send it again unless they ask.';
const prepare = (o, ctx) => drafts.vibe_prepare.handler({ handle: 'linus', message: 'the lease fixed it', ...o }, ctx);
const sendIn = (p, box, extra = {}) => drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, { box, ...extra });
const status = (p) => drafts.loadDrafts().find((d) => d.id === p.data.draft.id).status;
/** Prepare, then the person types: ready for the box. */
async function shown(o) { const p = await prepare(o); personTurn(); return p; }

function clearSettings() {
  for (const f of [path.join(PROJECT, '.claude', 'settings.json'), path.join(PROJECT, '.claude', 'settings.local.json'), path.join(USERDIR, 'settings.json')]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}
function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test.beforeEach(() => {
  clearSettings(); confirmBox._resetForTest();
  delete process.env.VIBE_LAB_BOX_HOOK; delete process.env.VIBE_AGENT_HANDLE; delete process.env.VIBE_AGENT_MINT;
  agentAuth._resetForTest();
  process.env.VIBE_API_URL = 'http://127.0.0.1:9';
  // No box is left open from an earlier test.
  drafts.transact((all) => { for (const d of all) delete d.box; });
});
test.after(() => { for (const d of [HOME, PROJECT, USERDIR]) fs.rmSync(d, { recursive: true, force: true }); });

// ── both are required ────────────────────────────────────────────────────────

test('a typed turn, then Accept: sends exactly the text in the box', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'cloud owns placement now' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(box.asked.length, 1, 'one box');
    const { params } = box.asked[0];
    assert.equal(params.message, 'Send to @linus now? (24 characters)\ncloud owns placement now');
    assert.deepEqual(params.requestedSchema, { type: 'object', properties: {} });
    assert.equal(params.mode, 'form', '2025-11-25 names the form mode');
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn_check, 'box');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body, 'cloud owns placement now');
    assert.equal(status(p), 'sent');
  });
});

test('on 2025-06-18 the request carries no mode field', async () => {
  await withWire(async () => {
    const p = await shown({ message: 'older protocol' });
    const box = fakeBox(accept, { protocolVersion: '2025-06-18' });
    await sendIn(p, box);
    assert.equal('mode' in box.asked[0].params, false);
  });
});

test('no typed turn since it was shown: refused by the turn check, and no box opens', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'shown and sent in one turn' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'no_turn_since_shown');
    assert.equal(box.asked.length, 0);
    assert.equal(sends.length, 0);
  });
});

test('shown before this session started: refused by the turn check, and no box opens', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'from before the restart' });
    tick();
    turns.recordSessionStart(PROJECT, Date.now(), process.env, 'later-session');
    personTurn();
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'shown_in_earlier_session');
    assert.equal(box.asked.length, 0);
    assert.equal(sends.length, 0);
    fs.rmSync(path.join(turns.turnsDir(), `${turns.key(PROJECT)}.start.json`), { force: true });
  });
});

// ── every answer but Accept reads the same ───────────────────────────────────

for (const [name, answer, boxOpts] of [
  ['decline', { action: 'decline' }],
  ['cancel (Esc, or no keyboard)', { action: 'cancel' }],
  ['an unknown action', { action: 'ACCEPT' }],
  ['no action', { content: {} }],
  ['an empty result', null],
  ['a client error', () => { const e = new Error('Method not found'); e.code = -32601; throw e; }],
  ['a rejected promise', () => Promise.reject(new Error('closed'))],
  ['a timeout', () => new Promise(() => {}), { timeoutMs: 40 }],
]) {
  test(`${name}: not sent, the draft is kept, and the result is the one every non-accept gets`, async () => {
    await withWire(async (sends) => {
      const p = await shown({ message: `answer was ${name}` });
      const box = fakeBox(answer, boxOpts);
      const r = await sendIn(p, box);
      assert.equal(r.display, NOT_ACCEPTED);
      assert.deepEqual(r.data, { sent: false, definite: true, reason: 'box_not_accepted', turn_check: 'box' });
      assert.equal(sends.length, 0);
      assert.equal(status(p), 'previewed');
      if (boxOpts) assert.equal(box.asked[0].signal.aborted, true, 'the box was withdrawn');
      assert.equal(confirmBox.isOpen(), false);
    });
  });
}

test('the timeout is five minutes', () => {
  assert.equal(confirmBox.TIMEOUT_MS, 5 * 60 * 1000);
});

// ── one box per draft per showing and person turn ────────────────────────────

test('after a non-accept, no new box until vibe_prepare shows it again AND the person types after that', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'maybe not' });
    const box = fakeBox({ action: 'decline' });
    await sendIn(p, box);
    personTurn();
    const again = await sendIn(p, box);
    assert.equal(again.display, NOT_ACCEPTED, 'a turn alone does not re-arm it');
    assert.equal(box.asked.length, 1);
    await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    const selfShown = await sendIn(p, box);
    assert.equal(selfShown.data.turn_check, 'needs_turn', 'shown again by the agent, nobody typed');
    assert.equal(box.asked.length, 1);
    personTurn();
    const ok = await sendIn(p, fakeBox(accept));
    assert.equal(ok.data.sent, true);
    assert.deepEqual(sends.map((s) => s.body), ['maybe not']);
  });
});

test('the reviewer\'s loop: five cancels then an accept, in one turn: one box, nothing sent', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'try until it goes' });
    const box = fakeBox((params, n) => (n <= 5 ? { action: 'cancel' } : accept));
    for (let i = 0; i < 6; i++) {
      const r = await sendIn(p, box);
      assert.equal(r.display, NOT_ACCEPTED);
    }
    assert.equal(box.asked.length, 1, 'one box for the one showing');
    assert.equal(sends.length, 0);
  });
});

test('the reviewer\'s loop: 19 declines, each followed by the agent\'s own vibe_prepare: one box, nothing sent', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'ask again and again' });
    const box = fakeBox({ action: 'decline' });
    for (let i = 0; i < 19; i++) {
      await sendIn(p, box);
      await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    }
    assert.equal(box.asked.length, 1);
    assert.equal(sends.length, 0);
  });
});

// ── what changes while the box is open ──────────────────────────────────────

test('an edit while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'the first words' });
    const box = fakeBox(async () => {
      await drafts.vibe_prepare.handler({ id: p.data.draft.id, message: 'different words' });
      return accept;
    });
    const r = await sendIn(p, box);
    assert.equal(r.display, 'Not sent: the draft to @linus changed while the confirmation box was open. Show it again with vibe_prepare.');
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed');
  });
});

test('the same text shown again while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'shown twice' });
    const box = fakeBox(async () => { tick(); await drafts.vibe_prepare.handler({ id: p.data.draft.id }); return accept; });
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'changed_while_open');
    assert.equal(sends.length, 0);
  });
});

test('a cancel of the draft while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'cancel me midway' });
    const box = fakeBox(async () => { await drafts.vibe_discard.handler({ id: p.data.draft.id }); return accept; });
    const r = await sendIn(p, box);
    assert.equal(r.data.sent, false);
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'cancelled');
  });
});

test('the signed-in account changes while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'as ada only' });
    const orig = config.getHandle;
    const box = fakeBox(async () => { config.getHandle = () => 'mallory'; return accept; });
    let r;
    try { r = await sendIn(p, box); } finally { config.getHandle = orig; }
    assert.equal(r.display, 'Not sent: the /vibe account signed in here changed while the confirmation box was open.');
    assert.equal(sends.length, 0);
  });
});

test('the call is cancelled while the box is open: the box is withdrawn and Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'cancelled call' });
    const ctl = new AbortController();
    let release;
    const box = fakeBox(() => new Promise((resolve) => { release = () => resolve(accept); }));
    const pending = sendIn(p, box, { signal: ctl.signal });
    await new Promise((r) => setImmediate(r));
    ctl.abort();
    release();
    const r = await pending;
    assert.equal(r.data.sent, false);
    assert.equal(box.asked[0].signal.aborted, true);
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed');
  });
});

test('a second vibe_send while a box is open is refused; the first still goes on Accept', async () => {
  await withWire(async (sends) => {
    const a = await prepare({ message: 'first box' });
    const b = await prepare({ message: 'second box' });
    personTurn();
    let release;
    const first = sendIn(a, fakeBox(() => new Promise((resolve) => { release = () => resolve(accept); })));
    await new Promise((r) => setImmediate(r));
    assert.equal(confirmBox.isOpen(), true);
    const box2 = fakeBox(accept);
    const second = await sendIn(b, box2);
    assert.equal(second.display, 'Not sent: another /vibe confirmation box is open. Wait until it is answered.');
    assert.equal(box2.asked.length, 0);
    release();
    const r = await first;
    assert.equal(r.data.sent, true);
    assert.deepEqual(sends.map((s) => s.body), ['first box']);
    assert.equal(status(b), 'previewed');
  });
});

test('a second initialize while a box is open does not change whether a box is available until it closes', async () => {
  confirmBox.noteClient({ protocolVersion: '2025-11-25', capabilities: { elicitation: {} } });
  let during = null;
  const box = fakeBox(() => { confirmBox.noteClient({ protocolVersion: '2025-11-25', capabilities: {} }); during = confirmBox.available(); return { action: 'decline' }; });
  await confirmBox.ask(box, 'x');
  assert.equal(during, true, 'unchanged while open');
  assert.equal(confirmBox.available(), false, 'the latest initialize applies after');
});

// ── no box: the turn check, unchanged ────────────────────────────────────────

test('without a box (the client declared none) the turn check applies as before', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'no box here' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(sends.length, 0);
    personTurn();
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(ok.data.sent, true);
  });
});

test('capabilities: a box only for form elicitation, declared at initialize, in 2025-06-18 or 2025-11-25', () => {
  const cases = [
    [{ protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } } }, true],
    [{ protocolVersion: '2025-11-25', capabilities: { elicitation: {} } }, true],
    [{ protocolVersion: '2025-11-25', capabilities: { elicitation: { url: {} } } }, false],
    [{ protocolVersion: '2025-06-18', capabilities: { elicitation: {} } }, true],
    [{ protocolVersion: '2025-03-26', capabilities: { elicitation: {} } }, false],
    [{ protocolVersion: '2024-11-05', capabilities: { elicitation: {} } }, false],
    [{ protocolVersion: '2025-11-25', capabilities: {} }, false],
    [{ protocolVersion: '2025-11-25' }, false],
    [{ protocolVersion: '2025-11-25', capabilities: { elicitation: true } }, false],
  ];
  for (const [init, want] of cases) {
    confirmBox._resetForTest();
    assert.equal(confirmBox.available(), false, 'nothing before initialize');
    confirmBox.noteClient(init);
    assert.equal(confirmBox.available(), want, JSON.stringify(init));
  }
  confirmBox._resetForTest();
});

// ── an agent signed in as itself, and one that only says so ─────────────────

test('VIBE_AGENT_HANDLE with no credential, the person\'s token in VIBE_HOME: a person\'s session (box and turn check)', async () => {
  await withWire(async (sends) => {
    process.env.VIBE_AGENT_HANDLE = 'ada';
    agentAuth._resetForTest();
    assert.equal(agentAuth.isAgent(), true, 'configured');
    assert.equal(agentAuth.signedInAsAgent(), false, 'not signed in as one');
    const p = await prepare({ message: 'not an agent really' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'no_turn_since_shown', 'the turn check applies');
    assert.equal(box.asked.length, 0);
    personTurn();
    const ok = await sendIn(p, box);
    assert.equal(box.asked.length, 1, 'the box applies');
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('VIBE_AGENT_HANDLE with a credential, but the token is the person\'s: still a person\'s session', async () => {
  process.env.VIBE_AGENT_HANDLE = 'ada';
  process.env.VIBE_AGENT_MINT = 'a-credential-of-enough-length';
  agentAuth._resetForTest();
  assert.equal(agentAuth.signedInAsAgent(), false, 'the token was not minted as an agent');
});

// ── hooks that could answer the box ──────────────────────────────────────────

const where = {
  'project settings.json': () => path.join(PROJECT, '.claude', 'settings.json'),
  'project settings.local.json': () => path.join(PROJECT, '.claude', 'settings.local.json'),
  'user settings.json (CLAUDE_CONFIG_DIR)': () => path.join(USERDIR, 'settings.json'),
};
const hookEntry = (matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'echo yes' }] });

for (const [label, file] of Object.entries(where)) {
  test(`any Elicitation hook in the ${label} refuses the send, whatever its matcher, and no box opens`, async () => {
    await withWire(async (sends) => {
      writeSettings(file(), { hooks: { Elicitation: [hookEntry('github')] } });
      const p = await shown({ message: `hooked in ${label}` });
      const box = fakeBox(accept);
      const r = await sendIn(p, box);
      assert.match(r.display, /^Not sent: a hook on this machine is set to answer \/vibe's confirmation box \(.+\)\. Remove it to send\.$/);
      assert.ok(r.display.includes(path.basename(file())), 'names the file');
      assert.equal(box.asked.length, 0);
      assert.equal(sends.length, 0);
      assert.equal(status(p), 'previewed');
    });
  });
}

test('settings shapes: any entry for either event counts; other events and empty lists do not', () => {
  for (const event of ['Elicitation', 'ElicitationResult', 'elicitation']) {
    for (const m of [undefined, '', '*', 'vibe', 'github', '^memory$', 7, '(unclosed']) {
      assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { [event]: [hookEntry(m)] } })), true, `${event} ${JSON.stringify(m)}`);
    }
    assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { [event]: 'x' } })), true, 'not a list');
    assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { [event]: [] } })), false, 'an empty list has no entry');
  }
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { UserPromptSubmit: [hookEntry('')] } })), false);
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ permissions: {} })), false);
  assert.equal(confirmBox.settingsAnswerBox(`﻿${JSON.stringify({ hooks: { Elicitation: [hookEntry('x')] } })}`), true, 'a byte-order mark is removed first');
  assert.equal(confirmBox.settingsAnswerBox(`﻿${JSON.stringify({ hooks: {} })}`), false);
  assert.equal(confirmBox.settingsAnswerBox('{ "hooks": { "\\u0045licitation": [ ,,, '), true, 'unparseable, escaped');
  assert.equal(confirmBox.settingsAnswerBox('{ "hooks": { "ELICITATIONRESULT": oops'), true, 'unparseable, any case');
  assert.equal(confirmBox.settingsAnswerBox('{ not json, no hooks here'), false);
});

test('a settings file that is a link is read through its real path, never written', async () => {
  await withWire(async (sends) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-link-'));
    const target = path.join(elsewhere, 'real-settings.json');
    fs.writeFileSync(target, JSON.stringify({ hooks: { ElicitationResult: [hookEntry('*')] } }));
    fs.mkdirSync(path.join(PROJECT, '.claude'), { recursive: true });
    fs.symlinkSync(target, where['project settings.local.json']());
    const before = fs.readFileSync(target, 'utf8');
    const p = await shown({ message: 'linked settings' });
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.reason, 'box_hook');
    assert.equal(sends.length, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

// ── the lab exception needs both conditions ──────────────────────────────────

test('the lab exception: VIBE_LAB_BOX_HOOK=1 AND a loopback API, checked in code', () => {
  const allow = (env) => confirmBox.labAllowsHook(env);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'http://127.0.0.1:4100' }), true);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'http://localhost:4100' }), true);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'http://[::1]:4100' }), true);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'https://www.slashvibe.dev' }), false, 'a real account ignores the variable');
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'http://127.0.0.1.example.com' }), false);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'http://localhost.example.com' }), false);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: '1', VIBE_API_URL: 'not a url' }), false);
  assert.equal(allow({ VIBE_LAB_BOX_HOOK: 'true', VIBE_API_URL: 'http://127.0.0.1:4100' }), false, 'only "1"');
  assert.equal(allow({ VIBE_API_URL: 'http://127.0.0.1:4100' }), false, 'loopback alone is not enough');
});

test('with both lab conditions a lab hook is allowed; with a non-loopback API the same variable is ignored', async () => {
  await withWire(async (sends) => {
    writeSettings(where['project settings.local.json'](), { hooks: { Elicitation: [hookEntry('vibe')] } });
    process.env.VIBE_LAB_BOX_HOOK = '1';
    process.env.VIBE_API_URL = 'https://api.example.com';
    const p = await shown({ message: 'lab run' });
    const refused = await sendIn(p, fakeBox(accept));
    assert.equal(refused.data.reason, 'box_hook');
    assert.equal(sends.length, 0);
    process.env.VIBE_API_URL = 'http://127.0.0.1:9';
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

// ── the words in the box ─────────────────────────────────────────────────────

test('line 1 is fixed server text: who, now, and how long; the text starts on line 2', () => {
  assert.equal(confirmBox.message({ to: 'sam', text: 'hi' }), 'Send to @sam now? (2 characters)\nhi');
  assert.equal(confirmBox.message({ to: 'sam', text: 'x' }), 'Send to @sam now? (1 character)\nx');
  assert.equal(confirmBox.message({ to: 'sam', reply: true, text: 'yes' }), 'Send this reply to @sam now? (3 characters)\nyes');
  assert.equal(confirmBox.message({ to: 'sam', retry: true, text: 'yes' }), 'Send to @sam again now? (3 characters)\nyes');
  assert.equal(confirmBox.message({ to: 'sam-x', held: true, text: 'yes' }), 'Keep this for @sam-x until they join /vibe? (3 characters)\nyes');
  assert.equal(confirmBox.message({ to: 'sam', text: 'a\nb' }), 'Send to @sam now? (3 characters)\na ↵ b', 'a line break is a mark, not a line; it counts as one character');
  assert.equal(confirmBox.message({ to: 'sam', text: '\u{1F600}\u{1F600}' }), 'Send to @sam now? (2 characters)\n\u{1F600}\u{1F600}', 'characters, not UTF-16 units');
});

test('a reply says so in line 1', async () => {
  await withWire(async () => {
    const p = await shown({ message: 'yes it did', reply_to: 'msg_arrived1' });
    const box = fakeBox({ action: 'decline' });
    await sendIn(p, box);
    assert.equal(box.asked[0].params.message, 'Send this reply to @linus now? (10 characters)\nyes it did');
  });
});

test('fits(): the whole text shows in the two lines under the question, or it does not', () => {
  assert.equal(confirmBox.VISIBLE_LINES, 3);
  const text = (n) => Array(n).fill('word').join(' ');
  // 4-letter words: 14 to a 72-column line (14*5-1 = 69).
  assert.equal(confirmBox.textLines(text(28)).length, 2);
  assert.equal(confirmBox.fits(text(28)), true);
  assert.equal(confirmBox.textLines(text(29)).length, 3);
  assert.equal(confirmBox.fits(text(29)), false);
  assert.equal(confirmBox.fits('one\ntwo\nthree\nfour'), true, 'line breaks do not use up lines');
});

test('wrapping is by display columns: wide characters count 2, graphemes and surrogate pairs are never split, a long token is broken', () => {
  const cjk = '漢'.repeat(50);   // 100 columns
  const lines = confirmBox.textLines(cjk);
  assert.deepEqual(lines.map((l) => confirmBox.displayWidth(l)), [72, 28]);
  assert.equal(lines.join(''), cjk);
  const emoji = '\u{1F469}‍\u{1F4BB}'.repeat(40);   // a ZWJ sequence, 2 columns each
  const el = confirmBox.textLines(emoji);
  assert.equal(el.join(''), emoji, 'nothing dropped or split');
  for (const l of el) {
    assert.ok(confirmBox.displayWidth(l) <= 72);
    assert.doesNotMatch(l, /^‍|‍$/, 'no grapheme cut at a joiner');
    assert.doesNotMatch(l, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/, 'no surrogate pair split');
  }
  const url = `see https://example.com/${'a'.repeat(120)}`;
  const ul = confirmBox.textLines(url);
  assert.equal(ul[0], 'see', 'the word before the token');
  assert.ok(ul.every((l) => l.length > 0 && confirmBox.displayWidth(l) <= 72), 'no empty line, none too wide');
  const lone = confirmBox.textLines('x'.repeat(100));
  assert.equal(lone[0], 'x'.repeat(72), 'line 2 of the box is never left empty for a long first token');
});

test('wrapping and the newline mark are display only: what is sent is unchanged', async () => {
  await withWire(async (sends) => {
    const line = 'the retry loop was the culprit because every client backed off on the same schedule, so the herd came back together each time; jitter fixed it';
    const text = `${line}\n\nsee https://example.com/${'a'.repeat(90)}`;
    const p = await shown({ message: text });
    const box = fakeBox(accept);
    await sendIn(p, box);
    const msg = box.asked[0].params.message;
    for (const l of msg.split('\n').slice(1)) assert.ok(confirmBox.displayWidth(l) <= confirmBox.WRAP_COLUMNS, `wrapped: ${l}`);
    assert.equal((msg.match(/↵/g) || []).length, 2, 'each line break shown as a mark');
    assert.equal(msg.split('\n').slice(1).join('').replace(/\s+|↵/g, ''), text.replace(/\s+/g, ''), 'the whole text is in the message');
    assert.equal(sends[0].body, text, 'sent exactly as prepared');
  });
});

test('a long message is not refused: the box shows its opening, and the whole text goes after both checks', async () => {
  await withWire(async (sends) => {
    const long = 'abcdefghi '.repeat(170).trim();
    const p = await shown({ message: long });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.sent, true);
    assert.equal(sends[0].body, long);
    assert.ok(box.asked[0].params.message.startsWith(`Send to @linus now? (${long.length} characters)\nabcdefghi`));
  });
});

test('the preview says so when the box will not show the whole text, only where a box will be shown', async () => {
  const NOTE = 'The confirmation box will show the first lines of this; the full text is above.';
  await withWire(async () => {
    const longText = 'word '.repeat(40).trim();
    const noBox = await prepare({ message: longText });
    assert.ok(!noBox.display.includes(NOTE), 'no box: nothing to say');
    const boxy = { box: { mode: 'input_required' } };
    const fitting = await prepare({ message: 'short enough to show whole' }, boxy);
    assert.ok(!fitting.display.includes(NOTE));
    const long = await prepare({ message: longText }, boxy);
    assert.ok(long.display.endsWith(`\n${NOTE}`), long.display);
    assert.ok(long.display.includes(longText), 'the full text is in the preview');
  });
});

test('tool results never carry the box text, the message, or the rev', async () => {
  await withWire(async () => {
    const secret = 'zebra quartz marker text';
    for (const answer of [accept, { action: 'decline' }, { action: 'cancel' }]) {
      const p = await shown({ message: `${secret} ${answer.action}` });
      const r = await sendIn(p, fakeBox(answer));
      assert.ok(!r.display.includes('zebra'), r.display);
      assert.ok(!r.display.includes('now? ('), r.display);
      assert.ok(!r.display.includes(p.data.draft.rev), r.display);
      assert.ok(!/accept/i.test(r.display), 'never names the button');
    }
  });
});

// ── the stateless protocol (2026-07-28): input_required, then a retry ────────

const stateless = { box: { mode: 'input_required' } };
const retryWith = (first, answer, extra = {}) => ({ retry: { requestState: first.inputRequired.requestState, inputResponses: answer === undefined ? undefined : { [confirmBox.INPUT_KEY]: answer } }, ...extra });

test('stateless: the first call returns the box as an input request; the retry with Accept sends', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'over the stateless path' });
    const first = await sendIn(p, null, stateless);
    assert.ok(first.inputRequired, 'input required');
    const req = first.inputRequired.inputRequests[confirmBox.INPUT_KEY];
    assert.equal(req.method, 'elicitation/create');
    assert.deepEqual(req.params, { message: 'Send to @linus now? (23 characters)\nover the stateless path', requestedSchema: { type: 'object', properties: {} }, mode: 'form' });
    assert.equal(typeof first.inputRequired.requestState, 'string');
    assert.equal(sends.length, 0, 'nothing sent by the first call');
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, accept));
    assert.equal(r.data.sent, true);
    assert.equal(sends[0].body, 'over the stateless path');
    const replay = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, accept));
    assert.equal(replay.data.sent, false, 'a requestState works once');
    assert.equal(sends.length, 1);
  });
});

test('stateless: decline, no response, a forged or another draft\'s requestState: the same not-accepted result, nothing sent', async () => {
  await withWire(async (sends) => {
    for (const make of [
      (first) => retryWith(first, { action: 'decline' }),
      (first) => retryWith(first, undefined),
      () => ({ retry: { requestState: Buffer.from(JSON.stringify({ v: 1, id: 'wnope', n: 'f'.repeat(32) })).toString('base64url'), inputResponses: { [confirmBox.INPUT_KEY]: accept } } }),
      (first, p) => ({ retry: { requestState: Buffer.from(JSON.stringify({ v: 1, id: p.data.draft.id, n: '0'.repeat(32) })).toString('base64url'), inputResponses: { [confirmBox.INPUT_KEY]: accept } } }),
      () => ({ retry: { requestState: 'garbage', inputResponses: { [confirmBox.INPUT_KEY]: accept } } }),
    ]) {
      const p = await shown({ message: `stateless refusal ${Math.random()}` });
      const first = await sendIn(p, null, stateless);
      const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, make(first, p));
      assert.equal(r.data.sent, false);
      assert.equal(r.data.reason, 'box_not_accepted');
    }
    assert.equal(sends.length, 0);
  });
});

test('stateless: a box older than the timeout is not accepted', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'too late' });
    const first = await sendIn(p, null, stateless);
    drafts.transact((all) => { const d = all.find((x) => x.id === p.data.draft.id); d.box.at -= confirmBox.TIMEOUT_MS + 1; });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, accept));
    assert.equal(r.display, NOT_ACCEPTED);
    assert.equal(sends.length, 0);
  });
});

test('stateless: the turn check still comes first', async () => {
  await withWire(async () => {
    const p = await prepare({ message: 'no turn yet' });
    const first = await sendIn(p, null, stateless);
    assert.equal(first.inputRequired, undefined);
    assert.equal(first.data.reason, 'no_turn_since_shown');
  });
});
