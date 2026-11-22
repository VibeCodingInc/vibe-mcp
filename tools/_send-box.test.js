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
// The stateless (2026-07-28) box code is tested here as if a host showed it.
// Shipped, it is off (confirm-box.js STATELESS_BOX_SHOWN, index.js
// SERVE_STATELESS); the tests at the end of this file run it that way.
assert.equal(confirmBox.STATELESS_BOX_SHOWN, false, 'shipped: a stateless answer is never an Accept');
confirmBox._setStatelessBoxShownForTest(true);

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
const NOT_ACCEPTED = 'Not sent. It is still a draft for @linus. Only if they ask again: show it with vibe_prepare and wait for them to say send.';
/** A message too long for the box to show whole: the turn check applies on top of the box. */
const LONG = (tag) => `${tag}: ${'this one is long enough that the box shows only its start, so the preview matters. '.repeat(2).trim()}`;
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
  drafts.transact((all) => { for (const d of all) { delete d.box; delete d.boxRefusedAt; } });
  require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
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
    assert.equal(params.message, 'Send to @linus? (24 chars, all shown)\n> cloud owns placement now');
    assert.deepEqual(params.requestedSchema, { type: 'object', properties: {} });
    assert.equal(params.mode, 'form', '2025-11-25 names the form mode');
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn_check, 'box');
    assert.equal(r.data.turn, 'passed', 'the turn check applied before the box');
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

test('no typed turn, and the box cannot show all of it: refused by the turn check, and no box opens', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: LONG('shown and sent in one turn') });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'no_turn_since_shown');
    assert.equal(box.asked.length, 0);
    assert.equal(sends.length, 0);
  });
});

test('shown before this session started, too long for the box: refused by the turn check, and no box opens', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: LONG('from before the restart') });
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
    assert.equal(selfShown.data.turn_check, 'needs_turn', 'shown again by the agent, nobody typed since: a declined draft keeps the turn check even when it fits');
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
    assert.equal(r.display, NOT_ACCEPTED, 'the same result as a decline: the agent cannot tell what the person pressed');
    assert.equal(r.data.reason, 'box_not_accepted');
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed');
  });
});

test('the same text shown again while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'shown twice' });
    const box = fakeBox(async () => { tick(); await drafts.vibe_prepare.handler({ id: p.data.draft.id }); return accept; });
    const r = await sendIn(p, box);
    assert.equal(r.data.reason, 'box_not_accepted');
    assert.equal(sends.length, 0);
  });
});

test('a parallel discard while the box is open: Accept sends nothing, and the result is the same as a decline', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'cancel me midway' });
    const box = fakeBox(async () => { await drafts.vibe_discard.handler({ id: p.data.draft.id }); return accept; });
    const r = await sendIn(p, box);
    const q = await shown({ message: 'cancel me midway, declined' });
    const d = await sendIn(q, fakeBox(async () => { await drafts.vibe_discard.handler({ id: q.data.draft.id }); return { action: 'decline' }; }));
    assert.deepEqual(r, d, 'Accept-then-discard and decline-then-discard read exactly the same');
    assert.equal(r.display, NOT_ACCEPTED.replace('@linus', '@linus'));
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
    const p = await prepare({ message: LONG('not an agent really') });
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

test('a reply says so in line 1', async () => {
  await withWire(async () => {
    const p = await shown({ message: 'yes it did', reply_to: 'msg_arrived1' });
    const box = fakeBox({ action: 'decline' });
    await sendIn(p, box);
    assert.equal(box.asked[0].params.message, 'Reply to @linus? (10 chars, all shown)\n> yes it did');
  });
});

