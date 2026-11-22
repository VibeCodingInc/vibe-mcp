'use strict';
// The voice (BRIEF-15, docs/VOICE.md): quiet, dry, true. Five switches in
// notice.js, each tested on and off:
//   voiceCharter   one sentence on how the agent speaks about /vibe matters
//   noticingLine   an offer leads with one true line on why this person
//   arrivalHeader  "Note from @x (2m ago), waiting at your pause:" (the person's line)
//   emptyStates    "Nothing waiting." / "Just you in here right now; ..." only where the state was read
//   itLanded       a one-line note back, as a draft, once per reply
// None of them changes how a send is checked (tools/drafts.js send path,
// confirm-box.js, turns.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';
for (const k of ['VIBE_AGENT_HANDLE', 'VIBE_AGENT_MINT_FILE', 'VIBE_NOTICE_VARIANT', 'VIBE_NOTICE_OFF', 'VIBE_LAB_CLOCK_OFFSET_HOURS', 'VIBE_LAB_DAY_STARTS']) delete process.env[k];
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
fs.writeFileSync(path.join(HOME, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: { mira: 1, kenji: 1 } }));

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');
const notice = require('../notice');
const store = require('../store');
const drafts = require('./drafts');
const arrival = require('../arrival');
const ssh = require('../session-start-hook.cjs');
const hookMod = require('../hooks/arrival-hook.cjs');

const LOCAL = { VIBE_API_URL: 'http://127.0.0.1:9' };
const PROD = { VIBE_API_URL: 'https://www.slashvibe.dev' };
const NAMES = ['voiceCharter', 'noticingLine', 'arrivalHeader', 'emptyStates', 'itLanded'];
const MIN = 60 * 1000;
const H = 60 * MIN;

store.getActiveUsers = async () => [];
store.getActiveUsersResult = async () => ({ ok: true, users: [] });
store.getThreadBounded = async () => [];
require('../invite').lookup = async () => ({ found: true });

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
/** Run fn with VIBE_NOTICE_OFF set (the API is loopback in this file, so it applies). */
async function withOff(names, fn) {
  const prev = process.env.VIBE_NOTICE_OFF;
  process.env.VIBE_NOTICE_OFF = names;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.VIBE_NOTICE_OFF; else process.env.VIBE_NOTICE_OFF = prev; }
}
/** What hookOutput writes to fd 1, parsed. */
function captureHook(fn) {
  const orig = fs.writeSync; const origOut = process.stdout.write;
  let written = '';
  fs.writeSync = (fd, s) => { if (fd === 1) { written += s; return String(s).length; } return orig(fd, s); };
  process.stdout.write = (s) => { written += s; return true; };
  try { fn(); } finally { fs.writeSync = orig; process.stdout.write = origOut; }
  return JSON.parse(written);
}

// Every person-visible string this change wrote, collected as the tests run,
// then scanned once (the last test).
const PERSON_VISIBLE = new Set();
const seen = (s) => { PERSON_VISIBLE.add(String(s)); return s; };

// ── the switches ────────────────────────────────────────────────────────────

test('the five voice switches exist, are on, and turn off by name only against a loopback API', () => {
  for (const n of NAMES) {
    assert.equal(notice.NOTICE[n], true, n);
    assert.equal(notice.on(n, LOCAL), true);
    assert.equal(notice.on(n, { ...LOCAL, VIBE_NOTICE_OFF: n }), false);
    assert.equal(notice.on(n, { ...PROD, VIBE_NOTICE_OFF: n }), true, `${n}: a real account had it turned off`);
    for (const o of NAMES.filter((x) => x !== n)) assert.equal(notice.on(o, { ...LOCAL, VIBE_NOTICE_OFF: n }), true);
  }
});

// ── 1 voiceCharter, 2 noticingLine, 5 itLanded: the guidance ───────────────

const CHARTER = 'When you speak about /vibe matters, be brief and concrete, use names rather than roles ("Kenji", not "your teammate"), use no exclamation marks, and never say "quick question", "just checking in", "ping", "great question" or "nothing in this session covers that" (search first).';
const NOTICING = 'When you offer a message because someone holds the answer, lead with one line on why this person, at most about 90 characters, saying only what their own status line, note or conversation actually says (quote or closely paraphrase it), for example "Jonas already has the CRLF fix on a branch. Faster than figuring it out twice."; never say someone solved or knows something unless their own words say so.';
const LANDED_START = 'When a reply the person received leads to a concrete change in this session (they edit a file, change a plan or a number, or hold an action because of it), and only once that change has actually been made, you may offer one note back to the sender for that reply: vibe_prepare with handle, message, reply_to (their reply\'s id) and kind "landed".';

