'use strict';
// The voice (BRIEF-15, docs/VOICE.md): quiet, dry, true. Five switches in
// notice.js, each tested on and off:
//   voiceCharter   one sentence on how the agent speaks about /vibe matters
//   noticingLine   an offer leads with one true line on why this person
//   arrivalHeader  "Note from @x (2m ago), waiting at your pause:" (the person's line)
//   emptyStates    "Nothing waiting." / "Nobody else shows as here right now; ..." only where the state was read
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
const LANDED_START = 'Finishing work that used a reply includes saying so. When a reply the person received has been used in this session (a file changed, a plan or a number changed, or an action held because of it), then once that change has actually been made, end that reply of yours with one line offering to tell the sender it was used, and open that note with vibe_prepare: handle, message, reply_to (their reply\'s id), kind "landed" and asked: false. Exactly once per reply they received.';

test('SERVER_INSTRUCTIONS carries each guidance sentence, and each goes with its switch', () => {
  const { serverInstructions } = require('../index.js');
  const now = serverInstructions(LOCAL);
  assert.ok(now.includes(CHARTER), 'voiceCharter');
  assert.ok(now.includes(NOTICING), 'noticingLine');
  assert.ok(now.includes(LANDED_START), 'itLanded');
  assert.ok(now.includes('never send it without their choice'));
  // A normal part of finishing the work, no longer a maybe.
  assert.ok(!/you may offer one note back/.test(now));
  // landedReceipt (on): the note back is a receipt; the "That landed" one-liner is gone.
  assert.ok(now.includes(`${LANDED_START} ${notice.LANDED_RECEIPT} It is at most 160 characters, for example "${notice.LANDED_RECEIPT_EXAMPLE}"; if they declined one for that reply, do not offer it again, and never send it without their choice.`));
  assert.ok(!now.includes('That landed: I\'m keeping tool_choice on auto'));
  // The earlier text, with landedReceipt off (loopback only); every limit kept there.
  const before = serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'landedReceipt' });
  assert.ok(before.includes(LANDED_START) && !before.includes(notice.LANDED_RECEIPT));
  assert.ok(before.includes('That landed: I\'m keeping tool_choice on auto and dropping the retry wrapper.'));
  for (const limit of ['once that change has actually been made', 'one line, at most about 100 characters', "in the person's own terms", 'no file paths, code', 'invented feelings or claimed savings', 'if they declined one for that reply, do not offer it again']) assert.ok(before.includes(limit), limit);
  assert.equal(serverInstructions({ ...PROD, VIBE_NOTICE_OFF: 'landedReceipt' }), serverInstructions(PROD), 'landedReceipt: a real account always gets it');
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'voiceCharter' }).includes(CHARTER));
  assert.ok(serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'voiceCharter' }).includes(NOTICING));
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'noticingLine' }).includes(NOTICING));
  assert.ok(!serverInstructions({ ...LOCAL, VIBE_NOTICE_OFF: 'itLanded' }).includes(LANDED_START));
  assert.equal(serverInstructions({ ...PROD, VIBE_NOTICE_OFF: NAMES.join(',') }), serverInstructions(PROD), 'a real account always gets them');
  // The guidance itself keeps the house rule.
  for (const s of [CHARTER, NOTICING, LANDED_START, notice.LANDED_RECEIPT, notice.LANDED_RECEIPT_SHORT]) assert.ok(!s.includes('!'), s);
});

