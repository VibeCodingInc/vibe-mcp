'use strict';
// When the person says they are stuck and the agent does not look for anyone,
// the person is still SHOWN who they know is here. By code, once, in the
// session where they said it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-near-'));
process.env.VIBE_HOME = HOME;
const near = require('../near');
const reach = require('../reach');
const arrival = require('../arrival');
const { pickHere } = require('../session-start-hook.cjs');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const dir = arrival.spoolDir();
const hook = (input) => JSON.parse(spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, VIBE_ARRIVALS_DIR: dir }, encoding: 'utf8' }).stdout);
const reset = () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); try { fs.unlinkSync(path.join(HOME, 'reach.json')); } catch {} };
const room = (users, counter = { reads: 0 }) => ({ counter, getActiveUsersResult: async () => { counter.reads += 1; return { ok: true, users }; } });
const deps = (store) => ({ store, pickHere, isHereNow: () => true, doorOf: (h) => (h === 'sam' ? { url: 'https://x.dev' } : null) });
const USERS = [
  { handle: 'sam', one_liner: 'retry queue for webhook delivery' },
  { handle: 'ben', one_liner: 'a letterpress shop site' },
  { handle: 'cy', one_liner: 'webhook retries at scale, ask me anything' },          // a stranger
  { handle: 'botty', one_liner: 'webhooks', isAgent: true },                          // an agent
  { handle: 'ada', one_liner: 'me' },
];
const later = () => Date.now() + near.WAIT_MS + 1000;

test('said stuck, agent did not look: the person is shown the people they know, in that session only, once', async () => {
  reset(); reach.know('sam'); reach.know('ben'); reach.know('botty');
  const said = hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'I have been stuck on this all morning. Help.' });
  assert.match(said.hookSpecificOutput.additionalContext, /vibe_bump/, 'the agent is still reminded');
  assert.equal(said.systemMessage, undefined);

  const store = room(USERS);
  assert.equal(await near.check('ada', { ...deps(store), now: Date.now() }), 0, 'not before the agent has had its chance');
  assert.equal(store.counter.reads, 0, 'and no read is made until a marker is due');
  assert.equal(await near.check('ada', { ...deps(store), now: later() }), 1);
  assert.equal(store.counter.reads, 1);

  assert.equal(hook({ hook_event_name: 'PostToolUse', session_id: 'other', tool_name: 'Bash' }).systemMessage, undefined, 'another session is not told');
  const shown = hook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
  assert.match(shown.systemMessage, /^\/vibe · you said you were stuck · people you know are here now: @sam \(retry queue for webhook delivery\) 🚪 · @ben \(a letterpress shop site\) · say "ask @sam" or "visit @sam"$/);
  assert.doesNotMatch(shown.systemMessage, /@cy|@botty|ask me anything/, 'never a stranger, never an agent');
  assert.match(shown.hookSpecificOutput.additionalContext, /If none fits, say nothing about it/);
  assert.equal(hook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' }).systemMessage, undefined, 'once');
  assert.equal(await near.check('ada', { ...deps(store), now: later() + 60000 }), 0, 'and never a second read for the same moment');
  assert.equal(store.counter.reads, 1);
});

test('the agent looked by itself (vibe_bump): nothing more is shown', async () => {
  reset(); reach.know('sam');
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: "i'm stuck" });
  hook({ hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'mcp__vibe__vibe_bump' });
  const store = room(USERS);
  assert.equal(await near.check('ada', { ...deps(store), now: later() }), 0);
  assert.equal(store.counter.reads, 0);
});

test('nobody known is here, the room cannot be read, or quiet is on: nothing is shown and nothing is guessed', async () => {
  for (const [name, setup, store] of [
    ['nobody known', () => {}, room(USERS)],
    ['unreadable', () => reach.know('sam'), { getActiveUsersResult: async () => ({ ok: false, users: [] }) }],
    ['throws', () => reach.know('sam'), { getActiveUsersResult: async () => { throw new Error('offline'); } }],
    ['muted', () => { reach.know('sam'); reach.mute('sam'); }, room(USERS)],
  ]) {
    reset(); setup();
    hook({ hook_event_name: 'UserPromptSubmit', session_id: 's3', prompt: "i'm stuck" });
    assert.equal(await near.check('ada', { ...deps(store), now: later() }), 0, name);
    assert.equal(hook({ hook_event_name: 'PostToolUse', session_id: 's3', tool_name: 'Bash' }).systemMessage, undefined, name);
  }
  reset(); reach.know('sam'); reach.setQuiet(true);
  const q = hook({ hook_event_name: 'UserPromptSubmit', session_id: 's4', prompt: "i'm stuck" });
  assert.equal(q.hookSpecificOutput, undefined, 'quiet: not even a marker');
  assert.deepEqual(near.due(dir, later()), []);
  reach.setQuiet(false);
});

test('an old "stuck" is not now, and two servers sharing the folder read once between them', async () => {
  reset(); reach.know('sam');
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's5', prompt: "i'm stuck" });
  assert.deepEqual(near.due(dir, Date.now() + 31 * 60 * 1000), []);
  const a = room(USERS); const b = room(USERS);
  const [x, y] = await Promise.all([near.check('ada', { ...deps(a), now: later() }), near.check('ada', { ...deps(b), now: later() })]);
  assert.equal(x + y, 1);
  assert.equal(a.counter.reads + b.counter.reads, 1);
});

test('the note is not an arrival: it can never be answered over an open line', async () => {
  reset(); reach.know('sam');
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's6', prompt: "i'm stuck" });
  await near.check('ada', { ...deps(room(USERS)), now: later() });
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'near-s6.json'), 'utf8'));
  assert.equal(row.kind, 'near');
  assert.match(fs.readFileSync(path.join(__dirname, 'line.js'), 'utf8'), /row && !row\.kind \? row : null/);
});