test('fits(): the whole text shows in the two lines under the question, or it does not', () => {
  assert.equal(confirmBox.VISIBLE_LINES, 3);
  const text = (n) => Array(n).fill('word').join(' ');
  // 4-letter words: 14 to a 70-column text line ("> " takes 2 of 72; 14*5-1 = 69).
  assert.equal(confirmBox.textLines(text(28)).length, 2);
  assert.equal(confirmBox.fits(text(28)), true);
  assert.equal(confirmBox.textLines(text(29)).length, 3);
  assert.equal(confirmBox.fits(text(29)), false);
  for (const l of confirmBox.message({ to: 'sam', text: text(80) }).split('\n').slice(1)) assert.ok(l.startsWith('> ') && l.length <= 72, l);
  assert.equal(confirmBox.fits('one\ntwo\nthree\nfour'), true, 'line breaks do not use up lines');
});

test('wrapping is by display columns: wide characters count 2, graphemes and surrogate pairs are never split, a long token is broken', () => {
  const cjk = '漢'.repeat(50);   // 100 columns
  const lines = confirmBox.textLines(cjk);
  assert.deepEqual(lines.map((l) => confirmBox.displayWidth(l)), [70, 30]);
  assert.equal(lines.join(''), cjk);
  const emoji = '\u{1F469}‍\u{1F4BB}'.repeat(40);   // a ZWJ sequence, 2 columns each
  const el = confirmBox.textLines(emoji);
  assert.equal(el.join(''), emoji, 'nothing dropped or split');
  for (const l of el) {
    assert.ok(confirmBox.displayWidth(l) <= 70);
    assert.doesNotMatch(l, /^‍|‍$/, 'no grapheme cut at a joiner');
    assert.doesNotMatch(l, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/, 'no surrogate pair split');
  }
  const url = `see https://example.com/${'a'.repeat(120)}`;
  const ul = confirmBox.textLines(url);
  assert.equal(ul[0], 'see', 'the word before the token');
  assert.ok(ul.every((l) => l.length > 0 && confirmBox.displayWidth(l) <= 70), 'no empty line, none too wide');
  const lone = confirmBox.textLines('x'.repeat(100));
  assert.equal(lone[0], 'x'.repeat(70), 'line 2 of the box is never left empty for a long first token');
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
    assert.equal(msg.split('\n').slice(1).map((l) => l.replace(/^> /, '')).join('').replace(/\s+|↵/g, ''), text.replace(/\s+/g, ''), 'the whole text is in the message');
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
    assert.ok(box.asked[0].params.message.startsWith(`Send to @linus? (${long.length} chars, start only)\n> abcdefghi`));
  });
});

test('the preview says so when the box will not show the whole text, only where a box will be shown (nothing required depends on it)', async () => {
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
      assert.ok(!r.display.includes('chars, ') && !r.display.includes('> '), r.display);
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
    assert.deepEqual(req.params, { message: 'Send to @linus? (23 chars, all shown)\n> over the stateless path', requestedSchema: { type: 'object', properties: {} }, mode: 'form' });
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
    const p = await prepare({ message: LONG('no turn yet') });
    const first = await sendIn(p, null, stateless);
    assert.equal(first.inputRequired, undefined);
    assert.equal(first.data.reason, 'no_turn_since_shown');
  });
});

// ── third pass (review 2026-11-22) ───────────────────────────────────────────

