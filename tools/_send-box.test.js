'use strict';
// The Send box: where the host can show one (MCP elicitation, declared at
// initialize), vibe_send asks the person in a box the server opens, and sends
// only on an explicit Accept of the exact text in the box.
//
// The turn check (turns.js) counts any prompt, even "no, don't send", lets one
// prompt unlock every shown draft, and counts a wake-up the agent scheduled
// for itself. The box is the person's own answer, which the model never sees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';   // never production
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
delete process.env.VIBE_LAB_BOX_HOOK;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-project-'));
const USERDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-claude-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.CLAUDE_CONFIG_DIR = USERDIR;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');
const confirmBox = require('../confirm-box');

// The turn check is live here: a turn was recorded before every draft below,
// so a send in the same turn as its showing would be refused on that path.
turns.record(PROJECT, Date.now() - 60_000);

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

/** A client that answers every box with `answer` (an object, or a function of the params). */
function fakeBox(answer, { protocolVersion = '2025-11-25', timeoutMs } = {}) {
  const asked = [];
  const box = {
    protocolVersion,
    asked,
    request: async (params, opts) => { asked.push({ params, signal: opts && opts.signal }); return typeof answer === 'function' ? answer(params, opts) : answer; },
  };
  if (timeoutMs) box.timeoutMs = timeoutMs;
  return box;
}
const accept = { action: 'accept', content: {} };
const prepare = (o) => drafts.vibe_prepare.handler({ handle: 'linus', message: 'the lease fixed it', ...o });
const sendIn = (p, box) => drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, { box });
const status = (p) => drafts.loadDrafts().find((d) => d.id === p.data.draft.id).status;

function clearSettings() {
  for (const f of [path.join(PROJECT, '.claude', 'settings.json'), path.join(PROJECT, '.claude', 'settings.local.json'), path.join(USERDIR, 'settings.json')]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}
function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test.beforeEach(() => { clearSettings(); confirmBox._resetForTest(); delete process.env.VIBE_LAB_BOX_HOOK; process.env.VIBE_API_URL = 'http://127.0.0.1:9'; });
test.after(() => { for (const d of [HOME, PROJECT, USERDIR]) fs.rmSync(d, { recursive: true, force: true }); });

// ── accept ────────────────────────────────────────────────────────────────────

test('Accept sends exactly the text in the box, with no turn since it was shown', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'cloud owns placement now' });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(box.asked.length, 1, 'one box');
    const { params } = box.asked[0];
    assert.equal(params.message, 'To @linus: cloud owns placement now');
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
    const p = await prepare({ message: 'older protocol' });
    const box = fakeBox(accept, { protocolVersion: '2025-06-18' });
    await sendIn(p, box);
    assert.equal('mode' in box.asked[0].params, false);
  });
});

test('a draft shown before this session started can still be confirmed in the box: the box shows the whole text', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'from before the restart' });
    const t = Date.now(); while (Date.now() === t) { /* next ms */ }
    turns.recordSessionStart(PROJECT, Date.now() + 1, process.env, 'later-session');
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.sent, true);
    assert.equal(sends[0].body, 'from before the restart');
    fs.rmSync(path.join(turns.turnsDir(), `${turns.key(PROJECT)}.start.json`), { force: true });
  });
});

// ── decline, and every other answer ──────────────────────────────────────────

test('Decline: not sent, the draft is kept, and the same rev is not boxed again until it is shown again', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'maybe not' });
    const box = fakeBox({ action: 'decline' });
    const r = await sendIn(p, box);
    assert.equal(r.display, 'Not sent: they chose not to send this to @linus. Do not offer it again unless they ask.');
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'declined');
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed', 'kept');

    const again = await sendIn(p, box);
    assert.equal(box.asked.length, 1, 'no second box for a declined rev');
    assert.equal(again.display, 'Not sent: they already chose not to send this to @linus. If they ask for it again, show it to them with vibe_prepare first.');
    assert.equal(sends.length, 0);

    const shown = await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    assert.equal(shown.data.draft.rev, p.data.draft.rev, 'same text, shown again');
    const ok = await sendIn(p, fakeBox(accept));
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

const NOT_ANSWERED = 'Not sent: the confirmation box for @linus was not answered. It is still a draft.';
for (const [name, answer] of [
  ['cancel (no keyboard)', { action: 'cancel' }],
  ['an unknown action', { action: 'ACCEPT' }],
  ['no action', { content: {} }],
  ['an empty result', null],
  ['a client error', () => { const e = new Error('Method not found'); e.code = -32601; throw e; }],
  ['a rejected promise', () => Promise.reject(new Error('closed'))],
]) {
  test(`${name}: not sent, and the draft is kept`, async () => {
    await withWire(async (sends) => {
      const p = await prepare({ message: `answer was ${name}` });
      const r = await sendIn(p, fakeBox(answer));
      assert.equal(r.display, NOT_ANSWERED);
      assert.equal(r.data.sent, false);
      assert.equal(sends.length, 0);
      assert.equal(status(p), 'previewed');
    });
  });
}

