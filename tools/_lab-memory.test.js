'use strict';
// The lab's simulated people (lab/population.mjs, lab/player.mjs): memory
// across days, follow-through on what they said they would do, the lab clock
// the runner sets per day, and the summary's new counts. Pure pieces only:
// nothing here starts a Claude Code session, a stub or a /vibe server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lab = () => import(path.join(ROOT, 'lab', 'population.mjs'));
const player = () => import(path.join(ROOT, 'lab', 'player.mjs'));

const person = (name) => ({ name, role: 'engineer', says: `${name} work`, persona: 'plain' });
const pair = { id: 'w', archetype: 'a', relationship: 'established', open_line: false, people: { nora: person('Nora Lind'), tomas: person('Tomás Ruiz') }, timeline: [] };
const trio = { ...pair, people: { ...pair.people, kenji: person('Kenji Ota') } };

test('what a person says they will do themselves, and to whom', async () => {
  const { intentionsIn } = await lab();
  const one = (t, w = pair, self = 'nora') => intentionsIn(t, self, w);
  assert.deepEqual(one("nah i'll ask tomás about the hum myself, he's mid-pass so not pinging"), [{ text: 'ask tomás about the hum myself, he\'s mid-pass so not pinging', to: 'tomas' }]);
  assert.deepEqual(one('ill text him that tonight').map((x) => x.to), ['tomas']);
  assert.deepEqual(one("I'll ping her later").map((x) => x.to), ['tomas'], 'the only other person');
  assert.deepEqual(one('Let me check with @tomas first.').map((x) => x.to), ['tomas']);
  assert.deepEqual(one('will email Tomas tomorrow').map((x) => x.to), ['tomas']);
  assert.deepEqual(one("I'll ask them", trio).map((x) => x.to), [null], 'with two others a pronoun names nobody');
  assert.deepEqual(one("I'll message Kenji tonight", trio).map((x) => x.to), ['kenji']);
  for (const no of ["I'll check the logs", 'let me ask you something first', 'will paste it here', 'ask tomas about it', "I won't ask him", 'can you message tomas?', "I'll tell you when it's done"]) {
    assert.deepEqual(one(no), [], no);
  }
});

// A transcript in the runner's own event shape.
function story() {
  const ev = [];
  const at = (e) => { const x = { i: ev.length, entry: 0, ...e }; ev.push(x); return x; };
  let n = 0;
  const call = (who, day, tool, input, text) => { const id = `t${++n}`; at({ who, day, kind: 'tool', name: `mcp__vibe__${tool}`, id, input, session_id: `${who}${day}` }); return at({ who, day, kind: 'returned', tool_use_id: id, name: `mcp__vibe__${tool}`, text, session_id: `${who}${day}` }); };
  const preview = (d, to) => `Send to @${to} · Edit · Cancel — nothing has been sent.  _(draft ${d} · rev r1)_`;
  // Day 1, nora: sends one, leaves one unsent, and says she will ask Tomás herself.
  at({ who: 'nora', day: 1, kind: 'prompt', text: 'tune the mixer', session_id: 'nora1' });
  call('nora', 1, 'vibe_prepare', { handle: 'tomas', message: 'Checked gain staging and the 60Hz notch; is the hum on your bench too?' }, preview('w1', 'tomas'));
  at({ who: 'nora', day: 1, kind: 'human_reply', text: 'send it', session_id: 'nora1' });
  const sent = call('nora', 1, 'vibe_send', { id: 'w1', rev: 'r1' }, 'Sent to **@tomas**');
  call('nora', 1, 'vibe_prepare', { handle: 'tomas', message: 'Also: which preamp revision is on the rack?' }, preview('w2', 'tomas'));
  at({ who: 'nora', day: 1, kind: 'human_reply', text: "no, I'll ask him myself later about the preamp", session_id: 'nora1' });
  // Day 1, tomas sees it and answers.
  at({ who: 'tomas', day: 1, kind: 'prompt', text: 'bench work', session_id: 'tomas1' });
  at({ who: 'tomas', day: 1, kind: 'shown', text: '/vibe · @nora wrote you: "Checked gain staging…"', session_id: 'tomas1' });
  const reply = at({ who: 'tomas', day: 1, kind: 'human_reply', text: 'tell her yes', session_id: 'tomas1' });
  // Day 2, nora, new session: sees the reply.
  at({ who: 'nora', day: 2, kind: 'prompt', text: 'back on the mixer', session_id: 'nora2' });
  const seen = at({ who: 'nora', day: 2, kind: 'shown', text: '/vibe · @tomas wrote you: "yes, same hum here"', session_id: 'nora2' });
  const wire = [{ from: 'nora', to: 'tomas', body: 'Checked gain staging and the 60Hz notch; is the hum on your bench too?', at: sent.i }, { from: 'tomas', to: 'nora', body: 'yes, same hum here', at: reply.i }];
  return { ev, wire, seen };
}