test('where the turn check is unavailable (a host that is not Claude Code), the box alone decides', async () => {
  await withWire(async (sends) => {
    require('../host').setClientInfo({ name: 'cursor', version: 'test' });
    const p = await prepare({ message: 'box alone' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(box.asked.length, 1);
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn, 'unavailable');
    const q = await prepare({ message: 'box alone, declined' });
    const no = await sendIn(q, fakeBox({ action: 'decline' }));
    assert.equal(no.display, NOT_ACCEPTED);
    assert.deepEqual(sends.map((x) => x.body), ['box alone']);
  });
});

test('one prompt, five drafts, the first box declined: the other four get the not-accepted result and no box', async () => {
  await withWire(async (sends) => {
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(await prepare({ message: `draft number ${i}` }));
    personTurn();
    const box = fakeBox({ action: 'decline' });
    const first = await sendIn(ps[0], box);
    assert.equal(first.display, NOT_ACCEPTED);
    const accepting = fakeBox(accept);
    for (const p of ps.slice(1)) {
      const r = await sendIn(p, accepting);
      assert.equal(r.display, NOT_ACCEPTED);
      assert.equal(r.data.reason, 'box_not_accepted');
    }
    assert.equal(accepting.asked.length, 0, 'no box for any draft until the person types again');
    assert.equal(sends.length, 0);
    personTurn();
    const after = await sendIn(ps[1], accepting);
    assert.equal(after.data.sent, true, 'the next prompt lifts it for the other drafts');
    const firstAgain = await sendIn(ps[0], accepting);
    assert.equal(firstAgain.display, NOT_ACCEPTED, 'the declined draft itself still needs showing again');
  });
});

test('padding cannot push the text out of the visible lines: whitespace runs show as one space (display only)', async () => {
  await withWire(async (sends) => {
    const text = `hi${' '.repeat(300)}the real text`;
    const p = await shown({ message: text });
    const box = fakeBox(accept);
    await sendIn(p, box);
    assert.equal(box.asked[0].params.message, `Send to @linus? (${Array.from(text).length} chars, all shown)\n> hi the real text`, 'every word is shown');
    assert.equal(sends[0].body, text, 'sent exactly as prepared');
  });
});

test('every kind of blank shows as one space in the box, whatever vibe_prepare would allow', () => {
  const text = 'hi \u2800\u2800\u3164\u115F\u1160\uFFA0\t\u00a0\u3000\u2003 the real text';
  assert.equal(confirmBox.message({ to: 'sam', text }).split('\n')[1], '> hi the real text');
});

test('the count is grapheme clusters: a family emoji is one character, a combining mark is part of its letter', () => {
  assert.match(confirmBox.message({ to: 'sam', text: '\u{1F468}‍\u{1F469}‍\u{1F467}' }), /^Send to @sam\? \(1 char, all shown\)\n/);
  assert.match(confirmBox.message({ to: 'sam', text: 'café' }), /^Send to @sam\? \(4 chars, all shown\)\n/);
});

test('an accepted box whose delivery did not confirm: "send it again" goes through the turn check and a new "again" box', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'did it arrive?' });
    const orig = store.sendMessage;
    store.sendMessage = async () => { throw new Error('socket hang up'); };
    let r;
    try { r = await sendIn(p, fakeBox(accept)); } finally { store.sendMessage = orig; }
    assert.equal(r.data.sent, false);
    assert.equal(status(p), 'unknown');
    personTurn();
    const box = fakeBox(accept);
    const again = await sendIn(p, box);
    assert.equal(box.asked.length, 1, 'not the not-accepted refusal: a new box');
    assert.equal(box.asked[0].params.message, 'Resend to @linus? (14 chars, all shown)\n> did it arrive?');
    assert.equal(again.data.sent, true);
    assert.deepEqual(sends.map((x) => x.body), ['did it arrive?']);
  });
});

test('a declined draft cannot then go by the turn check alone on a request with no box, until shown again and a turn', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'downgrade me' });
    await sendIn(p, fakeBox({ action: 'decline' }));
    personTurn();
    const noBox = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(noBox.display, NOT_ACCEPTED);
    assert.equal(sends.length, 0);
    await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    const selfShown = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(selfShown.data.turn_check, 'needs_turn');
    personTurn();
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(ok.data.sent, true);
  });
});

test('stateless: two retries racing with the same requestState send once', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'race me' });
    const first = await sendIn(p, null, stateless);
    const args = { id: p.data.draft.id, rev: p.data.draft.rev };
    const rs = await Promise.all([drafts.vibe_send.handler(args, retryWith(first, accept)), drafts.vibe_send.handler(args, retryWith(first, accept))]);
    assert.equal(rs.filter((r) => r.data && r.data.sent).length, 1);
    assert.equal(sends.length, 1);
  });
});