test('timeout: the box is withdrawn, nothing is sent, the draft is kept', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'nobody is at the keyboard' });
    const box = fakeBox(() => new Promise(() => {}), { timeoutMs: 40 });
    const r = await sendIn(p, box);
    assert.equal(r.display, NOT_ANSWERED);
    assert.equal(box.asked[0].signal.aborted, true, 'the request was withdrawn');
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'previewed');
    assert.equal(confirmBox.isOpen(), false);
  });
});

test('the timeout is five minutes', () => {
  assert.equal(confirmBox.TIMEOUT_MS, 5 * 60 * 1000);
});

// ── the draft changes while the box is open ──────────────────────────────────

test('an edit while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'the first words' });
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

test('a cancel while the box is open: Accept sends nothing', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'cancel me midway' });
    const box = fakeBox(async () => { await drafts.vibe_discard.handler({ id: p.data.draft.id }); return accept; });
    const r = await sendIn(p, box);
    assert.equal(r.data.sent, false);
    assert.equal(sends.length, 0);
    assert.equal(status(p), 'cancelled');
  });
});

// ── one box at a time ────────────────────────────────────────────────────────

test('a second vibe_send while a box is open is refused; the first still goes on Accept', async () => {
  await withWire(async (sends) => {
    const a = await prepare({ message: 'first box' });
    const b = await prepare({ message: 'second box' });
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

// ── no box: the turn check, unchanged ────────────────────────────────────────

test('without a box (the client declared none) the turn check applies as before', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'no box here' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(sends.length, 0);
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

// ── hooks that could answer the box ──────────────────────────────────────────

const where = {
  'project settings.json': () => path.join(PROJECT, '.claude', 'settings.json'),
  'project settings.local.json': () => path.join(PROJECT, '.claude', 'settings.local.json'),
  'user settings.json (CLAUDE_CONFIG_DIR)': () => path.join(USERDIR, 'settings.json'),
};
const hookEntry = (matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'echo yes' }] });

for (const [label, file] of Object.entries(where)) {
  test(`a hook that answers the box in the ${label} refuses the send, and no box opens`, async () => {
    await withWire(async (sends) => {
      writeSettings(file(), { hooks: { Elicitation: [hookEntry('vibe')] } });
      const p = await prepare({ message: `hooked in ${label}` });
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

test('matcher shapes that catch the box, for both hook events', () => {
  const catches = [undefined, '', '  ', '*', 'vibe', 'VIBE', 'Vibe', 'slashvibe', 'slash.*', 'github|vibe', '^v', 'v.b', '.*', 7, null, ['vibe'], {}, '(unclosed', '[z-a]'];
  for (const event of ['Elicitation', 'ElicitationResult']) {
    for (const m of catches) {
      const raw = JSON.stringify({ hooks: { [event]: [hookEntry(m)] } });
      assert.equal(confirmBox.settingsAnswerBox(raw), true, `${event} ${JSON.stringify(m)}`);
    }
    for (const m of ['github', 'memory', '^other$', 'vibeconferencing']) {
      const raw = JSON.stringify({ hooks: { [event]: [hookEntry(m)] } });
      assert.equal(confirmBox.settingsAnswerBox(raw), false, `${event} ${JSON.stringify(m)} does not name /vibe`);
    }
    assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { [event]: 'x' } })), true, 'an event that is not a list');
    assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { [event]: ['x'] } })), true, 'an entry that is not an object');
    assert.equal(confirmBox.settingsAnswerBox(`{ "hooks": { "${event}": [ ,,, `), true, 'unparseable, and names the event');
  }
  assert.equal(confirmBox.settingsAnswerBox('{ not json, no hooks here'), false, 'unparseable and silent about the events');
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ hooks: { UserPromptSubmit: [hookEntry('')] } })), false, 'other hook events are not the box');
  assert.equal(confirmBox.settingsAnswerBox(JSON.stringify({ permissions: {} })), false);
});