test('day 2 remembers day 1: what she sent, the draft she did not send, and what she said she would do', async () => {
  const { diaryFor } = await lab();
  const { ev, wire } = story();
  const d = diaryFor({ transcript: ev, wire, world: pair, who: 'nora', day: 2 });
  assert.deepEqual(d.lines, [
    '- Day 1: you said you would ask him yourself later about the preamp',
    '- Day 1: Claude drafted a message to @tomas for you and you did not send it: "Also: which preamp revision is on the rack?"',
    '- Day 1: you sent @tomas: "Checked gain staging and the 60Hz notch; is the hum on your bench too?"',
  ]);
  assert.equal(d.open.length, 1);
  assert.match(d.text, /^What you remember from earlier days \(your own memory, not something on the screen; most recent first\):/);
  assert.ok(d.text.endsWith('You said you would ask him yourself later about the preamp. A real person either does it now, or has a reason not to.'));
  // Nothing from today, and nothing on day 1 itself.
  assert.equal(diaryFor({ transcript: ev, wire, world: pair, who: 'nora', day: 1 }).text, '');
  // Tomás on day 2 remembers her message reaching him, and his answer.
  const t = diaryFor({ transcript: ev, wire, world: pair, who: 'tomas', day: 2 });
  assert.deepEqual(t.lines, ['- Day 1: you sent @nora: "yes, same hum here"', '- Day 1: @nora wrote you: "Checked gain staging and the 60Hz notch; is the hum on your bench too?"']);
});

test('a message she then sends that person closes the intention; the diary says so', async () => {
  const { diaryFor, collectIntentions } = await lab();
  const { ev, wire } = story();
  const i = ev.length;
  ev.push({ i, who: 'nora', day: 2, entry: 1, kind: 'tool', name: 'mcp__vibe__vibe_send', id: 'tz', input: {} });
  const more = [...wire, { from: 'nora', to: 'tomas', body: 'which preamp rev?', at: i }];
  const all = collectIntentions(ev, more, pair);
  assert.equal(all.length, 1);
  assert.equal(all[0].followed, i);
  assert.equal(diaryFor({ transcript: ev, wire: more, world: pair, who: 'nora', day: 3 }).open.length, 0);
  assert.ok(diaryFor({ transcript: ev, wire: more, world: pair, who: 'nora', day: 3 }).lines.some((l) => l.endsWith('(you then messaged them)')));
});

test('the player may say what it intends; a restatement of an open one is not a second', async () => {
  const { collectIntentions } = await lab();
  const ev = [
    { i: 0, who: 'nora', day: 1, kind: 'human_reply', text: "I'll ping Tomas tonight", simulator_only: { why: 'x', intends: 'text tomas about the oven' } },
    { i: 1, who: 'nora', day: 1, kind: 'human_reply', text: "fine, I'll ping him later" },
    { i: 2, who: 'nora', day: 1, kind: 'human_null', simulator_only: { why: 'busy', intends: 'call Tomás after lunch' } },
  ];
  const got = collectIntentions(ev, [], pair);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].text, 'text tomas about the oven');
  assert.equal(got[0].source, 'player');
});