test('stateless: "Accept" in the wrong case is not an accept', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'case matters' });
    const first = await sendIn(p, null, stateless);
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, { action: 'Accept' }));
    assert.equal(r.display, NOT_ACCEPTED);
    assert.equal(sends.length, 0);
  });
});

test('stateless: a hook that appears between the box opening and Accept stops the send', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'hook in between' });
    const first = await sendIn(p, null, stateless);
    writeSettings(where['project settings.json'](), { hooks: { ElicitationResult: [hookEntry('anything')] } });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, accept));
    assert.equal(r.data.reason, 'box_hook');
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed');
  });
});

test('Keep (a message held for someone not on /vibe yet) goes through the box too', async () => {
  const crypto = require('node:crypto');
  const digest = (t) => crypto.createHash('sha256').update(['invitation-v1', '', '', '', '', '', '', t].join('\u0000'), 'utf8').digest('hex');
  const origFetch = global.fetch;
  const origInvite = store.createInvite;
  const invites = [];
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    if (h === 'newbie-dev') return { ok: false, status: 404, json: async () => ({ error: 'identity_not_found' }) };
    return { ok: true, status: 200, json: async () => ({ handle: h, kind: 'human' }) };
  };
  store.createInvite = async (body) => {
    invites.push(body);
    if (body.dry_run) return { success: true, dry_run: true, named_for: body.for_github, carries_thought: true, approval: { sha256: digest(body.first_thought) } };
    return { success: true, code: 'VIBE-AB2C-ADA', expires_at: '2026-12-20T00:00:00.000Z', carries_thought: true, named_for: body.for_github };
  };
  try {
    const p = await drafts.vibe_prepare.handler({ handle: 'newbie-dev', message: 'welcome aboard' });
    assert.equal(p.data.draft.held, true);
    personTurn();
    const box = fakeBox(accept);
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, { box });
    assert.equal(box.asked[0].params.message, 'Keep for @newbie-dev? (14 chars, all shown)\n> welcome aboard');
    assert.equal(r.data.held, true);
    assert.equal(invites.filter((b) => !b.dry_run).length, 1);
  } finally { global.fetch = origFetch; store.createInvite = origInvite; }
});

// ── a typed turn AND Accept, for every draft, wherever turns are recorded ────

test('does not fit: no box without a typed turn; with one, the box says only the start is shown and Accept sends', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: LONG('too long for the box') });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(box.asked.length, 0);
    personTurn();
    const ok = await sendIn(p, box);
    assert.match(box.asked[0].params.message, /^Send to @linus\? \(\d+ chars, start only\)\n> too long for the box: /);
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('the preview on a connection with no box says sending relies on the typed reply; never where a box can be shown', async () => {
  const NONE = "This app cannot show /vibe's confirmation box, so sending relies on your typed reply.";
  await withWire(async () => {
    const plain = await prepare({ message: 'no box connection' });
    assert.ok(plain.display.endsWith(`\n${NONE}`), plain.display);
    const boxy = await prepare({ message: 'box connection' }, { box: { mode: 'input_required' } });
    assert.ok(!boxy.display.includes(NONE));
    const legacy = await prepare({ message: 'legacy box connection' }, { box: fakeBox(accept) });
    assert.ok(!legacy.display.includes(NONE));
  });
});

// ── the hook scan: managed settings ───────────────────────────────────────

test('the managed settings file is in the scan, for macOS and Linux', () => {
  assert.ok(confirmBox.settingsFiles(process.env, process.cwd, { platform: 'darwin' }).includes('/Library/Application Support/ClaudeCode/managed-settings.json'));
  assert.ok(confirmBox.settingsFiles(process.env, process.cwd, { platform: 'linux' }).includes('/etc/claude-code/managed-settings.json'));
});

// ── fourth pass (review 2026-11-22): removed shortcuts stay removed ──────────