test('SERVER_INSTRUCTIONS carries each guidance sentence, and each goes with its switch', () => {
  const { serverInstructions } = require('../index.js');
  const now = serverInstructions(LOCAL);
  assert.ok(now.includes(CHARTER), 'voiceCharter');
  assert.ok(now.includes(NOTICING), 'noticingLine');
  assert.ok(now.includes(LANDED_START), 'itLanded');
  assert.ok(now.includes('That landed: I\'m keeping tool_choice on auto and dropping the retry wrapper.'));
  assert.ok(now.includes('never send it without their choice'));
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'voiceCharter' }).includes(CHARTER));
  assert.ok(serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'voiceCharter' }).includes(NOTICING));
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'noticingLine' }).includes(NOTICING));
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'itLanded' }).includes(LANDED_START));
  assert.equal(serverInstructions({ ...PROD, VIBE_NOTICE_OFF: NAMES.join(',') }), serverInstructions(PROD), 'a real account always gets them');
  // The guidance itself keeps the house rule.
  for (const s of [CHARTER, NOTICING, LANDED_START]) assert.ok(!s.includes('!'), s);
});

test('the /vibe command leads an offer with the line on why this person, and describes the note back', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'hosts', 'vibe-command.md'), 'utf8');
  assert.ok(cmd.includes('led by one line on why this person: at most about 90 characters, saying only what their own status line, note or conversation actually says'));
  assert.ok(cmd.includes('Never say someone solved or knows something unless their own words say so.'));
  assert.ok(cmd.includes('`kind: "landed"`'));
  assert.ok(cmd.includes('If they declined one for that reply, do not offer it again.'));
  assert.ok(!/!(?!\[)/.test(cmd.replace(/`[^`]*`/g, '')), 'no exclamation mark in the command text');
});

test('docs/VOICE.md: the three sentences, the never-use list, and print only what the code observed', () => {
  const v = fs.readFileSync(path.join(ROOT, 'docs', 'VOICE.md'), 'utf8');
  assert.ok(v.includes('Write like a sharp colleague who speaks up only when it saves the other'));
  assert.ok(v.includes('Say only what is observably true'));
  assert.ok(v.includes('Keep the wit dry and earn it by being useful'));
  assert.ok(v.includes('Every line the product prints must be true of what the code observed.'));
  for (const p of ['Exclamation marks', 'Just checking in', 'Ping', 'Quick question', 'Nothing in this session covers that', 'Great question', 'Your teammate']) assert.ok(v.includes(p), p);
  assert.ok(fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').includes('docs/VOICE.md'));
});

// ── 3 arrivalHeader ─────────────────────────────────────────────────────────

const item = (over = {}) => ({ id: 'msg_abc123', from: 'maya_c', text: 'keep tool_choice on auto; drop the retry wrapper', unread: 1, kind: null, building: '', context: null, at: Date.now(), line: false, invited: false, note: null, ...over });

test('a person\'s message carries a header; its line for older hooks and its agent text are unchanged', () => {
  const now = Date.now();
  const r = arrival.render(item({ sentAt: now - 2 * MIN }));
  assert.equal(r.line, '/vibe · @maya_c wrote you: "keep tool_choice on auto; drop the retry wrapper"', 'the plain line stays as the fallback');
  assert.deepEqual(r.header, { from: 'maya_c', invited: false, said: 'keep tool_choice on auto; drop the retry wrapper', at: now - 2 * MIN, shift: 0 });
  assert.equal(seen(arrival.headerLine(r.header, now)), '/vibe · Note from @maya_c (2m ago), waiting at your pause: "keep tool_choice on auto; drop the retry wrapper"');
  assert.match(r.context, /^\/vibe — @maya_c just wrote to the person you are working with\./);
  return withOff('arrivalHeader', () => {
    const o = arrival.render(item({ sentAt: now }));
    assert.equal(o.header, undefined, 'switched off: no header');
    assert.equal(o.context, r.context);
  });
});

test('each arrival path: who gets the note form and who keeps its own line', () => {
  const now = Date.now();
  const line = require('../line');
  // An open line, a person writing: their own words, so the note form.
  const open = arrival.render(item({ line: true, sentAt: now - 5 * MIN }));
  assert.equal(seen(arrival.headerLine(open.header, now)), '/vibe · Note from @maya_c (5m ago), waiting at your pause: "keep tool_choice on auto; drop the retry wrapper"');
  // Someone they invited: said once, beside the age.
  const inv = arrival.render(item({ invited: true, sentAt: now - 30 * 1000 }));
  assert.equal(seen(arrival.headerLine(inv.header, now)), '/vibe · Note from @maya_c (just now; you invited them), waiting at your pause: "keep tool_choice on auto; drop the retry wrapper"');
  // An agent's ask and an agent's answer over an open line keep their own marks.
  const ask = arrival.render(item({ line: true, text: `is tool_choice on auto?${line.ASKED('maya_c')}` }));
  assert.equal(ask.header, undefined);
  assert.match(ask.line, /@maya_c's agent asked over your open line/);
  const ans = arrival.render(item({ line: true, text: `auto${line.ANSWERED('maya_c')}` }));
  assert.equal(ans.header, undefined);
  assert.match(ans.line, /@maya_c's agent answered/);
  // A door is somewhere to go, not a note.
  const door = require('../door');
  const card = door.card('maya_c', 'https://example.com/x', 'the x');
  assert.equal(arrival.render(item({ text: card })).header, undefined);
  // No time known: no age printed, never a guess.
  assert.equal(seen(arrival.headerLine(arrival.render(item()).header, now)), '/vibe · Note from @maya_c, waiting at your pause: "keep tool_choice on auto; drop the retry wrapper"');
});

test('the age: just now, minutes, hours, days; the hook and arrival.js agree', () => {
  for (const [ms, want] of [[0, 'just now'], [59 * 1000, 'just now'], [2 * MIN, '2m ago'], [59 * MIN, '59m ago'], [3 * H, '3h ago'], [49 * H, '2d ago'], [-5000, 'just now']]) {
    assert.equal(arrival.ago(ms), want);
    assert.equal(hookMod.ago(ms), want);
  }
  const h = { from: 'kenji', invited: true, said: 'try the CRLF fix', at: 1000, shift: 0 };
  assert.equal(hookMod.headerLine(h, 1000 + 7 * MIN), arrival.headerLine(h, 1000 + 7 * MIN));
  // A lab's shifted display clock rides along (labclock.js).
  assert.equal(hookMod.headerLine({ ...h, at: 1000 + 24 * H, shift: 24 * H }, 1000 + 7 * MIN), arrival.headerLine({ ...h, at: 1000 + 24 * H, shift: 24 * H }, 1000 + 7 * MIN));
});

test('the hook prints the note form only from a well-formed header, else the plain line', () => {
  const now = Date.now();
  const row = { line: '/vibe · @maya_c wrote you: "hi"', header: { from: 'maya_c', said: 'hi', at: now - 3 * MIN, shift: 0, invited: false } };
  assert.equal(hookMod.shownLine(row, now), '/vibe · Note from @maya_c (3m ago), waiting at your pause: "hi"');
  for (const bad of [{ ...row.header, from: 'a b' }, { ...row.header, from: 'x\n' }, { ...row.header, said: 'two\nlines' }, { ...row.header, said: 7 }, { ...row.header, said: 'x'.repeat(200) }, null, 'str']) {
    assert.equal(hookMod.shownLine({ ...row, header: bad }, now), row.line, JSON.stringify(bad));
  }
  assert.equal(hookMod.shownLine({ line: row.line }, now), row.line, 'a row from before the switch');
});

test('arrival hook end to end: a spooled arrival is shown in the note form at the next prompt, once', () => {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-hook-'));
  const env = { VIBE_HOME: vh };
  const sent = Date.now() - 4 * MIN;
  const rows = arrival.record([{ handle: 'kenji', unread: 1, lastMessage: 'the CRLF fix is on a branch', lastMessageId: 'msg_kenji1', lastFrom: 'kenji', lastActorKind: 'human', muted: false, lastTimestamp: sent }], 'ada', { since: sent - 1000, env });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].header, 'the row carries the header');
  const run = (event) => JSON.parse(spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: event, session_id: 's1' }), env: { PATH: process.env.PATH, VIBE_ARRIVALS_DIR: arrival.spoolDir(env), VIBE_TURNS_DIR: path.join(vh, 'turns') }, encoding: 'utf8' }).stdout);
  const out = run('UserPromptSubmit');
  assert.match(seen(out.systemMessage), /^\/vibe · Note from @kenji \((4|5)m ago\), waiting at your pause: "the CRLF fix is on a branch"$/);
  assert.match(out.hookSpecificOutput.additionalContext, /@kenji just wrote to the person you are working with/);
  assert.deepEqual(run('PostToolUse'), { suppressOutput: true }, 'once');
  fs.rmSync(vh, { recursive: true, force: true });
});

test('session start, one message: "Note from @x (when):", ", still waiting" when shown before; more than one keeps the count', () => {
  const now = Date.now();
  const y = new Date(now); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
  assert.equal(seen(ssh.startNoteLine({ from: 'mira', text: 'is site_tz an IANA name?', seen: false, at: y.getTime() }, now)), '/vibe · Note from @mira (yesterday): “is site_tz an IANA name?”');
  assert.equal(seen(ssh.startNoteLine({ from: 'mira', text: 'is site_tz an IANA name?', seen: true, at: y.getTime() }, now)), '/vibe · Note from @mira (yesterday), still waiting: “is site_tz an IANA name?”');
  assert.equal(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: now - 12 * MIN }, now), '/vibe · Note from @mira (12m ago): “q”');
  assert.equal(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: null }, now), '/vibe · Note from @mira: “q”', 'no time known, none printed');
  assert.ok(!/pause/.test(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: now }, now)), 'nothing waited for a pause at session start');

  const one = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now - 12 * MIN }]));
  assert.equal(one.systemMessage, '/vibe · Note from @mira (12m ago): “q”');
  const two = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now }, { id: 'msg_2', from: 'kenji', text: 'r', seen: false, at: now }]));
  assert.equal(two.systemMessage, '/vibe · 2 messages waiting · latest from @mira: “q”');
  return withOff('arrivalHeader', () => {
    const off = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now }]));
    assert.equal(off.systemMessage, '/vibe · 1 message waiting · from @mira: “q”');
  });
});

// ── 4 emptyStates ───────────────────────────────────────────────────────────

function withStore(stubs, fn) {
  return async () => {
    const orig = {};
    for (const [k, v] of Object.entries(stubs)) { orig[k] = store[k]; store[k] = v; }
    try { return await fn(); } finally { for (const [k, v] of Object.entries(orig)) store[k] = v; }
  };
}
const nowMs = Date.now();
const hereU = (h) => ({ handle: h, status: 'active', lastSeen: nowMs - MIN, heartbeat: nowMs - MIN, one_liner: 'x' });

test('vibe_people: "Just you in here" only when presence was read and nobody else is in a session', withStore({
  getActiveUsersResult: async () => ({ ok: true, users: [] }),
  getInboxResult: async () => ({ ok: true, threads: [] }),
}, async () => {
  const people = require('./people');
  const r = await people.handler();
  assert.ok(r.display.startsWith(seen(people.JUST_YOU)), r.display);
  assert.equal(people.JUST_YOU, "Just you in here right now; notes wait till they're back.");
  await withOff('emptyStates', async () => {
    assert.ok((await people.handler()).display.startsWith('nobody else is in a session right now'));
  });
  store.getActiveUsersResult = async () => ({ ok: false, users: [] });
  const failed = await people.handler();
  assert.ok(failed.display.startsWith("couldn't see who is here right now"), 'a failed read is not an empty room');
  assert.ok(!failed.display.includes(people.JUST_YOU));
  store.getActiveUsersResult = async () => ({ ok: true, users: [hereU('zed')] });
  const stranger = await people.handler();
  assert.ok(!stranger.display.includes(people.JUST_YOU), 'someone is here, even if not someone they know');
  assert.match(stranger.display, /nobody you know is in a session right now \(1 other person is\)/);
}));

test('vibe_start: "Nothing waiting." only when the conversations were read and nothing is unread or ended on their words', withStore({
  getActiveUsersResult: async () => ({ ok: true, users: [] }),
  getInboxResult: async () => ({ ok: true, threads: [{ handle: 'mira', unread: 0, lastFrom: 'ada', lastTimestamp: nowMs - H, lastMessageId: 'm1' }] }),
  getIdentityKind: async () => null,
  heartbeat: async () => ({}),
}, async () => {
  const start = require('./start');
  const r = await start.handler({});
  assert.ok(r.display.includes(`\n\n${seen(start.NOTHING_WAITING)}\n${require('./people').JUST_YOU}`), r.display);
  await withOff('emptyStates', async () => {
    const off = await start.handler({});
    assert.ok(!off.display.includes('Nothing waiting.') && !off.display.includes('Just you'));
  });
  // Unread: something is waiting.
  store.getInboxResult = async () => ({ ok: true, threads: [{ handle: 'mira', unread: 1, lastFrom: 'mira', lastTimestamp: nowMs - H, lastMessageId: 'm2' }] });
  assert.ok(!(await start.handler({})).display.includes('Nothing waiting.'));
  // Read, but they wrote last: not "nothing waiting".
  store.getInboxResult = async () => ({ ok: true, threads: [{ handle: 'mira', unread: 0, lastFrom: 'mira', lastTimestamp: nowMs - 2 * 24 * H, lastMessageId: 'm3' }] });
  assert.ok(!(await start.handler({})).display.includes('Nothing waiting.'));
  // The read failed: its own words, never an empty state.
  store.getInboxResult = async () => ({ ok: false, threads: [] });
  store.getActiveUsersResult = async () => ({ ok: false, users: [] });
  const failed = await start.handler({});
  assert.ok(failed.display.includes("couldn't read your conversations") && failed.display.includes("couldn't see who's here"));
  assert.ok(!failed.display.includes('Nothing waiting.') && !failed.display.includes('Just you'));
  // Someone else is here: not "just you".
  store.getInboxResult = async () => ({ ok: true, threads: [] });
  store.getActiveUsersResult = async () => ({ ok: true, users: [hereU('zed')] });
  assert.ok(!(await start.handler({})).display.includes('Just you'));
}));

test('session start: the wry line only when the inbox was read empty, at most once a day, and never beside something waiting', () => {
  assert.equal(seen(ssh.QUIET_MOMENT), 'Nothing waiting. Rare moment — enjoy it.');
  const quiet = captureHook(() => ssh.hookOutput([], [], [], 0, null, 0, [], [], { quietMoment: true }));
  assert.equal(quiet.systemMessage, '/vibe · Nothing waiting. Rare moment — enjoy it.');
  assert.match(quiet.hookSpecificOutput.additionalContext, /nothing is waiting for them on \/vibe\. Do not repeat it\./);
  assert.deepEqual(captureHook(() => ssh.hookOutput([], [], [], 0, null, 0, [], [], {})), { suppressOutput: true }, 'not known empty: silence');
  const withMsg = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: null }], [], [], 0, null, 0, [], [], { quietMoment: true }));
  assert.ok(!withMsg.systemMessage.includes('Nothing waiting'));
  const withStranger = captureHook(() => ssh.hookOutput([], [], [], 1, null, 0, [], [], { quietMoment: true }));
  assert.ok(!withStranger.systemMessage.includes('Nothing waiting'));
  return withOff('emptyStates', () => {
    assert.deepEqual(captureHook(() => ssh.hookOutput([], [], [], 0, null, 0, [], [], { quietMoment: true })), { suppressOutput: true });
  });
});

test('inboxEmpty: only a read that succeeded, with nobody else\'s message unread', () => {
  assert.equal(ssh.inboxEmpty({ ok: true, threads: [] }, 'ada'), true);
  assert.equal(ssh.inboxEmpty({ ok: true, threads: [{ unread: 1, lastFrom: 'ada' }] }, 'ada'), true, 'their own last word is not waiting');
  assert.equal(ssh.inboxEmpty({ ok: true, threads: [{ unread: 1, lastFrom: 'mira' }] }, 'ada'), false);
  assert.equal(ssh.inboxEmpty({ ok: false, threads: [] }, 'ada'), false);
  assert.equal(ssh.inboxEmpty([], 'ada'), false, 'a read given up on');
  assert.equal(ssh.inboxEmpty(null, 'ada'), false);
});

test('once a day per machine: momentFree until markMoment, then free again the next local day', () => {
  const file = path.join(HOME, 'nothing-waiting.json');
  try { fs.unlinkSync(file); } catch {}
  const t = new Date(2026, 10, 21, 9, 0).getTime();
  assert.equal(ssh.momentFree(t), true);
  ssh.markMoment(t);
  assert.equal(ssh.momentFree(t + 3 * H), false, 'later the same day');
  assert.equal(ssh.momentFree(new Date(2026, 10, 22, 0, 5).getTime()), true, 'the next day');
  fs.writeFileSync(file, 'not json');
  assert.equal(ssh.momentFree(t), true, 'an unreadable marker does not block it forever');
});

// The real session-start hook against the lab stub: the read, the once-a-day
// file, and quiet.
function homeFor(handle, known) {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-start-'));
  const token = `h.${Buffer.from(JSON.stringify({ sub: handle, handle, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token, provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(known.map((h) => [h, 1])) }));
  return vh;
}
function sitDown(vh, apiUrl, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '', ...extra },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve(JSON.parse(out || '{}')); });
  });
}
const startStub = async (people) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people });