test('the diary is capped at 1,200 characters, most recent first', async () => {
  const { diaryFor, DIARY_MAX } = await lab();
  assert.equal(DIARY_MAX, 1200);
  const ev = []; const wire = [];
  for (let k = 0; k < 30; k++) { ev.push({ i: k, who: 'nora', day: 1 + Math.floor(k / 10), kind: 'tool', name: 'x' }); wire.push({ from: 'nora', to: 'tomas', body: `message number ${k} `.padEnd(200, 'x'), at: k }); }
  const d = diaryFor({ transcript: ev, wire, world: pair, who: 'nora', day: 4 });
  assert.ok(d.lines.join('\n').length <= 1200);
  assert.match(d.lines[0], /^- Day 3: you sent @tomas: "message number 29 /);
  assert.ok(d.lines.every((l) => l.length < 200), 'each item is cut to 160 characters of message');
});

test('the person-player reads the diary as memory, apart from the screen; intends is parsed', async () => {
  const { humanPrompt } = await lab();
  const { parseHuman, boxPrompt } = await player();
  const p = humanPrompt(person('Nora'), 'nora', 'back on it', '[Claude]\nhi', '', 'What you remember from earlier days (your own memory, not something on the screen; most recent first):\n- Day 1: you sent @tomas: "x"');
  assert.ok(p.indexOf('What you remember') < p.indexOf('This is what then appeared on your screen'));
  assert.ok(p.includes('"intends": string or null'));
  assert.ok(!humanPrompt(person('Nora'), 'nora', 'x', 'y', '').includes('What you remember'));
  assert.deepEqual(parseHuman('{"reply":null,"why":"w","intends":"  ask  kenji about the oven "}'), { reply: null, why: 'w', intends: 'ask kenji about the oven' });
  assert.deepEqual(parseHuman('{"reply":"ok","why":"t","intends":null}'), { reply: 'ok', why: 't' });
  const b = boxPrompt({ name: 'Nora', handle: 'nora', role: 'r', persona: 'p', typed: 't', memory: 'What you remember from earlier days: - Day 1: x' }, 'Send to @tomas?');
  assert.ok(b.includes('What you remember from earlier days'));
});

test('summary: intentions stated, followed, lapsed; drafts offered unrequested and what became of them', async () => {
  const { analyse } = await lab();
  const { ev, wire } = story();
  // Day 2: nora typed no request; Claude offers a draft; she declines it. Then
  // she asks for one ("message tomas"), which does not count.
  const push = (e) => { const x = { i: ev.length, entry: 1, session_id: 'nora2', ...e }; ev.push(x); return x; };
  push({ who: 'nora', day: 2, kind: 'human_reply', text: 'what is left on the mixer?' });
  push({ who: 'nora', day: 2, kind: 'tool', name: 'mcp__vibe__vibe_prepare', id: 'u1', input: { handle: 'tomas', message: 'Notch is in; preamp rev?' } });
  push({ who: 'nora', day: 2, kind: 'returned', tool_use_id: 'u1', name: 'mcp__vibe__vibe_prepare', text: 'Send to @tomas · Edit · Cancel — nothing has been sent.  _(draft w3 · rev r1)_' });
  push({ who: 'nora', day: 2, kind: 'human_reply', text: 'no' });
  push({ who: 'nora', day: 2, kind: 'human_reply', text: 'ok message tomas about the rack' });
  push({ who: 'nora', day: 2, kind: 'tool', name: 'mcp__vibe__vibe_prepare', id: 'u2', input: { handle: 'tomas', message: 'Which rack?' } });
  push({ who: 'nora', day: 2, kind: 'returned', tool_use_id: 'u2', name: 'mcp__vibe__vibe_prepare', text: 'Send to @tomas · Edit · Cancel — nothing has been sent.  _(draft w4 · rev r1)_' });
  const s = analyse({ world: pair, transcript: ev, turnsLog: [], wire, handles: ['nora', 'tomas'], started: Date.now() });
  assert.equal(s.intentions_stated, 1);
  assert.equal(s.intentions_followed, 0);
  assert.equal(s.intentions_lapsed, 1);
  assert.equal(s.intentions.list[0].to, 'tomas');
  // w1 was asked for? "tune the mixer" did not ask: offered unrequested, sent as shown.
  // w2 came after "send it" (that asked). w3: unrequested, declined. w4: asked.
  assert.deepEqual(s.drafts_offered_unrequested.list.map((x) => [x.draft, x.outcome]), [['w1', 'sent'], ['w3', 'declined']]);
  assert.equal(s.drafts_offered_unrequested.count, 2);
  assert.equal(s.drafts_offered_unrequested.sent, 1);
  assert.equal(s.drafts_offered_unrequested.declined, 1);
  assert.equal(s.drafts_offered_unrequested.edited_then_sent, 0);
});

test('the lab clock: day d is 24*(d-1) hours, written to the server configs and the SessionStart hook', async () => {
  const { labClockEnv, setLabClock } = await lab();
  assert.deepEqual(labClockEnv(1, { 1: 1000 }), { VIBE_LAB_CLOCK_OFFSET_HOURS: '0', VIBE_LAB_DAY_STARTS: '1:1000' });
  assert.deepEqual(labClockEnv(3, { 1: 1000, 3: 5000 }), { VIBE_LAB_CLOCK_OFFSET_HOURS: '48', VIBE_LAB_DAY_STARTS: '1:1000,3:5000' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-labclock-'));
  try {
    const id = { mcp: path.join(dir, 'mcp.json'), directMcp: path.join(dir, 'direct.json'), settings: path.join(dir, 's.json'), resumeSettings: path.join(dir, 'r.json') };
    for (const f of [id.mcp, id.directMcp]) fs.writeFileSync(f, JSON.stringify({ mcpServers: { vibe: { command: 'node', args: ['index.js'], env: { VIBE_HOME: '/h', VIBE_API_URL: 'http://127.0.0.1:1' } } } }));
    fs.writeFileSync(id.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "VIBE_HOME='/h' node cli.js hook run" }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node a.cjs' }] }] } }));
    fs.writeFileSync(id.resumeSettings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node a.cjs' }] }] } }));
    setLabClock(id, labClockEnv(1, { 1: 1000 }));
    setLabClock(id, labClockEnv(2, { 1: 1000, 2: 2000 }));
    for (const f of [id.mcp, id.directMcp]) {
      const env = JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.vibe.env;
      assert.deepEqual(env, { VIBE_HOME: '/h', VIBE_API_URL: 'http://127.0.0.1:1', VIBE_LAB_CLOCK_OFFSET_HOURS: '24', VIBE_LAB_DAY_STARTS: '1:1000,2:2000' });
    }
    const st = JSON.parse(fs.readFileSync(id.settings, 'utf8'));
    assert.equal(st.hooks.SessionStart[0].hooks[0].command, "VIBE_LAB_CLOCK_OFFSET_HOURS='24' VIBE_LAB_DAY_STARTS='1:1000,2:2000' VIBE_HOME='/h' node cli.js hook run", 'set twice, prefixed once');
    assert.equal(st.hooks.UserPromptSubmit[0].hooks[0].command, 'node a.cjs', 'the arrival hook needs no clock');
    assert.equal(JSON.parse(fs.readFileSync(id.resumeSettings, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, 'node a.cjs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const { parseArgs } = await lab();
  assert.equal(parseArgs(['w.json', '--out', 'o']).labClock, true);
  assert.equal(parseArgs(['w.json', '--out', 'o', '--no-lab-clock']).labClock, false);
});
