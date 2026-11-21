'use strict';
// The lab's population runner (lab/population.mjs): the pure pieces only.
// Nothing here starts a Claude Code session, a stub or a /vibe server: world
// validation, the vibe_send outcome classifier, the summary's send figures and
// the --human-cmd player (run against a tiny shell stub).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lab = () => import(path.join(ROOT, 'lab', 'population.mjs'));

const person = (name) => ({ name, role: 'engineer', says: `${name} work`, persona: 'plain' });
function world(days, extra = {}) {
  return {
    id: 'w-days', archetype: 'a week', relationship: 'established', open_line: false,
    people: { ada: person('Ada'), ben: person('Ben') },
    timeline: days.map((day, i) => ({ who: i % 2 ? 'ben' : 'ada', day, prompt: `day ${day}` })),
    ...extra,
  };
}

test('a five-day world is accepted, in day order', async () => {
  const { validateWorld } = await lab();
  assert.deepEqual(validateWorld(world([1, 1, 2, 3, 3, 4, 5])), []);
  assert.deepEqual(validateWorld(world([1, 7])), []);
});

test('day 8, day 0, a fractional day and a string day are rejected', async () => {
  const { validateWorld } = await lab();
  for (const bad of [8, 0, 2.5, '2']) {
    const errs = validateWorld(world([1, bad]));
    assert.ok(errs.some((e) => /timeline\[1\]\.day must be a whole number from 1 to 7/.test(e)), `${bad}: ${errs.join('\n')}`);
  }
});

test('a timeline out of day order is rejected (days are played in order)', async () => {
  const { validateWorld } = await lab();
  const errs = validateWorld(world([1, 3, 2]));
  assert.ok(errs.some((e) => /timeline\[2\]\.day is 2 after a day-3 entry/.test(e)), errs.join('\n'));
});

// ── --human-cmd ─────────────────────────────────────────────────────────────

test('--human-cmd is parsed; the player is recorded as "cmd", never the command', async () => {
  const { parseArgs, humanPlayer } = await lab();
  const o = parseArgs(['w.json', '--out', 'o', '--human-cmd', 'SECRET_KEY=abc my-player']);
  assert.equal(o.humanCmd, 'SECRET_KEY=abc my-player');
  assert.equal(humanPlayer(o), 'cmd');
  assert.equal(humanPlayer(parseArgs(['w.json', '--human-model', 'opus'])), 'opus');
  assert.equal(humanPlayer(parseArgs(['w.json'])), 'sonnet');
  assert.throws(() => parseArgs(['--human-cmd']), /needs a value/);
  assert.throws(() => parseArgs(['--human-cmd', '  ']), /needs a command/);
});