test('the /vibe command leads an offer with the line on why this person, and describes the note back', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'hosts', 'vibe-command.md'), 'utf8');
  assert.ok(cmd.includes('led by one line on why this person: at most about 90 characters, saying only what their own status line, note or conversation actually says'));
  assert.ok(cmd.includes('Never say someone solved or knows something unless their own words say so.'));
  assert.ok(cmd.includes('`kind: "landed"`'));
  assert.ok(cmd.includes('If they declined one for that reply, do not offer it again.'));
  assert.ok(cmd.includes('end that reply of yours with one line offering to tell the sender it was used'));
  assert.ok(cmd.includes('`kind: "landed"` and `asked: false`'));
  assert.ok(cmd.includes('Exactly once per reply they received.'));
  assert.ok(cmd.includes('once that change has actually been made'));
  assert.ok(!cmd.includes('you may offer one note back'));
  // landedReceipt: the command carries the same rule as SERVER_INSTRUCTIONS.
  assert.ok(cmd.includes(notice.LANDED_RECEIPT), 'the receipt rule');
  assert.ok(cmd.includes(`It is at most 160 characters, for example "${notice.LANDED_RECEIPT_EXAMPLE}"`));
  assert.ok(cmd.includes('`vibe_prepare` refuses a note back with a question mark in it.'));
  assert.ok(!cmd.includes('That landed: I\'m keeping tool_choice on auto'));
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
  assert.equal(r.line, '/vibe · @maya_c wrote you: keep tool_choice on auto; drop the retry wrapper', 'the plain line stays as the fallback');
  assert.deepEqual(r.header, { from: 'maya_c', invited: false, said: 'keep tool_choice on auto; drop the retry wrapper', bare: true, at: now - 2 * MIN, shift: 0 });
  assert.equal(seen(arrival.headerLine(r.header, now)), '/vibe · Note from @maya_c (2m ago), waiting at your pause: keep tool_choice on auto; drop the retry wrapper');
  assert.match(r.context, /^\/vibe — @maya_c just wrote to the person you are working with\./);
  return withOff('arrivalHeader', () => {
    const o = arrival.render(item({ sentAt: now }));
    assert.equal(o.header, undefined, 'switched off: no header');
    // Equal but for the fence's nonce, new on every rendering (incoming.js fence).
    const nonceless = (s) => s.replace(/[0-9a-f]{8}(?=>>>)/g, 'N').replace(/^(<<<\w+ )[0-9a-f]{8}$/gm, '$1N');
    assert.equal(nonceless(o.context), nonceless(r.context));
  });
});

test('each arrival path: who gets the note form and who keeps its own line', () => {
  const now = Date.now();
  const line = require('../line');
  // An open line, a person writing: their own words, so the note form.
  const open = arrival.render(item({ line: true, sentAt: now - 5 * MIN }));
  assert.equal(seen(arrival.headerLine(open.header, now)), '/vibe · Note from @maya_c (5m ago), waiting at your pause: keep tool_choice on auto; drop the retry wrapper');
  // Someone they invited: said once, beside the age.
  const inv = arrival.render(item({ invited: true, sentAt: now - 30 * 1000 }));
  assert.equal(seen(arrival.headerLine(inv.header, now)), '/vibe · Note from @maya_c (just now; you invited them), waiting at your pause: keep tool_choice on auto; drop the retry wrapper');
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
  assert.equal(seen(arrival.headerLine(arrival.render(item()).header, now)), '/vibe · Note from @maya_c, waiting at your pause: keep tool_choice on auto; drop the retry wrapper');
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
  // A row spooled before codeFidelity (no bare) is printed as it was, in quotes.
  assert.equal(hookMod.shownLine(row, now), '/vibe · Note from @maya_c (3m ago), waiting at your pause: "hi"');
  assert.equal(hookMod.shownLine({ ...row, header: { ...row.header, bare: true } }, now), '/vibe · Note from @maya_c (3m ago), waiting at your pause: hi');
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
  assert.match(seen(out.systemMessage), /^\/vibe · Note from @kenji \((4|5)m ago\), waiting at your pause: the CRLF fix is on a branch$/);
  assert.match(out.hookSpecificOutput.additionalContext, /@kenji just wrote to the person you are working with/);
  assert.deepEqual(run('PostToolUse'), { suppressOutput: true }, 'once');
  fs.rmSync(vh, { recursive: true, force: true });
});