test('session start end to end: the wry line the first time, silence the second; a waiting note instead when there is one', async () => {
  const stub = await startStub({ ada: {}, mira: {} });
  try {
    const vh = homeFor('ada', ['mira']);
    // Who is here is its own line (mira is in a session in the stub); the rest is what this tests.
    const lines = (o) => String(o.systemMessage || '').split('\n').filter((l) => !/here now:/.test(l));
    const first = await sitDown(vh, stub.url);
    assert.deepEqual(lines(first), ['/vibe · Nothing waiting. Rare moment — enjoy it.']);
    assert.ok(fs.existsSync(path.join(vh, 'nothing-waiting.json')));
    assert.deepEqual(lines(await sitDown(vh, stub.url)), [], 'once a day');
    stub.post('mira', 'ada', 'is site_tz an IANA name?');
    const third = await sitDown(vh, stub.url);
    assert.equal(lines(third).length, 1);
    assert.match(lines(third)[0], /^\/vibe · Note from @mira \((just now|\dm ago)\): “is site_tz an IANA name\?”$/);
    // Switched off: a clean start says nothing, as before.
    const vh2 = homeFor('ada', ['mira']);
    const stub2 = await startStub({ ada: {}, mira: {} });
    try { assert.deepEqual(lines(await sitDown(vh2, stub2.url, { VIBE_NOTICE_OFF: 'emptyStates' })), []); } finally { await stub2.close(); }
    // Quiet shows nothing at all.
    const vh3 = homeFor('ada', ['mira']);
    fs.writeFileSync(path.join(vh3, 'reach.json'), JSON.stringify({ quiet: true, muted: {}, known: { mira: 1 } }));
    const stub3 = await startStub({ ada: {}, mira: {} });
    try { assert.deepEqual(await sitDown(vh3, stub3.url), { suppressOutput: true }); } finally { await stub3.close(); }
  } finally { await stub.close(); }
});