test('line 1: compact leads, both facts, within 72 columns for the longest handle (39 characters)', () => {
  assert.equal(confirmBox.message({ to: 'sam', text: 'hi' }), 'Send to @sam? (2 chars, all shown)\n> hi');
  assert.equal(confirmBox.message({ to: 'sam', text: 'x' }), 'Send to @sam? (1 char, all shown)\n> x');
  assert.equal(confirmBox.message({ to: 'sam', reply: true, text: 'yes' }), 'Reply to @sam? (3 chars, all shown)\n> yes');
  assert.equal(confirmBox.message({ to: 'sam', retry: true, text: 'yes' }), 'Resend to @sam? (3 chars, all shown)\n> yes');
  assert.equal(confirmBox.message({ to: 'sam-x', held: true, text: 'yes' }), 'Keep for @sam-x? (3 chars, all shown)\n> yes');
  assert.match(confirmBox.message({ to: 'sam', text: 'word '.repeat(60).trim() }), /^Send to @sam\? \(299 chars, start only\)\n> word/);
  const h = 'a'.repeat(39);
  for (const o of [{}, { reply: true }, { retry: true }, { held: true }]) {
    for (const text of ['x '.repeat(999) + 'x', 'hi']) {
      const q = confirmBox.question({ to: h, text, ...o });
      assert.ok(q.length <= 72, `${q.length}: ${q}`);
      assert.match(q, /\(\d+ chars?, (all shown|start only|all|start)\)$/);
    }
  }
});

test('no path sends on Accept alone where turns are recorded: a short message without a typed turn gets no box', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'the TTL is 7 min' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(box.asked.length, 0);
    const first = await sendIn(p, null, stateless);
    assert.equal(first.inputRequired, undefined, 'nor on the stateless path');
    assert.equal(sends.length, 0);
  });
});

test('a reply needs a typed turn AND Accept: the box does not show what it answers, the preview does', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'yes it works', reply_to: 'msg_question1' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(box.asked.length, 0);
    personTurn();
    const ok = await sendIn(p, box);
    assert.equal(box.asked[0].params.message, 'Reply to @linus? (12 chars, all shown)\n> yes it works');
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('one prompt, five drafts, every box accepted: all five go (no cap; one box at a time)', async () => {
  await withWire(async (sends) => {
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(await prepare({ message: `accepted draft ${i}` }));
    personTurn();
    const box = fakeBox(accept);
    for (const p of ps) assert.equal((await sendIn(p, box)).data.sent, true);
    assert.equal(sends.length, 5);
  });
});

test('stateless: a second send for a draft whose request is outstanding is told another box is open; the current request still answers', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'outstanding once' });
    const a = await sendIn(p, null, stateless);
    const again = await sendIn(p, null, stateless);
    assert.equal(again.display, 'Not sent: another /vibe confirmation box is open. Wait until it is answered.');
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(a, accept));
    assert.equal(r.data.sent, true);
    assert.deepEqual(sends.map((x) => x.body), ['outstanding once']);
  });
});

test('hook tripwire: exactly an Elicitation or ElicitationResult key under hooks, parsed as JSON', () => {
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { Elicitation: [] } })), 'hook', 'the key is enough');
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { ElicitationResult: [hookEntry('x')] } })), 'hook');
  assert.equal(confirmBox.settingsAnswerBox(`﻿${JSON.stringify({ hooks: { Elicitation: [hookEntry('vibe')] } })}`), 'hook', 'a byte-order mark is removed');
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { elicitation: [hookEntry('vibe')] } })), null, 'case-sensitive, as the host reads it');
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { UserPromptSubmit: [hookEntry('')] } })), null);
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ permissions: { allow: ['Elicitation'] } })), null, 'the word elsewhere is not a hook');
  assert.equal(confirmBox.settingsAnswerBox('{ "hooks": { oops'), 'json');
});

