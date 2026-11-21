'use strict';
// A draft shown before this MCP server process started must be shown again,
// whether or not the session-start hook recorded the session (turns.js
// sessionFloor). Review 2026-11-21, third pass: without the hook's record
// (hook not installed, an isolated VIBE_HOME the hook does not write to, an
// old matcher) the earlier-session check did not apply at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-floor-'));
process.env.VIBE_HOME = HOME;
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-floor-project-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

const host = require('../host');
host.setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');

async function withWire(fn) {
  const sends = [];
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body) => { sends.push({ to, body }); return { id: `m${sends.length}`, storedLength: body.length }; };
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const of = global.fetch;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ handle: decodeURIComponent(String(url).split('/api/identity/')[1] || ''), kind: 'human' }) });
  try { await fn(sends); } finally { Object.assign(store, orig); global.fetch = of; }
}
const tick = () => { const t = Date.now(); while (Date.now() === t) { /* next ms */ } };
/** A draft last shown at `at` (as a previous server process would have left it). */
function seed(id, at, body) {
  drafts.transact((all) => {
    const d = { id, status: 'previewed', createdAt: at, from: 'ada', to: 'linus', body, replyTo: null, refs: [], context: { project: null }, firstRev: null };
    d.firstRev = drafts.revOf(d); d.revFor = d.firstRev; d.revAt = at;
    all.push(d);
  });
  return drafts.revOf(drafts.loadDrafts().find((x) => x.id === id));
}
const startFile = () => path.join(HOME, 'turns', `${turns.key(PROJECT)}.start.json`);

test.after(() => { for (const d of [HOME, PROJECT]) fs.rmSync(d, { recursive: true, force: true }); });

test('no session-start record, draft shown before this server started: refused until shown again', async () => {
  await withWire(async (sends) => {
    const rev = seed('wf100aaaa', turns.PROCESS_STARTED_AT - 60_000, 'shown before the server started');
    tick(); turns.record(PROJECT, Date.now());   // the person typed, in this session
    assert.ok(!fs.existsSync(startFile()), 'no record from the hook');
    const r = await drafts.vibe_send.handler({ id: 'wf100aaaa', rev });
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'shown_in_earlier_session');
    assert.equal(sends.length, 0);
    await drafts.vibe_prepare.handler({ id: 'wf100aaaa' });
    tick(); turns.record(PROJECT, Date.now());
    assert.equal((await drafts.vibe_send.handler({ id: 'wf100aaaa', rev })).data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('no session-start record, draft shown after this server started: normal', async () => {
  await withWire(async (sends) => {
    const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'shown in this server' });
    tick(); turns.record(PROJECT, Date.now());
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('judge: the server start is a floor only where the turn check applies', () => {
  const before = turns.PROCESS_STARTED_AT - 1000;
  assert.equal(turns.judge(before, { processStart: turns.PROCESS_STARTED_AT }).why, 'shown_in_earlier_session');
  assert.deepEqual(turns.judge(before, { host: 'codex' }), { check: 'unavailable', why: 'host_without_turn_hook' });
  const empty = { VIBE_TURNS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-floor-none-')), CLAUDE_PROJECT_DIR: PROJECT };
  assert.deepEqual(turns.judge(before, { env: empty }), { check: 'unavailable', why: 'no_turn_recorded' }, 'no hook-recorded turns: unchanged');
});

test('a session-start record dated more than 5 seconds ahead is ignored; the server-start floor still applies', async () => {
  turns.recordSessionStart(PROJECT, Date.now() + 10 * 60_000);
  assert.equal(turns.lastSessionStart(PROJECT), null, 'ignored');
  await withWire(async (sends) => {
    const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'not stranded' });
    tick(); turns.record(PROJECT, Date.now());
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, true, 'a future record does not strand it');
    const rev = seed('wf200aaaa', turns.PROCESS_STARTED_AT - 60_000, 'still before the server started');
    tick(); turns.record(PROJECT, Date.now());
    assert.equal((await drafts.vibe_send.handler({ id: 'wf200aaaa', rev })).data.reason, 'shown_in_earlier_session');
    assert.equal(sends.length, 1);
  });
  turns.recordSessionStart(PROJECT, Date.now() + 3000);
  assert.ok(turns.lastSessionStart(PROJECT), 'within 5 seconds: kept (clock skew)');
  fs.rmSync(startFile());
});

test('a server start more than 5 seconds ahead (the clock was set back) is ignored: a re-show then a prompt sends', () => {
  const now = Date.now();
  const ahead = now + 3600_000;
  assert.equal(turns.sessionFloor(PROJECT, process.env, { processStart: ahead }), 0, 'no start record here, so no floor at all');
  // A re-show just now, then the person's prompt.
  const shown = Date.now(); tick(); turns.record(PROJECT, Date.now());
  assert.deepEqual(turns.judge(shown, { processStart: ahead }), { check: 'passed' });
  // Within the slack it still counts.
  const near = Date.now() + 3000;
  assert.equal(turns.sessionFloor(PROJECT, process.env, { processStart: near }), near);
});