test('session start end to end: an API that cannot be reached is silence, never "nothing waiting"', async () => {
  const vh = homeFor('ada', ['mira']);
  assert.deepEqual(await sitDown(vh, 'http://127.0.0.1:9', { VIBE_SESSION_START_DEADLINE_MS: '1500' }), { suppressOutput: true });
  assert.ok(!fs.existsSync(path.join(vh, 'nothing-waiting.json')), 'nothing recorded');
});

// ── 5 itLanded ──────────────────────────────────────────────────────────────

const prep = (args) => drafts.vibe_prepare.handler(args);
const LINE = "That landed: I'm keeping tool_choice on auto and dropping the retry wrapper.";

test('kind "landed": validated before anything is drafted', async () => {
  const bad = await prep({ handle: 'mira', message: LINE, reply_to: 'msg_r1', kind: 'thanks' });
  assert.equal(bad.display, seen('Not prepared: kind may only be "landed" (a note back to say their reply was used). Nothing was sent.'));
  const noReply = await prep({ handle: 'mira', message: LINE, kind: 'landed' });
  assert.equal(noReply.display, seen('Not prepared: a note back ("landed") needs reply_to, the id of the reply it is about. Nothing was sent.'));
  const twoLines = await prep({ handle: 'mira', message: 'That landed.\nThanks again', reply_to: 'msg_r1', kind: 'landed' });
  assert.equal(twoLines.display, seen('Not prepared: a note back ("landed") is one line. Nothing was sent.'));
  const long = await prep({ handle: 'mira', message: 'x'.repeat(drafts.LANDED_MAX + 1), reply_to: 'msg_r1', kind: 'landed' });
  assert.match(seen(long.display), /^Not prepared: a note back \("landed"\) is one short line, at most 160 characters\. Nothing was sent\.$/);
  assert.equal(drafts.loadDrafts().filter((d) => d.kind === 'landed').length, 0, 'nothing drafted');
});