test('a settings file that does not parse refuses the send and is named', async () => {
  await withWire(async (sends) => {
    writeSettings(where['project settings.local.json'](), '{ "hooks": { not json');
    const p = await shown({ message: 'unparseable settings' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.match(r.display, /^Not sent: a settings file on this machine cannot be read as JSON \(.+settings\.local\.json\), so \/vibe cannot check it for a hook that would answer its confirmation box\. Fix the file to send\.$/);
    assert.equal(r.data.reason, 'settings_unreadable');
    assert.equal(box.asked.length, 0);
    assert.equal(sends.length, 0);
  });
});

test('a skill, agent or command that mentions "elicitation" does not block sending (not scanned)', async () => {
  const files = [path.join(PROJECT, '.claude', 'skills', 'h', 'SKILL.md'), path.join(PROJECT, '.claude', 'agents', 'h.md'), path.join(USERDIR, 'commands', 'h.md')];
  for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '---\nname: h\nhooks:\n  Elicitation: []\n---\nAbout elicitation.\n'); }
  try {
    await withWire(async (sends) => {
      const p = await shown({ message: 'skills mention it' });
      const r = await sendIn(p, fakeBox(accept));
      assert.equal(r.data.sent, true);
      assert.equal(sends.length, 1);
    });
  } finally { for (const f of files) fs.rmSync(f, { force: true }); }
});

test('the files scanned: exactly the project\'s two, the user\'s settings.json and managed settings; no parent folders, no plugins', () => {
  const listed = confirmBox.settingsFiles(process.env, process.cwd, { platform: 'linux' });
  assert.deepEqual(listed, [path.join(PROJECT, '.claude', 'settings.json'), path.join(PROJECT, '.claude', 'settings.local.json'), path.join(USERDIR, 'settings.json'), '/etc/claude-code/managed-settings.json']);
  assert.ok(!listed.some((f) => f.startsWith(path.join(path.dirname(PROJECT), '.claude'))), 'no parent folder');
});

test('the no-box preview line is true where turns are not recorded', async () => {
  const UNTRACKED = "This app cannot show /vibe's confirmation box or record your reply; a message goes when the agent sends it after you say so.";
  await withWire(async () => {
    require('../host').setClientInfo({ name: 'cursor', version: 'test' });
    const p = await prepare({ message: 'no box, no turns' });
    assert.ok(p.display.endsWith(`\n${UNTRACKED}`), p.display);
  });
});

test('a plugin\'s hooks/hooks.json is not read (plugin hooks are listed as not covered)', async () => {
  const file = path.join(USERDIR, 'plugins', 'marketplaces', 'm', 'helper', 'hooks', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { Elicitation: [] } }));
  try { assert.equal(confirmBox.answeringHook(), null); } finally { fs.rmSync(path.join(USERDIR, 'plugins'), { recursive: true, force: true }); }
});

// ── fifth pass: a box nobody answers ────────────────────────────────────────

test('an abandoned stateless box: after its window it is closed as a non-accept; other drafts wait for a person turn, the draft needs a new showing', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'never answered' });
    const other = await prepare({ message: 'another draft' });
    personTurn();
    const first = await sendIn(p, null, stateless);
    assert.ok(first.inputRequired);
    const busy = await sendIn(other, null, stateless);
    assert.equal(busy.data.reason, 'box_busy', 'within the window: one box at a time');
    // The host never answers; the window passes.
    drafts.transact((all) => { const d = all.find((x) => x.id === p.data.draft.id); d.box.at -= confirmBox.TIMEOUT_MS + 6000; });
    const after = await sendIn(other, null, stateless);
    assert.equal(after.display, NOT_ACCEPTED, 'closed as a non-accept: no box until the person types');
    assert.equal(drafts.loadDrafts().find((x) => x.id === p.data.draft.id).box, undefined, 'the abandoned box is gone');
    personTurn();
    const next = await sendIn(other, null, stateless);
    assert.ok(next.inputRequired, 'after a person turn another draft may be boxed');
    drafts.transact((all) => { for (const d of all) delete d.box; });
    personTurn();
    const same = await sendIn(p, fakeBox(accept));
    assert.equal(same.display, NOT_ACCEPTED, 'the abandoned draft itself needs showing again');
    assert.equal(sends.length, 0);
  });
});