test('a hook whose matcher does not name /vibe does not stop the box', async () => {
  await withWire(async (sends) => {
    writeSettings(where['project settings.json'](), { hooks: { Elicitation: [hookEntry('github')], ElicitationResult: [hookEntry('^memory$')] } });
    const p = await prepare({ message: 'someone else\'s hook' });
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('a settings file that is a link is read through its real path', async () => {
  await withWire(async (sends) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-link-'));
    const target = path.join(elsewhere, 'real-settings.json');
    fs.writeFileSync(target, JSON.stringify({ hooks: { ElicitationResult: [hookEntry('*')] } }));
    fs.mkdirSync(path.join(PROJECT, '.claude'), { recursive: true });
    fs.symlinkSync(target, where['project settings.local.json']());
    const before = fs.readFileSync(target, 'utf8');
    const p = await prepare({ message: 'linked settings' });
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.reason, 'box_hook');
    assert.equal(sends.length, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'read, never written');
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
    const p = await prepare({ message: 'lab run' });
    const refused = await sendIn(p, fakeBox(accept));
    assert.equal(refused.data.reason, 'box_hook');
    assert.equal(sends.length, 0);
    process.env.VIBE_API_URL = 'http://127.0.0.1:9';
    const r = await sendIn(p, fakeBox(accept));
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

// ── length and wrapping ──────────────────────────────────────────────────────

test('a long message is not refused for the box: the box shows its opening, and the whole text is sent', async () => {
  await withWire(async (sends) => {
    const long = 'abcdefghi '.repeat(170).trim();
    const p = await prepare({ message: long });
    const box = fakeBox(accept);
    const r = await sendIn(p, box);
    assert.equal(r.data.sent, true);
    assert.equal(sends[0].body, long);
    assert.equal(box.asked[0].params.message.replace(/\s+/g, ''), `To@linus:${long.replace(/\s+/g, '')}`, 'the whole text is in the box message');
  });
});

test('wrapping and the newline mark are display only: lines of at most 72, " ↵ " for a line break, what is sent unchanged', async () => {
  await withWire(async (sends) => {
    const line = 'the retry loop was the culprit because every client backed off on the same schedule, so the herd came back together each time; jitter fixed it';
    const text = `${line}\n\nsee https://example.com/${'a'.repeat(90)}`;
    const p = await prepare({ message: text });
    const box = fakeBox(accept);
    await sendIn(p, box);
    const shown = box.asked[0].params.message;
    for (const l of shown.split('\n')) assert.ok(l.length <= confirmBox.WRAP_COLUMNS, `wrapped: ${l}`);
    assert.ok(shown.startsWith('To @linus: the retry loop'), 'the text starts on line 1');
    assert.ok(shown.includes('jitter fixed it ↵  ↵ see'), 'each line break shown as a mark, not a line');
    assert.equal(shown.replace(/\s+|↵/g, ''), `To@linus:${text.replace(/\s+/g, '')}`, 'nothing cut');
    assert.equal(sends[0].body, text, 'sent exactly as prepared');
  });
});

test('message(): the lead names the recipient, a reply, a retry or a keep, then the text on the same line', () => {
  assert.equal(confirmBox.message({ to: 'sam', text: 'hi' }), 'To @sam: hi');
  assert.equal(confirmBox.message({ to: 'sam', reply: true, text: 'yes' }), 'Reply to @sam: yes');
  assert.equal(confirmBox.message({ to: 'sam', retry: true, text: 'yes' }), 'To @sam (again): yes');
  assert.equal(confirmBox.message({ to: 'sam-x', held: true, text: 'yes' }), 'Keep for @sam-x: yes');
  assert.equal(confirmBox.message({ to: 'sam', text: 'a\nb' }), 'To @sam: a ↵ b');
});

test('fits(): three wrapped lines show in full, a fourth does not', () => {
  assert.equal(confirmBox.VISIBLE_LINES, 3);
  const msg = (n) => confirmBox.message({ to: 'linus', text: Array(n).fill('word').join(' ') });
  // "To @linus: " then 4-letter words: 40 words (199 characters) fill three lines.
  assert.equal(msg(40).split('\n').length, 3);
  assert.equal(confirmBox.fits(msg(40)), true, 'about 200 characters show whole');
  assert.equal(msg(41).split('\n').length, 4);
  assert.equal(confirmBox.fits(msg(41)), false);
  assert.equal(confirmBox.fits(confirmBox.message({ to: 'linus', text: 'one\ntwo\nthree\nfour' })), true, 'line breaks do not use up lines');
});

test('the preview says so when the box will not show the whole text, only on a connection with a box', async () => {
  const NOTE = 'The confirmation box will show the first lines of this; the full text is above.';
  await withWire(async () => {
    const shortText = 'short enough to show whole';
    const longText = 'word '.repeat(60).trim();
    const noBox = await prepare({ message: longText });
    assert.ok(!noBox.display.includes(NOTE), 'no box on this connection: nothing to say');
    confirmBox.noteClient({ protocolVersion: '2025-11-25', capabilities: { elicitation: {} } });
    const fitting = await prepare({ message: shortText });
    assert.ok(!fitting.display.includes(NOTE));
    const long = await prepare({ message: longText });
    assert.ok(long.display.endsWith(`\n${NOTE}`), long.display);
    assert.ok(long.display.includes(longText), 'the full text is in the preview');
  });
});

// ── what the box says, and what the model is told ────────────────────────────

test('a reply says so in the lead', async () => {
  await withWire(async () => {
    const p = await prepare({ message: 'yes it did', reply_to: 'msg_arrived1' });
    const box = fakeBox({ action: 'decline' });
    await sendIn(p, box);
    assert.equal(box.asked[0].params.message, 'Reply to @linus: yes it did');
  });
});

test('tool results never carry the box text, the message, or the rev', async () => {
  await withWire(async () => {
    const secret = 'zebra quartz marker text';
    for (const answer of [accept, { action: 'decline' }, { action: 'cancel' }]) {
      const p = await prepare({ message: `${secret} ${answer.action}` });
      const r = await sendIn(p, fakeBox(answer));
      assert.ok(!r.display.includes('zebra'), r.display);
      assert.ok(!r.display.includes('To @linus:'), r.display);
      assert.ok(!r.display.includes(p.data.draft.rev), r.display);
      assert.ok(!/accept/i.test(r.display), 'never names the button');
    }
  });
});

// ── the real server, over stdio ──────────────────────────────────────────────

const INDEX = path.join(__dirname, '..', 'index.js');
function server(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-srv-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
  const env = { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: 'http://127.0.0.1:9', CLAUDE_CONFIG_DIR: USERDIR, CLAUDE_PROJECT_DIR: PROJECT, ...extraEnv };
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const rows = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { rows.push(JSON.parse(l)); } catch {} }
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const waitFor = (pred, ms = 15_000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => { const r = rows.find(pred); if (r) return resolve(r); if (Date.now() - t0 > ms) return reject(new Error(`timed out; saw ${JSON.stringify(rows).slice(0, 600)}`)); setTimeout(check, 20); };
    check();
  });
  const close = () => { try { child.kill(); } catch {} fs.rmSync(home, { recursive: true, force: true }); };
  return { send, waitFor, rows, close };
}

test('over stdio: a client that declared elicitation gets the box; its Decline comes back as the tool result', async () => {
  const s = server();
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: 'claude-code', version: 'test' } } });
    assert.equal((await s.waitFor((r) => r.id === 1)).result.protocolVersion, '2025-11-25');
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'over the wire' } } });
    const prep = await s.waitFor((r) => r.id === 2);
    const rev = prep.result.content[0].text.match(/rev ([0-9a-f]{8})/)[1];
    const id = prep.result.content[0].text.match(/draft (w[0-9a-f]+)/)[1];
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: { id, rev } } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    assert.equal(req.params.message, 'To @linus: over the wire');
    assert.deepEqual(req.params.requestedSchema, { type: 'object', properties: {} });
    assert.equal(req.params.mode, 'form');
    // Another request is answered while the box is open.
    s.send({ id: 4, method: 'tools/list' });
    await s.waitFor((r) => r.id === 4);
    s.send({ id: req.id, result: { action: 'decline' } });
    const res = await s.waitFor((r) => r.id === 3);
    assert.equal(res.result.content[0].text, 'Not sent: they chose not to send this to @linus. Do not offer it again unless they ask.');
  } finally { s.close(); }
});