test('a note back is an ordinary draft with a label: same rev and same send path, the kind shown in the preview', async () => {
  const r = await prep({ handle: 'mira', message: LINE, reply_to: 'msg_r1', kind: 'landed' });
  assert.ok(r.display.includes(`**To:** @mira`), r.display);
  assert.ok(r.display.includes(`\n${seen(drafts.LANDED_LABEL)}\n**Message (exact):**\n${LINE}\n`), r.display);
  assert.equal(drafts.LANDED_LABEL, 'A note back to say their answer was used.');
  assert.equal(r.data.draft.kind, 'landed');
  assert.ok(r.display.includes('**Answers:** #msg_r1'));
  assert.ok(r.display.includes('Send to @mira · Edit · Cancel — nothing has been sent.'));
  const d = drafts.loadDrafts().find((x) => x.id === r.data.draft.id);
  assert.equal(d.kind, 'landed');
  const { kind, ...plain } = d;
  assert.equal(drafts.revOf(plain), drafts.revOf(d), 'not part of the rev, so not part of what Send checks');
  assert.equal(r.data.draft.rev, drafts.revOf(d));
  assert.deepEqual(r.data.actions.map((a) => a.tool), ['vibe_send', 'vibe_prepare', 'vibe_discard']);
  await drafts.vibe_discard.handler({ id: d.id });
});