test('--human-cmd: the stub command\'s stdout is parsed like the built-in player\'s', async () => {
  const { askHumanCmd } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  try {
    const h = await askHumanCmd({ prompt: 'p', cmd: 'cat > /dev/null; echo \'{"reply":"ok","why":"t"}\'', emptyDir: dir, timeoutMs: 10000 });
    assert.equal(h.isError, false);
    assert.equal(h.timedOut, false);
    assert.deepEqual(h.parsed, { reply: 'ok', why: 't' });
    const nothing = await askHumanCmd({ prompt: 'p', cmd: 'echo \'{"reply":null,"why":"nothing to say"}\'', emptyDir: dir, timeoutMs: 10000 });
    assert.deepEqual(nothing.parsed, { reply: null, why: 'nothing to say' });
    const failed = await askHumanCmd({ prompt: 'p', cmd: 'echo \'{"reply":"ok","why":"t"}\'; exit 3', emptyDir: dir, timeoutMs: 10000 });
    assert.equal(failed.isError, true); assert.equal(failed.code, 3); assert.equal(failed.parsed, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--human-cmd gets the full prompt on stdin, runs in the empty dir, and sees no /vibe variables', async () => {
  const { askHumanCmd, humanPrompt, HUMAN_SYSTEM } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-rec-'));
  try {
    const prompt = humanPrompt(person('Ada'), 'ada', 'fix the limits', '[Claude]\ndone', '');
    const env = { PATH: process.env.PATH, VIBE_HOME: '/nope/.vibe', VIBE_API_URL: 'http://127.0.0.1:1', VIBE_AGENT_MINT_FILE: '/nope/mint', SLASHVIBE_TOKEN: 'x', KEEP_ME: 'yes' };
    const cmd = `cat > ${JSON.stringify(path.join(rec, 'stdin.txt'))}; pwd -P > ${JSON.stringify(path.join(rec, 'cwd.txt'))}; env > ${JSON.stringify(path.join(rec, 'env.txt'))}; echo '{"reply":"ok","why":"t"}'`;
    const h = await askHumanCmd({ prompt, cmd, emptyDir: dir, timeoutMs: 10000, env });
    assert.deepEqual(h.parsed, { reply: 'ok', why: 't' });
    assert.equal(fs.readFileSync(path.join(rec, 'stdin.txt'), 'utf8'), `${HUMAN_SYSTEM}\n\n${prompt}`);
    assert.equal(fs.readFileSync(path.join(rec, 'cwd.txt'), 'utf8').trim(), fs.realpathSync(dir));
    const seen = fs.readFileSync(path.join(rec, 'env.txt'), 'utf8');
    assert.ok(!/^(VIBE_|SLASHVIBE_)/m.test(seen), seen);
    assert.match(seen, /^KEEP_ME=yes$/m);
  } finally { for (const d of [dir, rec]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('--human-cmd: a command that outlives the timeout is killed with its children, and nothing is parsed', async () => {
  const { askHumanCmd } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  try {
    const t0 = Date.now();
    const h = await askHumanCmd({ prompt: 'p', cmd: 'sleep 30 | cat; echo \'{"reply":"late","why":"t"}\'', emptyDir: dir, timeoutMs: 300 });
    assert.equal(h.timedOut, true); assert.equal(h.isError, true); assert.equal(h.parsed, null);
    assert.ok(Date.now() - t0 < 10000, 'the timeout did not end the command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── what a vibe_send call did ───────────────────────────────────────────────
// Every result wording vibe_send can print, copied from tools/drafts.js,
// tools/deliver.js, store/api.js and index.js. When one of those changes, this
// list is where the lab learns it.

const PREVIEW = 'To: @ben\nMessage (exact):\nheads up\nSend to @ben · Edit · Cancel — nothing has been sent.  _(draft w_1 · rev r1)_';
const HELD_PREVIEW = '**To:** @newbie (not on /vibe yet)\nKeep for @newbie · Edit · Cancel — nothing has been sent.  _(draft w_1 · rev r1)_';
const UNCONFIRMED_TAIL = '\n\n_Draft w_1 is kept as unconfirmed: Send again retries exactly this text (delivers once), or Cancel._';
const ASK = 'Show them the preview below exactly as it is and wait for their choice. If they choose Send, call vibe_send again with this id and rev.';

const REFUSED = [
  // tools/drafts.js send()
  'Nothing sent. vibe_send sends only a draft the person approved: pass its id and rev. To write to someone, open a draft with vibe_prepare (handle + message).',
  `Nothing sent. vibe_send sends only a draft the person approved, so this opened one instead. Show the person this preview and send it only if they choose Send.\n\n${PREVIEW}`,
  'No draft w_1 — nothing sent. Open it with vibe_prepare first.',
  'Draft w_1 was prepared as @ada; you are signed in as @ben. Nothing sent — open a new draft as yourself.',
  'Draft w_1 is already held for @newbie — not creating a second invitation. Join link: https://www.slashvibe.dev/join/ABC',
  'Draft w_1 was already sent to @ben — not sending it twice.',
  'Draft w_1 was cancelled — nothing sent. Open a new draft if you want it back.',
  'Send needs the rev shown in the preview of draft w_1 — open it with vibe_prepare and send with that rev. Nothing sent.',
  'Draft w_1 is not the version that rev names. Show it again with vibe_prepare {id: "w_1"}, and send only what the person approves after seeing it. Nothing sent.',
  'Draft w_1 is already being sent — not sending it twice.',
  'Draft w_1: the last Keep for @newbie did not confirm — the invitation may or may not have been created, and a second try could create two. Cancel it, then open a new draft if you still want to say it. Nothing more was done.',
  'Draft w_1: the earlier Send to @ben did not confirm, and this transport cannot deduplicate a retry. Cancel it (the earlier attempt may have reached them) and open a new draft if you still want to say it. Nothing sent.',
  // tools/drafts.js unseenRefusal(): the turn check
  `Not sent yet: this draft was last shown in an earlier session, so the person has not seen it in this one. It can go after their next message. ${ASK}\n\n${PREVIEW}`,
  `Not sent yet: this session's start could not be read on this machine, so it cannot be told whether the person has seen this draft here. ${ASK}\n\n${PREVIEW}`,
  `Not sent yet: the draft was shown again just now; it can go after their next message. ${ASK}\n\n${PREVIEW}`,
  `Not sent yet: the text changed, and the person has not seen this version. A changed draft must be shown again before it can be sent. ${ASK}\n\n${PREVIEW}`,
  `Not sent yet: they have not typed a message since it was shown (a pick in a question menu does not count). ${ASK}\n\n${PREVIEW}`,
  `Not sent yet: they have not typed a message since it was shown (a pick in a question menu does not count). Show them the preview below exactly as it is and wait for their choice. If they choose Keep, call vibe_send again with this id and rev.\n\n${HELD_PREVIEW}`,
  // tools/drafts.js keepHeld() / createHeld() / heldRefusal(): a Keep refused
  'Nothing was kept. Holding a message for someone needs the /vibe service; this session is in local mode.',
  'Nothing was kept. The message is 2400 chars and the limit is 2000. Edit it shorter, then keep it again.',
  'Nothing was kept. The message has a character /vibe cannot keep. Edit it, then keep it again.',
  'Nothing was kept. @newbie joined /vibe since you saw the preview, so this draft is cancelled. Prepare it again and it goes to them directly.',
  'Nothing was kept. /vibe could not be reached. Try again in a moment.',
  'Nothing was kept. /vibe does not see you signed in. Run `npx slashvibe-mcp setup` in a terminal to sign in, then keep it again.',
  'Nothing was kept. Holding a message for someone needs a fresh sign-in on this machine. Run `npx slashvibe-mcp setup` in a terminal, then keep it again.',
  'Nothing was kept. You already have 3 unused invitations, the most /vibe allows at once. Pass on one of the links you already have; a slot opens when someone signs in with one or it expires after 30 days.',
  'Nothing was kept. The message is over the 2000-char limit. Edit it shorter, then keep it again.',
  'Nothing was kept. What /vibe would store is not what you approved. Open the draft again with vibe_prepare and approve what it shows now.',
  'Nothing was kept. /vibe refused the invitation (HTTP 500). Try again in a moment.',
  // tools/_shared.js requireInit (send() and deliver())
  "You're not signed in yet. Run `npx slashvibe-mcp setup` in a terminal — GitHub opens in your browser and your username becomes your @handle.",
  // tools/deliver.js
  'Nothing sent. Who is it for?',
  "You can't message yourself.",
  'Nothing sent. The message is empty.',
  'Not sent. The message is 2400 chars and the limit is 2000. Nothing was delivered; shorten it and send again.',
  // store/api.js sendMessage, definite (no "kept as unconfirmed" tail)
  'Authentication failed. Sign in again by running `npx slashvibe-mcp setup` in a terminal.',
  "You're not signed in yet — sending a DM needs a /vibe identity. Run `npx slashvibe-mcp setup` in a terminal to sign in with GitHub (opens a browser), then try again.",
  'Your /vibe session expired. Run `npx slashvibe-mcp setup` in a terminal to sign in again.',
  'The approved text does not match what would be stored.\n\n_Worth one retry._',
  'Failed to send message.\n\n_Worth one retry._',
  // index.js gates
  '@ada-agent is not signed in to /vibe. token expired\nNothing was done. This is fixed by whoever runs this agent, not from inside the session.',
  "Sign in first, then ask for `send` again.\n\nOpen this link to sign in: http://127.0.0.1/x",
  "Signed in as @ada.\n\nYou're signed in. Ask for `send` again.",
  'Sign in to /vibe first (say "sign in to /vibe"). boom',
];

const UNCONFIRMED = [
  `That didn't send — socket hang up. Nothing confirmed; the draft is still here.${UNCONFIRMED_TAIL}`,
  `/vibe answered, but its reply could not be read, so it is not known whether the message was stored. It may or may not have reached them.${UNCONFIRMED_TAIL}`,
  `That didn't send — the connection dropped mid-request. Nothing was delivered. Worth one retry.${UNCONFIRMED_TAIL}`,
  `That didn't send. Nothing was delivered.\n\n_Worth one retry._${UNCONFIRMED_TAIL}`,
  `Failed to save message. Please try again.${UNCONFIRMED_TAIL}`,
  'The invitation could not be confirmed — it may or may not have been created.\n\n_Draft w_1 is kept as unconfirmed. Keeping it again could create a second invitation, so the only choice left is Cancel._',
  '/vibe answered, but not with an invitation held for this account. It may or may not have been created.\n\n_Draft w_1 is kept as unconfirmed. Keeping it again could create a second invitation, so the only choice left is Cancel._',
];

test('every refusal wording of vibe_send is classified as refused', async () => {
  const { sendOutcome } = await lab();
  for (const text of REFUSED) assert.equal(sendOutcome(text), 'refused', text);
});

test('only a receipt or a held invitation counts as gone out; uncertain attempts are their own outcome', async () => {
  const { sendOutcome } = await lab();
  assert.equal(sendOutcome('Sent to **@ben**\n_receipt: msg_1 · 12 chars stored · 2026-11-21T10:00:00Z_'), 'sent');
  assert.equal(sendOutcome('Sent to **@ben**\nlength mismatch: sent 12 chars, server stored 10. The stored copy is not what you approved.'), 'sent');
  assert.equal(sendOutcome('Sent to **@ben**\n_@ben is not in a session right now. It reaches them when they next are._\n\nYou and @ben have written back and forth a few times.'), 'sent');
  assert.equal(sendOutcome('Held for @newbie. /vibe created the invitation.\n**Join link:** https://www.slashvibe.dev/join/ABC'), 'held');
  for (const text of UNCONFIRMED) assert.equal(sendOutcome(text), 'unconfirmed', text);
  assert.equal(sendOutcome('Something new the lab has never seen.'), 'unrecognised');
  assert.equal(sendOutcome('Sent to **@ben**', true), 'error');
  assert.equal(sendOutcome(''), 'no_result');
});

// A transcript in the runner's own event shape (see runWorld/analyse).
function sendStory() {
  const ev = [];
  const at = (e) => { const x = { i: ev.length, who: 'ada', day: 1, entry: 0, session_id: 's1', ...e }; ev.push(x); return x; };
  let n = 0;
  const call = (tool, input, text) => { const id = `t${++n}`; at({ kind: 'tool', name: `mcp__vibe__${tool}`, id, input }); at({ kind: 'returned', tool_use_id: id, name: `mcp__vibe__${tool}`, text }); };
  const preview = (d) => `Send to @ben · Edit · Cancel — nothing has been sent.  _(draft ${d} · rev r1)_`;
  at({ kind: 'prompt', text: 'finish the limits', session: 'new' });
  // w1: shown, sent at once (refused by the turn check), the person says send, it goes.
  call('vibe_prepare', { handle: 'ben', message: 'heads up' }, preview('w1'));
  call('vibe_send', { id: 'w1', rev: 'r1' }, `Not sent yet: they have not typed a message since it was shown (a pick in a question menu does not count). ${ASK}\n\n${preview('w1')}`);
  at({ kind: 'human_reply', text: 'send it', session: 'resumed' });
  call('vibe_send', { id: 'w1', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_1_');
  // w2: shown and sent with no reply between (as if the product let it through).
  call('vibe_prepare', { handle: 'ben', message: 'one more' }, preview('w2'));
  call('vibe_send', { id: 'w2', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_2_');
  // w3: the person answers the preview, the refusal shows it again, and the next send has no reply after that showing.
  call('vibe_prepare', { handle: 'ben', message: 'third' }, preview('w3'));
  at({ kind: 'human_reply', text: 'ok send', session: 'resumed' });
  call('vibe_send', { id: 'w3', rev: 'r1' }, `Not sent yet: the draft was shown again just now; it can go after their next message. ${ASK}\n\n${preview('w3')}`);
  call('vibe_send', { id: 'w3', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_3_');
  // w4: refused for good; never sent.
  call('vibe_prepare', { handle: 'ben', message: 'fourth' }, preview('w4'));
  call('vibe_send', { id: 'w4', rev: 'zz' }, 'Draft w4 is not the version that rev names. Show it again with vibe_prepare {id: "w4"}, and send only what the person approves after seeing it. Nothing sent.');
  // w5: vibe_send in the old shape (no id) opens w5 and shows it; the person says send; it goes.
  call('vibe_send', { handle: 'ben', message: 'fifth' }, `Nothing sent. vibe_send sends only a draft the person approved, so this opened one instead. Show the person this preview and send it only if they choose Send.\n\n${preview('w5')}`);
  at({ kind: 'human_reply', text: 'yes send', session: 'resumed' });
  call('vibe_send', { id: 'w5', rev: 'r1' }, 'Sent to **@ben**\n_receipt: msg_5_');
  return ev;
}

test('unattended counts only sends that went out with no human reply since the draft was last shown; refusals are counted apart', async () => {
  const { analyse } = await lab();
  const w = world([1]);
  const s = analyse({ world: w, transcript: sendStory(), turnsLog: [], wire: [], handles: ['ada', 'ben'], started: Date.now() });
  assert.equal(s.send_calls, 8);
  assert.equal(s.refused_sends.count, 4);
  assert.deepEqual(s.refused_sends.list.map((x) => x.draft), ['w1', 'w3', 'w4', null]);
  assert.equal(s.sends_with_human_reply_between, 2);
  assert.equal(s.sends_without_human_reply_between_prepare_and_send.count, 2);
  assert.deepEqual(s.sends_without_human_reply_between_prepare_and_send.list.map((x) => x.draft), ['w2', 'w3']);
  const w3 = s.sends_without_human_reply_between_prepare_and_send.list[1];
  assert.ok(w3.last_shown_event > w3.prepare_event, 'the refusal that showed w3 again is its last showing');
  assert.equal(w3.human_reply_to_an_earlier_rev.length, 1);
  assert.deepEqual(s.send_call_outcomes, { refused: 4, sent: 4 });
});

test('the population summary carries refused sends and the person-player', async () => {
  const { writePopulation } = await lab();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-sum-'));
  try {
    const summary = { id: 'w', archetype: 'a', human_player: 'cmd', refused_sends: { count: 2, list: [] }, sends_without_human_reply_between_prepare_and_send: { count: 1, list: [] } };
    const agg = writePopulation(out, [{ file: 'w.json', id: 'w', summary }], { humanCmd: 'my-player --key SECRET', humanModel: 'sonnet' });
    assert.equal(agg.totals.refused_sends, 2);
    assert.equal(agg.human_player, 'cmd');
    const md = fs.readFileSync(path.join(out, 'population-summary.md'), 'utf8');
    const json = fs.readFileSync(path.join(out, 'population-summary.json'), 'utf8');
    assert.match(md, /refused_sends/); assert.match(md, /Person-player: cmd/);
    assert.ok(!/SECRET|my-player/.test(md + json), 'the command string was recorded');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ── three people ────────────────────────────────────────────────────────────

const trio = (extra = {}) => ({ ...world([1, 1, 2]), people: { ada: person('Ada'), ben: person('Ben'), cara: person('Cara') },
  timeline: [{ who: 'ada', day: 1, prompt: 'a' }, { who: 'cara', day: 1, prompt: 'c' }, { who: 'ben', day: 2, prompt: 'b' }], ...extra });

test('a world of three people is accepted; one or four are not', async () => {
  const { validateWorld } = await lab();
  assert.deepEqual(validateWorld(trio()), []);
  assert.deepEqual(validateWorld(trio({ relationship: 'fresh_invite', inviter: 'cara' })), []);
  const four = trio(); four.people.dan = person('Dan');
  assert.ok(validateWorld(four).some((e) => /two or three handles \(got 4\)/.test(e)));
  const one = world([1]); delete one.people.ben; one.timeline = [{ who: 'ada', day: 1, prompt: 'a' }];
  assert.ok(validateWorld(one).some((e) => /two or three handles \(got 1\)/.test(e)));
  assert.ok(validateWorld(trio({ relationship: 'fresh_invite', inviter: 'zed' })).some((e) => /inviter: one of the handles/.test(e)));
});

test('three people: wire figures are per recipient, and two invitees do not know each other', async () => {
  const { analyse } = await lab();
  const ev = [];
  const at = (e) => { const x = { i: ev.length, day: 1, session_id: `s-${e.who}`, ...e }; ev.push(x); return x; };
  at({ who: 'ada', entry: 0, kind: 'prompt', text: 'a' });                                   // 0: ada sends to ben and cara; ben sends to cara
  at({ who: 'cara', entry: 1, kind: 'prompt', text: 'c' });                                  // 1
  at({ who: 'cara', entry: 1, kind: 'shown', text: '@ada and @ben are here now: ok\n/vibe: a message from @ada and @ben' }); // 2
  at({ who: 'ben', entry: 2, kind: 'prompt', text: 'b', day: 2 });                           // 3
  at({ who: 'ben', entry: 2, kind: 'shown', text: '/vibe: @ada wrote: limits are 60/min', day: 2 }); // 4
  const wire = [
    { id: 'm1', at: 0, from: 'ada', to: 'ben', body: 'limits are 60/min' },
    { id: 'm2', at: 0, from: 'ada', to: 'cara', body: 'docs need the new numbers' },
    { id: 'm3', at: 0, from: 'ben', to: 'cara', body: 'can you check retry copy' },
    { id: 'm4', at: 3, from: 'cara', to: 'ada', body: 'done' },
  ];
  const handles = ['ada', 'ben', 'cara'];
  const est = analyse({ world: trio(), transcript: ev, turnsLog: [], wire: wire.map((w) => ({ ...w })), handles, started: Date.now() });
  assert.equal(est.per_person.cara.arrivals_shown, 1, 'a line naming two people is one arrival');
  assert.equal(est.per_person.cara.presence_lines_shown, 1);
  assert.deepEqual(est.wire_messages_by_recipient.ben, { received: 1, shown: 1, never_shown: 0, held_sender_unknown: 0, shown_late: 0, from: { ada: 1, cara: 0 } });
  assert.deepEqual(est.wire_messages_by_recipient.cara, { received: 2, shown: 2, never_shown: 0, held_sender_unknown: 0, shown_late: 0, from: { ada: 1, ben: 1 } });
  assert.deepEqual(est.wire_messages_by_recipient.ada, { received: 1, shown: 0, never_shown: 1, held_sender_unknown: 0, shown_late: 0, from: { ben: 0, cara: 1 } });
  assert.deepEqual(est.wire_messages_never_shown_to_recipient.by_recipient, { ada: 1, ben: 0, cara: 0 });
  // fresh_invite, inviter ada: cara -> ada was known (pair with the inviter);
  // a message between the two invitees that never showed is held, not a miss.
  const ev2 = ev.filter((e) => e.i !== 2).map((e, i) => ({ ...e, i }));
  const wire2 = [{ id: 'm3', at: 0, from: 'ben', to: 'cara', body: 'can you check retry copy' }, { id: 'm4', at: 0, from: 'cara', to: 'ada', body: 'done' }];
  const fresh = analyse({ world: trio({ relationship: 'fresh_invite', inviter: 'ada' }), transcript: ev2, turnsLog: [], wire: wire2, handles, started: Date.now() });
  assert.deepEqual(fresh.wire_messages_held_sender_unknown.by_recipient, { ada: 0, ben: 0, cara: 1 });
  assert.deepEqual(fresh.wire_messages_never_shown_to_recipient.by_recipient, { ada: 1, ben: 0, cara: 0 });
});