test('over stdio: no box for a client that declared none, an older protocol, or a stateless request', async () => {
  for (const init of [
    { protocolVersion: '2025-11-25', capabilities: {} },
    { protocolVersion: '2025-03-26', capabilities: { elicitation: {} } },
  ]) {
    const s = server();
    try {
      s.send({ id: 1, method: 'initialize', params: { ...init, clientInfo: { name: 'claude-code', version: 'test' } } });
      await s.waitFor((r) => r.id === 1);
      s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'no box' } } });
      const prep = await s.waitFor((r) => r.id === 2);
      const rev = prep.result.content[0].text.match(/rev ([0-9a-f]{8})/)[1];
      const id = prep.result.content[0].text.match(/draft (w[0-9a-f]+)/)[1];
      s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: { id, rev } } });
      await s.waitFor((r) => r.id === 3);
      assert.equal(s.rows.some((r) => r.method === 'elicitation/create'), false, JSON.stringify(init));
    } finally { s.close(); }
  }
  const s = server();
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} }, clientInfo: { name: 'claude-code', version: 'test' } } });
    await s.waitFor((r) => r.id === 1);
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'stateless' } } });
    const prep = await s.waitFor((r) => r.id === 2);
    const rev = prep.result.content[0].text.match(/rev ([0-9a-f]{8})/)[1];
    const id = prep.result.content[0].text.match(/draft (w[0-9a-f]+)/)[1];
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: { id, rev }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    await s.waitFor((r) => r.id === 3);
    assert.equal(s.rows.some((r) => r.method === 'elicitation/create'), false, 'stateless request');
  } finally { s.close(); }
});