test('once per reply: open, declined, or after the draft itself is gone; another reply is its own', async () => {
  const first = await prep({ handle: 'kenji', message: 'That landed: CRLF fix merged into the parser.', reply_to: 'msg_k1', kind: 'landed' });
  const id = first.data.draft.id;
  const again = await prep({ handle: 'kenji', message: 'That landed, again.', reply_to: 'msg_k1', kind: 'landed' });
  assert.equal(again.display, seen(`Not prepared: a note back for that reply is already open (draft ${id}). Edit it with vibe_prepare {id: "${id}", message: "..."} or leave it. Nothing was sent.`));
  await drafts.vibe_discard.handler({ id });
  const declined = await prep({ handle: 'kenji', message: 'That landed, really.', reply_to: 'msg_k1', kind: 'landed' });
  assert.equal(declined.display, seen(`Not prepared: a note back for that reply was already offered (draft ${id}). Once per reply. Nothing was sent.`));
  // The draft store forgets drafts after a day; the note-back ledger does not.
  drafts.transact((all) => { all.splice(0, all.length); });
  const gone = await prep({ handle: 'kenji', message: 'That landed, still.', reply_to: 'msg_k1', kind: 'landed' });
  assert.match(gone.display, /already offered/);
  const ledger = JSON.parse(fs.readFileSync(drafts.LANDED_FILE, 'utf8'));
  assert.deepEqual(Object.keys(ledger).filter((k) => k.startsWith('ada>kenji#')), ['ada>kenji#msg_k1']);
  assert.equal(ledger['ada>kenji#msg_k1'].draft, id);
  // A different reply, or the same id to someone else, is a different note.
  const other = await prep({ handle: 'kenji', message: 'That landed too.', reply_to: 'msg_k2', kind: 'landed' });
  assert.equal(other.data.draft.kind, 'landed');
  await drafts.vibe_discard.handler({ id: other.data.draft.id });
  // An ordinary reply to the same message is not limited by any of this.
  const plain = await prep({ handle: 'kenji', message: 'Also: does the fix cover the Windows runner?', reply_to: 'msg_k1' });
  assert.equal(plain.data.draft.kind, undefined);
  await drafts.vibe_discard.handler({ id: plain.data.draft.id });
});