test('a box left on disk by a server that exited is closed as a non-accept', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'server went away' });
    const other = await shown({ message: 'next draft' });
    drafts.transact((all) => { const d = all.find((x) => x.id === p.data.draft.id); d.boxAt = Date.now(); d.box = { nonce: 'n'.repeat(32), at: Date.now(), rev: p.data.draft.rev, sha: 'x', me: 'ada', turn: 'passed', project: 'whatever', pid: 2147483646 }; });
    const r = await sendIn(other, fakeBox(accept));
    assert.equal(r.display, NOT_ACCEPTED, 'not "another box is open": closed, and recorded as a non-accept');
    assert.equal(drafts.loadDrafts().find((x) => x.id === p.data.draft.id).box, undefined);
    assert.equal(sends.length, 0);
  });
});

test('another project is not held up by this project\'s outstanding box', async () => {
  await withWire(async (sends) => {
    const p = await shown({ message: 'project one' });
    const first = await sendIn(p, null, stateless);
    assert.ok(first.inputRequired);
    const SECOND = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-project2-'));
    const before = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = SECOND;
    try {
      const q = await prepare({ message: 'project two' });
      tick(); turns.record(SECOND, Date.now());
      const r = await sendIn(q, fakeBox(accept));
      assert.equal(r.data.sent, true, 'not "another box is open"');
      assert.deepEqual(sends.map((x) => x.body), ['project two']);
    } finally { process.env.CLAUDE_PROJECT_DIR = before; fs.rmSync(SECOND, { recursive: true, force: true }); }
  });
});

// ── as shipped: no host has been seen to show the stateless box ─────────────
// Claude Code 2.1.330 answers an input_required request "accept" without
// showing it. With STATELESS_BOX_SHOWN false (the shipped value) a stateless
// connection is a connection with no box, and an inputResponses answer never
// sends, whatever it says.

async function asShipped(fn) {
  confirmBox._setStatelessBoxShownForTest(false);
  try { await fn(); } finally { confirmBox._setStatelessBoxShownForTest(true); }
}

test('as shipped, a stateless connection is "no box": the preview says the send relies on the typed reply, and the turn check alone sends', async () => {
  await asShipped(() => withWire(async (sends) => {
    const p = await prepare({ message: 'stateless, as shipped' }, stateless);
    assert.match(p.display, /This app cannot show \/vibe's confirmation box, so sending relies on your typed reply\./);
    const early = await sendIn(p, null, stateless);
    assert.equal(early.inputRequired, undefined, 'no input request');
    assert.equal(early.data.reason, 'no_turn_since_shown');
    personTurn();
    const r = await sendIn(p, null, stateless);
    assert.equal(r.inputRequired, undefined, 'no input request');
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  }));
});

test('as shipped, an inputResponses "accept" is never the person\'s Accept: with or without a box opened, nothing is sent', async () => {
  // A box opened while the stateless box counted (a requestState that names
  // an open box), then the setting is as shipped.
  await withWire(async (sends) => {
    const p = await shown({ message: 'accepted by nobody' });
    const first = await sendIn(p, null, stateless);
    assert.ok(first.inputRequired);
    await asShipped(async () => {
      const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, accept));
      assert.equal(r.data.sent, false);
      assert.equal(r.data.reason, 'box_not_accepted');
      // A forged requestState, with or without ctx.box.
      const forged = { retry: { requestState: Buffer.from(JSON.stringify({ v: 1, id: p.data.draft.id, n: 'f'.repeat(32) })).toString('base64url'), inputResponses: { [confirmBox.INPUT_KEY]: accept } } };
      for (const ctx of [forged, { ...forged, ...stateless }]) {
        const again = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, ctx);
        assert.equal(again.data.sent, false);
      }
    });
    assert.equal(sends.length, 0);
    // Close the box this test left open, so nothing after it is held up.
    await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, retryWith(first, { action: 'decline' }));
  });
});
