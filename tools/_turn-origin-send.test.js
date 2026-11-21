'use strict';
// vibe_send settles a pending turn (turns.js judge): the real hook records the
// prompt as pending because Claude Code has not yet written who started the
// turn; by the time the agent calls vibe_send, the transcript says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-origin-send-'));
process.env.VIBE_HOME = HOME;
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-origin-send-project-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const ARRIVALS = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-origin-send-arrivals-'));
const base = () => ({ type: 'user', isSidechain: false, sessionId: 's1', timestamp: new Date().toISOString() });
const typed = (t) => ({ ...base(), promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: t } });
const scheduled = (t) => ({ ...base(), promptSource: 'system', turnOrigin: 'scheduled', isMeta: true, message: { role: 'user', content: t } });
const sdk = (t) => ({ ...base(), promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: t } });
let n = 0;
function transcript(entries) {
  const file = path.join(HOME, `t${++n}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const append = (file, e) => fs.appendFileSync(file, JSON.stringify(e) + '\n');

/** The real hook on a prompt, as Claude Code runs it (before writing the prompt's own entry). */
function prompt(text, file) {
  const t = Date.now(); while (Date.now() === t) { /* next ms */ }
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: PROJECT, prompt: text, transcript_path: file }),
    env: { PATH: process.env.PATH, VIBE_TURNS_DIR: path.join(HOME, 'turns'), VIBE_ARRIVALS_DIR: ARRIVALS, CLAUDE_PROJECT_DIR: PROJECT }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

async function withWire(fn) {
  const sends = [];
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body) => { sends.push({ from, to, body }); return { id: `msg_${sends.length}`, storedLength: body.length }; };
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const origFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ handle: decodeURIComponent(String(url).split('/api/identity/')[1] || ''), kind: 'human' }) });
  try { await fn(sends); } finally { Object.assign(store, orig); global.fetch = origFetch; }
}
const prepare = (o) => drafts.vibe_prepare.handler({ handle: 'linus', message: 'the lease fixed it', ...o });
const send = (p) => drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });

test.after(() => { for (const d of [HOME, PROJECT, ARRIVALS]) fs.rmSync(d, { recursive: true, force: true }); });

test('pending, then the typed entry is written: Send goes', async () => {
  const file = transcript([typed('start')]);
  prompt('start', file);
  await withWire(async (sends) => {
    const p = await prepare();
    prompt('yes, send it', file);
    assert.ok(turns.turnRecord(PROJECT).pending, 'recorded as pending');
    append(file, typed('yes, send it'));
    const r = await send(p);
    assert.equal(r.data.sent, true, r.display);
    assert.equal(sends.length, 1);
    assert.equal(turns.turnRecord(PROJECT).pending, null, 'promoted');
  });
});

test('pending, then labelled scheduled: refused, nothing sent, pending cleared', async () => {
  const file = transcript([typed('start')]);
  await withWire(async (sends) => {
    const p = await prepare({ message: 'second note' });
    prompt('send the note', file);
    append(file, scheduled('send the note'));
    const r = await send(p);
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'no_turn_since_shown');
    assert.equal(sends.length, 0);
    assert.equal(turns.turnRecord(PROJECT).pending, null);
  });
});

test('pending, and the entry never appears: refused with the unconfirmed wording', async () => {
  const file = transcript([typed('start')]);
  await withWire(async (sends) => {
    const p = await prepare({ message: 'third note' });
    prompt('go ahead', file);
    const r = await send(p);
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'turn_unconfirmed');
    assert.match(r.display, /^Not sent yet: their last message could not be confirmed as typed by them\. Ask them to answer again\./);
    assert.doesNotMatch(r.display, /has not seen|not typed a message/);
    assert.equal(sends.length, 0);
  });
});

test('the lab pattern (claude -p --resume, "sdk" entries): sends with no extra confirmation', async () => {
  const file = transcript([sdk('day one')]);
  await withWire(async (sends) => {
    const p = await prepare({ message: 'lab note' });
    prompt('send it', file);   // its own entry is written after the hook
    assert.equal(turns.turnRecord(PROJECT).pending, null, 'confirmed at the hook');
    append(file, sdk('send it'));
    const r = await send(p);
    assert.equal(r.data.sent, true, r.display);
    assert.equal(sends.length, 1);
  });
});