test('editing: a note back keeps its reply and stays one line; an ordinary draft cannot become one', async () => {
  const r = await prep({ handle: 'mira', message: 'That landed: keeping auto.', reply_to: 'msg_m9', kind: 'landed' });
  const id = r.data.draft.id;
  const moved = await prep({ id, message: 'That landed.', reply_to: 'msg_other' });
  assert.equal(moved.display, seen(`Not changed: draft ${id} is a note back about one reply; it cannot be moved to another. Nothing was sent.`));
  assert.equal((await prep({ id, message: 'two\nlines' })).display, 'Not prepared: a note back ("landed") is one line. Nothing was sent.');
  const edited = await prep({ id, message: 'That landed: keeping tool_choice on auto.' });
  assert.ok(edited.display.includes(drafts.LANDED_LABEL));
  assert.equal(edited.data.draft.kind, 'landed');
  await drafts.vibe_discard.handler({ id });
  const plain = await prep({ handle: 'mira', message: 'Plain question about the queue?' });
  const made = await prep({ id: plain.data.draft.id, message: 'That landed.', kind: 'landed' });
  assert.equal(made.display, seen(`Not changed: draft ${plain.data.draft.id} is an ordinary message; a note back ("landed") is opened as a new draft with handle, message and reply_to. Nothing was sent.`));
  await drafts.vibe_discard.handler({ id: plain.data.draft.id });
});

test('switched off: kind is ignored, the draft is ordinary and unlabelled', () => withOff('itLanded', async () => {
  const r = await prep({ handle: 'mira', message: LINE, reply_to: 'msg_off1', kind: 'landed' });
  assert.ok(!r.display.includes(drafts.LANDED_LABEL));
  assert.equal(r.data.draft.kind, undefined);
  const bad = await prep({ handle: 'mira', message: 'x', reply_to: 'msg_off2', kind: 'anything' });
  assert.ok(!/^Not prepared/.test(bad.display), 'not validated when off');
  for (const id of [r.data.draft.id, bad.data.draft.id]) await drafts.vibe_discard.handler({ id });
}));

test('a note back left unsent is declined, never an unsent reply to be reminded of', () => {
  const unsent = require('../unsent');
  const at = Date.now() - 2 * H;
  const d = (over) => ({ id: 'w0a1b2c3d', status: 'previewed', from: 'ada', to: 'mira', createdAt: at, revAt: at, revFor: 'x', body: 'b', ...over });
  const threads = [{ handle: 'mira', lastFrom: 'mira', unread: 0 }];
  assert.equal(unsent.openReplies([d({})], threads, 'ada').length, 1, 'an ordinary unsent reply is still one');
  assert.equal(unsent.openReplies([d({ kind: 'landed' })], threads, 'ada').length, 0);
});