test('session start, one message: "Note from @x (when):", ", still waiting" when shown before; more than one keeps the count', () => {
  const now = Date.now();
  const y = new Date(now); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
  assert.equal(seen(ssh.startNoteLine({ from: 'mira', text: 'is site_tz an IANA name?', seen: false, at: y.getTime() }, now)), '/vibe · Note from @mira (yesterday): is site_tz an IANA name?');
  assert.equal(seen(ssh.startNoteLine({ from: 'mira', text: 'is site_tz an IANA name?', seen: true, at: y.getTime() }, now)), '/vibe · Note from @mira (yesterday), still waiting: is site_tz an IANA name?');
  assert.equal(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: now - 12 * MIN }, now), '/vibe · Note from @mira (12m ago): q');
  assert.equal(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: null }, now), '/vibe · Note from @mira: q', 'no time known, none printed');
  assert.ok(!/pause/.test(ssh.startNoteLine({ from: 'mira', text: 'q', seen: false, at: now }, now)), 'nothing waited for a pause at session start');

  const one = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now - 12 * MIN }]));
  assert.equal(one.systemMessage, '/vibe · Note from @mira (12m ago): q');
  const two = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now }, { id: 'msg_2', from: 'kenji', text: 'r', seen: false, at: now }]));
  assert.equal(two.systemMessage, '/vibe · 2 messages waiting · latest from @mira: q');
  return withOff('arrivalHeader', () => {
    const off = captureHook(() => ssh.hookOutput([{ id: 'msg_1', from: 'mira', text: 'q', seen: false, at: now }]));
    assert.equal(off.systemMessage, '/vibe · 1 message waiting · from @mira: q');
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

test('vibe_people: "Nobody else shows as here" only when presence was read and nobody else is in a session', withStore({
  getActiveUsersResult: async () => ({ ok: true, users: [] }),
  getInboxResult: async () => ({ ok: true, threads: [] }),
}, async () => {
  const people = require('./people');
  const r = await people.handler();
  assert.ok(r.display.startsWith(seen(people.JUST_YOU)), r.display);
  assert.equal(people.JUST_YOU, "Nobody else shows as here right now; notes wait till they're back.");
  assert.ok(!/just you/i.test(people.JUST_YOU), 'an invisible person may be in a session');
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
    assert.ok(!off.display.includes('Nothing waiting.') && !off.display.includes(require('./people').JUST_YOU));
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
  assert.ok(!failed.display.includes('Nothing waiting.') && !failed.display.includes(require('./people').JUST_YOU));
  // Someone else is here: not "just you".
  store.getInboxResult = async () => ({ ok: true, threads: [] });
  store.getActiveUsersResult = async () => ({ ok: true, users: [hereU('zed')] });
  assert.ok(!(await start.handler({})).display.includes(require('./people').JUST_YOU));
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
    assert.match(lines(third)[0], /^\/vibe · Note from @mira \((just now|\dm ago)\): is site_tz an IANA name\?$/);
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

// ── 21 landedReceipt: a note back is a receipt, and asks nothing ────────────
// Outside review of 11 real notes back (2026-11-22): the worst smuggled a new
// request into the thank-you, gave an order, invented a number or reported no
// change; the best were receipts. The one mechanical rule: no question mark.

const RECEIPT_LINE = 'Your bare-ID answer landed: issue_refund pattern is now ^[0-9]{5,8}$ and the ORD- rule is out of the prompt. Not published to staging yet.';
const NO_QUESTION = 'Not prepared: a note back ("landed") carries no question. Put the question in a separate draft if the person wants to ask it. Nothing was sent.';
const QUESTIONS = [
  'Thanks, your 3,112 is in the postmortem. Can you pull a /v2/quotes failed count?',
  'Your 3,112 is in the postmortem. Can you pull the failed count\uFF1F',
  'Your 3,112 is in the postmortem. Can you pull the failed count\u061F',
];

test('landedReceipt: the switch exists, is on, and turns off by name only against a loopback API', () => {
  assert.equal(notice.NOTICE.landedReceipt, true);
  assert.equal(notice.on('landedReceipt', LOCAL), true);
  assert.equal(notice.on('landedReceipt', { ...LOCAL, VIBE_NOTICE_OFF: 'landedReceipt' }), false);
  assert.equal(notice.on('landedReceipt', { ...LOCAL, VIBE_NOTICE_VARIANT: 'off' }), false);
  assert.equal(notice.on('landedReceipt', { ...PROD, VIBE_NOTICE_OFF: 'landedReceipt' }), true, 'a real account had it turned off');
  assert.equal(notice.on('itLanded', { ...LOCAL, VIBE_NOTICE_OFF: 'landedReceipt' }), true, 'the note back itself stays on');
  assert.ok(Array.from(notice.LANDED_RECEIPT_EXAMPLE).length <= drafts.LANDED_MAX, 'the example fits the limit');
  assert.ok(!/[?\uFF1F\u061F]/.test(notice.LANDED_RECEIPT_EXAMPLE), 'the example asks nothing');
});

test('landedReceipt: a new note back with a question mark (?, fullwidth, Arabic) is refused, nothing drafted', async () => {
  const before = drafts.loadDrafts().filter((d) => d.kind === 'landed').length;
  for (const [i, q] of QUESTIONS.entries()) {
    const r = await prep({ handle: 'mira', message: q, reply_to: `msg_q${i}x`, kind: 'landed' });
    assert.equal(r.display, seen(NO_QUESTION), q);
  }
  assert.equal(drafts.LANDED_NO_QUESTION, NO_QUESTION);
  assert.equal(drafts.loadDrafts().filter((d) => d.kind === 'landed').length, before, 'nothing drafted');
  assert.ok(!fs.existsSync(drafts.LANDED_FILE) || !Object.keys(JSON.parse(fs.readFileSync(drafts.LANDED_FILE, 'utf8'))).some((k) => /#msg_q\dx$/.test(k)), 'no reply marked as offered');
  // A refused one can be opened again without the question: once per reply counts only what was opened.
  const ok = await prep({ handle: 'mira', message: RECEIPT_LINE, reply_to: 'msg_q0x', kind: 'landed' });
  assert.equal(ok.data.draft.kind, 'landed');
  assert.ok(ok.display.includes(`**Message (exact):**\n${RECEIPT_LINE}\n`));
  await drafts.vibe_discard.handler({ id: ok.data.draft.id });
});

test('landedReceipt: an edit of a note back that adds a question mark is refused; the draft is unchanged', async () => {
  const r = await prep({ handle: 'kenji', message: 'Your CRLF answer landed: the parser now strips \\r before splitting. Local only.', reply_to: 'msg_qe1', kind: 'landed' });
  const id = r.data.draft.id;
  const rev = r.data.draft.rev;
  for (const q of QUESTIONS) assert.equal((await prep({ id, message: q })).display, NO_QUESTION, q);
  const d = drafts.loadDrafts().find((x) => x.id === id);
  assert.equal(d.body, 'Your CRLF answer landed: the parser now strips \\r before splitting. Local only.');
  assert.equal(drafts.revOf(d), rev, 'the draft was not changed');
  const edited = await prep({ id, message: 'Your CRLF answer landed: the parser strips \\r first. Not deployed yet.' });
  assert.equal(edited.data.draft.kind, 'landed');
  await drafts.vibe_discard.handler({ id });
});

test('landedReceipt: an ordinary draft may still ask; only a note back is held to it', async () => {
  const r = await prep({ handle: 'kenji', message: 'Can you pull a /v2/quotes failed count?', reply_to: 'msg_qo1' });
  assert.equal(r.data.draft.kind, undefined);
  assert.ok(r.display.includes('Can you pull a /v2/quotes failed count?'));
  await drafts.vibe_discard.handler({ id: r.data.draft.id });
});

test('landedReceipt switched off (loopback only): a question mark in a note back is allowed again, as before', () => withOff('landedReceipt', async () => {
  const r = await prep({ handle: 'mira', message: QUESTIONS[0], reply_to: 'msg_qoff1', kind: 'landed' });
  assert.equal(r.data.draft.kind, 'landed');
  const e = await prep({ id: r.data.draft.id, message: QUESTIONS[1] });
  assert.equal(e.data.draft.kind, 'landed');
  // The guidance falls back with it: the hook, the kind field, the record.
  assert.equal(arrival.landedHook('msg_abc123'), HOOK_PLAIN('msg_abc123'));
  assert.ok(!drafts.vibe_prepare.definition.inputSchema.properties.kind.description.includes('receipt'));
  await drafts.vibe_discard.handler({ id: r.data.draft.id });
}));

test('landedReceipt is ignored against production: the refusal and the guidance stay', async () => {
  const { serverInstructions } = require('../index.js');
  assert.equal(arrival.landedHook('msg_abc123', { ...PROD, VIBE_NOTICE_OFF: 'landedReceipt' }), HOOK_FOR('msg_abc123'));
  assert.equal(arrival.landedHook('msg_abc123', { ...PROD, VIBE_NOTICE_VARIANT: 'off' }), HOOK_FOR('msg_abc123'));
  assert.ok(serverInstructions({ ...PROD, VIBE_NOTICE_OFF: 'landedReceipt' }).includes(notice.LANDED_RECEIPT));
  // vibe_prepare reads process.env: point it at production with the switch named off.
  const prev = { url: process.env.VIBE_API_URL, off: process.env.VIBE_NOTICE_OFF };
  process.env.VIBE_API_URL = PROD.VIBE_API_URL;
  process.env.VIBE_NOTICE_OFF = 'landedReceipt';
  try {
    assert.equal(notice.on('landedReceipt'), true);
    const r = await prep({ handle: 'mira', message: QUESTIONS[2], reply_to: 'msg_qprod1', kind: 'landed' });
    assert.equal(r.display, NO_QUESTION);
  } finally {
    process.env.VIBE_API_URL = prev.url;
    if (prev.off === undefined) delete process.env.VIBE_NOTICE_OFF; else process.env.VIBE_NOTICE_OFF = prev.off;
  }
});

test('landedReceipt: the kind field, the hook and the reminder say what a note back is', () => {
  const k = drafts.vibe_prepare.definition.inputSchema.properties.kind;
  assert.equal(k.description, 'Only "landed": a note back to someone whose reply led to a concrete change made in this session. Needs reply_to (their reply). Once per reply. It is a one-sentence receipt of what changed on the person\'s side: what was actually updated, "not deployed yet" or "local only" when it is not live, and no question, request or instruction to them (a question mark is refused); if nothing changed, do not open one. It changes nothing about how the message is checked or sent.');
  assert.deepEqual(k.enum, ['landed']);
  assert.ok(arrival.landedHook('msg_abc123').endsWith(RECEIPT));
  assert.equal(hookMod.LANDED_RECEIPT_SHORT, notice.LANDED_RECEIPT_SHORT, 'the hook\'s copy is the same text');
  for (const phrase of ['one-sentence receipt of what changed on the person\'s side', '"not deployed yet" or "local only"', 'only numbers and names that are in the person\'s files or in the answer itself', 'no question, no request and no instruction to the other person', 'a separate ordinary draft, offered separately', 'If nothing changed (the answer only agreed with what they had), there is no note back.']) {
    assert.ok(notice.LANDED_RECEIPT.includes(phrase), phrase);
  }
  for (const phrase of ['one-sentence receipt', '"not deployed yet" or "local only"', 'no question, request or instruction to them', 'separate ordinary draft', 'If nothing changed, no note back.']) assert.ok(notice.LANDED_RECEIPT_SHORT.includes(phrase), phrase);
});

test('docs/VOICE.md: the note back is a receipt, with the reviewed example', () => {
  const v = fs.readFileSync(path.join(ROOT, 'docs', 'VOICE.md'), 'utf8');
  assert.ok(v.includes('## The note back is a receipt'));
  assert.ok(v.includes(notice.LANDED_RECEIPT_EXAMPLE));
  assert.ok(v.includes('It carries no question, no request and no instruction to the other person.'));
  assert.ok(!v.includes("That landed: I'm keeping tool_choice on auto"));
});

// ── 5b the note-back hook, at the moment it matters ─────────────────────────

// landedAsDraft (lab 2026-11-22): the draft is the offer; agents had asked in prose instead.
// landedReceipt (on): what the note is, after the hook line.
const RECEIPT = ` ${notice.LANDED_RECEIPT_SHORT}`;
const HOOK_PLAIN = (id) => `If their answer changes what you do here, then once the change is made (in this reply or a later one), end that reply by opening one note back as a draft: vibe_prepare, kind landed, reply_to ${id}, asked: false. The draft is the offer and sends nothing; do not ask in prose whether they want one.`;
const HOOK_FOR = (id) => HOOK_PLAIN(id) + RECEIPT;
const HOOK_FOR_OLD = (id) => `If their answer changes what you do here, then once the change is made you can offer one note back (vibe_prepare, kind landed, reply_to ${id}, asked: false).${RECEIPT}`;

test('landedAsDraft switched off (loopback only): the earlier hook line', () => withOff('landedAsDraft', () => {
  assert.equal(arrival.landedHook('msg_abc123'), HOOK_FOR_OLD('msg_abc123'));
}).then(() => {
  assert.equal(arrival.landedHook('msg_abc123', PROD), HOOK_FOR('msg_abc123'));
  assert.equal(arrival.landedHook('msg_abc123', { ...PROD, VIBE_NOTICE_OFF: 'landedAsDraft' }), HOOK_FOR('msg_abc123'), 'a real account always gets the current text');
}));

test('arrival: a reply to the person\'s own message carries the note-back hook, for the agent only', () => {
  const now = Date.now();
  const mine = { project: 'agent loop', firstLine: 'auto or any for tool_choice?', sentAt: now - 30 * MIN, messageId: 'msg_mine1' };
  const r = arrival.render(item({ context: mine, sentAt: now - 2 * MIN }));
  assert.ok(r.context.includes(HOOK_FOR('msg_abc123')), r.context);
  assert.equal(arrival.landedHook('msg_abc123'), HOOK_FOR('msg_abc123'));
  assert.ok(!r.line.includes('note back') && !arrival.headerLine(r.header, now).includes('note back'), 'never in what the person is shown');
  // Absent: first contact, nothing of theirs known here, undecidable, an agent, an open line, someone just invited, switched off.
  assert.ok(!arrival.render(item({ sentAt: now })).context.includes('note back'), 'no record of a message of theirs');
  assert.ok(!arrival.render(item({ context: { ...mine, messageId: null }, sentAt: now })).context.includes('note back'), 'no message id: cannot be decided');
  assert.ok(!arrival.render(item({ context: mine })).context.includes('note back'), 'no time on the arrival: cannot be decided');
  assert.ok(!arrival.render(item({ context: mine, sentAt: now - 40 * MIN })).context.includes('note back'), 'written before the person\'s message');
  assert.ok(!arrival.render(item({ context: mine, sentAt: now, kind: 'agent' })).context.includes('note back'), 'an agent');
  assert.ok(!arrival.render(item({ context: mine, sentAt: now, line: true })).context.includes('note back'), 'an open line');
  assert.ok(!arrival.render(item({ context: mine, sentAt: now, invited: true })).context.includes('note back'), 'a first message after an invitation');
  return withOff('itLanded', () => {
    assert.ok(!arrival.render(item({ context: mine, sentAt: now })).context.includes('note back'), 'switched off');
  });
});

test('arrival.record: the binding of what the person sent decides the hook', () => {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-hook2-'));
  const env = { VIBE_HOME: vh };
  const now = Date.now();
  const row = (id, ts) => ({ handle: 'mira', unread: 1, lastMessage: 'auto is fine; drop the retry wrapper', lastMessageId: id, lastFrom: 'mira', lastActorKind: 'human', muted: false, lastTimestamp: ts });
  const binding = { from: 'ada', project: 'agent loop', firstLine: 'auto or any?', sentAt: now - 20 * MIN, messageId: 'msg_mine2' };
  const [withB] = arrival.record([row('msg_reply1', now - MIN)], 'ada', { since: now - 2 * MIN, env, bindingFor: () => binding });
  assert.ok(withB.context.includes(HOOK_FOR('msg_reply1')), withB.context);
  const [without] = arrival.record([row('msg_reply2', now - MIN)], 'ada', { since: now - 2 * MIN, env, bindingFor: () => null });
  assert.ok(!without.context.includes('note back'));
  fs.rmSync(vh, { recursive: true, force: true });
});

test('vibe_thread: the hook for their newest message when it answers one sent from here; absent otherwise', () => {
  const thread = require('./thread');
  const lineMod = require('../line');
  const now = Date.now();
  const bindings = drafts.BINDINGS_FILE;
  const prev = fs.existsSync(bindings) ? fs.readFileSync(bindings) : null;
  fs.writeFileSync(bindings, JSON.stringify({ mira: { from: 'ada', project: 'agent loop', firstLine: 'auto or any?', sentAt: now - 20 * MIN, messageId: 'msg_mine3' } }));
  try {
    const mineMsg = { id: 'msg_mine3', from: 'ada', body: 'auto or any for tool_choice?', timestamp: now - 20 * MIN };
    const reply = (over = {}) => ({ id: 'msg_r9', from: 'mira', body: 'auto; drop the retry wrapper', reply_to: { id: 'msg_mine3', from: 'ada', text: 'auto or any?' }, timestamp: now - 5 * MIN, ...over });
    const shown = thread.render('ada', 'mira', [mineMsg, reply()]);
    assert.ok(shown.includes(HOOK_FOR('msg_r9')), shown);
    assert.ok(shown.indexOf(HOOK_FOR('msg_r9')) < shown.indexOf('Conversation with @mira'), 'before the conversation');
    // reply_to as a bare id works the same.
    assert.ok(thread.render('ada', 'mira', [mineMsg, reply({ reply_to: 'msg_mine3' })]).includes(HOOK_FOR('msg_r9')));
    // Absent: not a reply (first contact), a reply to something not sent from here, an agent, an open-line ask or answer.
    assert.ok(!thread.render('ada', 'mira', [reply({ reply_to: null })]).includes('note back'), 'not a reply');
    assert.ok(!thread.render('ada', 'mira', [mineMsg, reply({ reply_to: { id: 'msg_elsewhere', from: 'ada', text: 'x' } })]).includes('note back'), 'no local record of the message it answers');
    assert.ok(!thread.render('ada', 'mira', [mineMsg, reply({ isAgent: true })]).includes('note back'), 'an agent');
    assert.ok(!thread.render('ada', 'mira', [mineMsg, reply({ body: `auto${lineMod.ANSWERED('mira')}` })]).includes('note back'), 'an open-line answer');
    assert.ok(!thread.render('ada', 'mira', [mineMsg, reply({ body: `auto?${lineMod.ASKED('mira')}` })]).includes('note back'), 'an open-line ask');
    // Their newest message decides: a later plain message without reply_to hides it.
    assert.ok(!thread.render('ada', 'mira', [mineMsg, reply(), { id: 'msg_r10', from: 'mira', body: 'also', timestamp: now - MIN }]).includes('note back'));
    // Switched off.
    withOff('itLanded', () => { assert.ok(!thread.render('ada', 'mira', [mineMsg, reply()]).includes('note back')); });
  } finally {
    if (prev === null) fs.rmSync(bindings, { force: true }); else fs.writeFileSync(bindings, prev);
  }
});

test('vibe_thread: once a note back was opened for that reply, the hook is gone', async () => {
  const thread = require('./thread');
  const now = Date.now();
  const bindings = drafts.BINDINGS_FILE;
  const prev = fs.existsSync(bindings) ? fs.readFileSync(bindings) : null;
  fs.writeFileSync(bindings, JSON.stringify({ mira: { from: 'ada', sentAt: now - 20 * MIN, messageId: 'msg_mine4', firstLine: 'q' } }));
  try {
    const msgs = [{ id: 'msg_mine4', from: 'ada', body: 'q', timestamp: now - 20 * MIN }, { id: 'msg_r11', from: 'mira', body: 'a', reply_to: 'msg_mine4', timestamp: now - MIN }];
    assert.ok(thread.render('ada', 'mira', msgs).includes(HOOK_FOR('msg_r11')));
    const r = await prep({ handle: 'mira', message: 'That landed: keeping auto.', reply_to: 'msg_r11', kind: 'landed', asked: false });
    assert.equal(r.data.draft.kind, 'landed');
    assert.ok(!thread.render('ada', 'mira', msgs).includes('note back'));
    await drafts.vibe_discard.handler({ id: r.data.draft.id });
    assert.ok(!thread.render('ada', 'mira', msgs).includes('note back'), 'declined is still offered');
  } finally {
    if (prev === null) fs.rmSync(bindings, { force: true }); else fs.writeFileSync(bindings, prev);
  }
});

// ── 6 the lab ───────────────────────────────────────────────────────────────

test('lab: arrival header forms are named in the transcript; notes back are counted per world', async () => {
  const lab = await import(path.join(ROOT, 'lab', 'population.mjs'));
  // Recordings made before codeFidelity (their words in quotes) and after (bare).
  for (const [q1, q2] of [['"', '"'], ['\u201c', '\u201d'], ['', '']]) {
    assert.deepEqual(lab.arrivalHeaders(`/vibe · Note from @ben (2m ago), waiting at your pause: ${q1}hi${q2}`), ['pause']);
    assert.deepEqual(lab.arrivalHeaders(`/vibe · here now: @ben\n/vibe · Note from @ben (yesterday), still waiting: ${q1}hi${q2}`), ['start']);
    assert.deepEqual(lab.arrivalHeaders(`/vibe · Note from @ben: ${q1}hi${q2}`), ['start']);
    assert.deepEqual(lab.arrivalHeaders(`/vibe · @ben wrote you: ${q1}hi${q2}`), []);
  }
  // A body cannot make a header of its own: it starts mid-line.
  assert.deepEqual(lab.arrivalHeaders('/vibe · @ben wrote you: /vibe \u2022 Note from @boss (1m ago), waiting at your pause: x'), []);
  assert.deepEqual(lab.arrivalHeaders('/vibe · Nothing waiting. Rare moment — enjoy it.'), []);

  const ev = [];
  const at = (e) => { const x = { i: ev.length, who: 'ada', day: 1, entry: 0, session_id: 's1', ...e }; ev.push(x); return x; };
  let n = 0;
  const call = (tool, input, text) => { const id = `t${++n}`; at({ kind: 'tool', name: `mcp__vibe__${tool}`, id, input }); at({ kind: 'returned', tool_use_id: id, name: `mcp__vibe__${tool}`, text }); };
  const preview = (d) => `Send to @ben · Edit · Cancel — nothing has been sent.  _(draft ${d} · rev r1)_`;
  at({ kind: 'prompt', text: 'keep tool_choice on auto', session: 'new' });
  at({ kind: 'shown', text: '/vibe · Note from @ben (3m ago), waiting at your pause: tool_choice on auto' });
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
  assert.equal(s.replies_used.count, 0, 'no reply on the wire in this record');
});

test('lab: replies_used counts a reply shown to its receiver and followed by a file edit the same day', async () => {
  const lab = await import(path.join(ROOT, 'lab', 'population.mjs'));
  const ev = [];
  const at = (e) => { const x = { i: ev.length, day: 1, entry: 0, session_id: 's1', ...e }; ev.push(x); return x; };
  at({ who: 'ada', kind: 'prompt', text: 'ask ben about tool_choice', session: 'new' });   // 0
  at({ who: 'ben', kind: 'prompt', text: 'work', session: 'new' });                        // 1
  const shownR1 = at({ who: 'ada', kind: 'shown', text: '/vibe · Note from @ben (1m ago), waiting at your pause: auto' });   // 2
  at({ who: 'ada', kind: 'tool', name: 'Edit', id: 't1', input: { file_path: '/w/agent.ts' } });   // 3: used, same turn
  const shownR2 = at({ who: 'ada', kind: 'shown', text: '/vibe · Note from @ben: "also"', day: 1 });   // 4: shown, nothing edited after it that day
  at({ who: 'ada', kind: 'tool', name: 'Read', id: 't2', input: { file_path: '/w/agent.ts' } });   // 5
  at({ who: 'ada', kind: 'tool', name: 'Write', id: 't3', input: { file_path: '/w/x.ts' }, day: 2 });   // 6: another day
  const shownR3 = at({ who: 'ben', kind: 'shown', text: '/vibe · Note from @ada: "auto or any?"' });   // 7: first contact to ben, then he edits
  at({ who: 'ben', kind: 'tool', name: 'Edit', id: 't4', input: { file_path: '/w/b.ts' } });   // 8
  const wire = [
    { id: 'm0', from: 'ada', to: 'ben', body: 'auto or any?', at: 0, shown_to_recipient: { how: 'line', event: shownR3.i } },
    { id: 'r1', from: 'ben', to: 'ada', body: 'auto', at: 1, shown_to_recipient: { how: 'line', event: shownR1.i } },
    { id: 'r2', from: 'ben', to: 'ada', body: 'also', at: 1, shown_to_recipient: { how: 'line', event: shownR2.i } },
    { id: 'r3', from: 'ben', to: 'ada', body: 'never shown', at: 1, shown_to_recipient: null },
  ];
  const u = lab.repliesUsed(ev, wire);
  assert.equal(u.count, 1, JSON.stringify(u.list));
  assert.deepEqual(u.list[0], { id: 'r1', from: 'ben', to: 'ada', day: 1, shown_event: 2, edit_event: 3, tool: 'Edit', file: '/w/agent.ts' });
  // A message with reply_to set is a reply even without an earlier one on the wire.
  const linked = lab.repliesUsed(ev, [{ id: 'r4', from: 'ada', to: 'ben', body: 'x', at: 0, reply_to: 'm_old', shown_to_recipient: { how: 'line', event: shownR3.i } }]);
  assert.equal(linked.count, 1);
});

// ── every person-visible string touched here ────────────────────────────────

test('no person-visible string this change wrote has an exclamation mark or a never-use phrase', () => {
  // The strings collected above, plus the fixed ones.
  for (const s of [require('./people').JUST_YOU, require('./start').NOTHING_WAITING, ssh.QUIET_MOMENT, drafts.LANDED_LABEL]) seen(s);
  assert.ok(PERSON_VISIBLE.size >= 15, `only ${PERSON_VISIBLE.size} strings were collected`);
  const NEVER = [/!/, /\bawesome\b/i, /\bamazing\b/i, /\bexcited to\b/i, /just checking in/i, /touching base/i, /circling back/i, /ai-powered/i, /\bmagic\b/i, /\bseamless/i, /\bproactively\b/i, /i went ahead/i, /\bping\b/i, /\bnudge\b/i, /\bpoke\b/i, /your teammate/i, /\bcollaborator\b/i, /quick question/i, /nothing in this session covers that/i, /welcome to \/vibe/i, /get started/i, /quick tour/i, /great question/i, /no problem/i, /don't worry/i];
  for (const s of PERSON_VISIBLE) for (const re of NEVER) assert.ok(!re.test(s), `${re} in: ${s}`);
});