test('vibe_prepare advertises kind with the one allowed value', () => {
  const k = drafts.vibe_prepare.definition.inputSchema.properties.kind;
  assert.deepEqual(k.enum, ['landed']);
  assert.match(k.description, /changes nothing about how the message is checked or sent/);
});

// ── 6 the lab ───────────────────────────────────────────────────────────────

test('lab: arrival header forms are named in the transcript; notes back are counted per world', async () => {
  const lab = await import(path.join(ROOT, 'lab', 'population.mjs'));
  assert.deepEqual(lab.arrivalHeaders('/vibe · Note from @ben (2m ago), waiting at your pause: "hi"'), ['pause']);
  assert.deepEqual(lab.arrivalHeaders('/vibe · here now: @ben\n/vibe · Note from @ben (yesterday), still waiting: “hi”'), ['start']);
  assert.deepEqual(lab.arrivalHeaders('/vibe · Note from @ben: “hi”'), ['start']);
  assert.deepEqual(lab.arrivalHeaders('/vibe · @ben wrote you: "hi"'), []);
  assert.deepEqual(lab.arrivalHeaders('/vibe · Nothing waiting. Rare moment — enjoy it.'), []);

  const ev = [];
  const at = (e) => { const x = { i: ev.length, who: 'ada', day: 1, entry: 0, session_id: 's1', ...e }; ev.push(x); return x; };
  let n = 0;
  const call = (tool, input, text) => { const id = `t${++n}`; at({ kind: 'tool', name: `mcp__vibe__${tool}`, id, input }); at({ kind: 'returned', tool_use_id: id, name: `mcp__vibe__${tool}`, text }); };
  const preview = (d) => `Send to @ben · Edit · Cancel — nothing has been sent.  _(draft ${d} · rev r1)_`;
  at({ kind: 'prompt', text: 'keep tool_choice on auto', session: 'new' });
  at({ kind: 'shown', text: '/vibe · Note from @ben (3m ago), waiting at your pause: "tool_choice on auto"' });
  call('vibe_prepare', { handle: 'ben', message: 'That landed: keeping auto.', reply_to: 'm1', kind: 'landed' }, preview('w1'));
  call('vibe_prepare', { id: 'w1', message: 'That landed: keeping tool_choice on auto.' }, preview('w1'));
  at({ kind: 'human_reply', text: 'send it', session: 'resumed' });
  call('vibe_send', { id: 'w1', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_1_');
  call('vibe_prepare', { handle: 'ben', message: 'That landed too.', reply_to: 'm2', kind: 'landed' }, preview('w2'));
  call('vibe_prepare', { handle: 'ben', message: 'ordinary' }, preview('w3'));
  const world = { id: 'w-landed', archetype: 'x', relationship: 'established', open_line: false, people: { ada: { name: 'Ada', role: 'r', says: 's', persona: 'p' }, ben: { name: 'Ben', role: 'r', says: 's', persona: 'p' } }, timeline: [{ who: 'ada', day: 1, prompt: 'p' }] };
  const s = lab.analyse({ world, transcript: ev, turnsLog: [], wire: [], handles: ['ada', 'ben'], started: Date.now() });
  assert.equal(s.landed_offered, 2);
  assert.equal(s.landed_sent, 1);
});

// ── every person-visible string touched here ────────────────────────────────

test('no person-visible string this change wrote has an exclamation mark or a never-use phrase', () => {
  // The strings collected above, plus the fixed ones.
  for (const s of [require('./people').JUST_YOU, require('./start').NOTHING_WAITING, ssh.QUIET_MOMENT, drafts.LANDED_LABEL]) seen(s);
  assert.ok(PERSON_VISIBLE.size >= 15, `only ${PERSON_VISIBLE.size} strings were collected`);
  const NEVER = [/!/, /\bawesome\b/i, /\bamazing\b/i, /\bexcited to\b/i, /just checking in/i, /touching base/i, /circling back/i, /ai-powered/i, /\bmagic\b/i, /\bseamless/i, /\bproactively\b/i, /i went ahead/i, /\bping\b/i, /\bnudge\b/i, /\bpoke\b/i, /your teammate/i, /\bcollaborator\b/i, /quick question/i, /nothing in this session covers that/i, /welcome to \/vibe/i, /get started/i, /quick tour/i, /great question/i, /no problem/i, /don't worry/i];
  for (const s of PERSON_VISIBLE) for (const re of NEVER) assert.ok(!re.test(s), `${re} in: ${s}`);
});
