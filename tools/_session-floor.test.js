'use strict';
// The session floor (turns.js sessionFloor) is the session-start hook's record
// only. A floor at this server process's own start was removed: a host that
// runs one process per turn (claude -p --resume, the lab) started a new server
// every turn, moved the floor past every showing and refused every send
// (2026-11-21: zero sends in two full lab runs).
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

test('no session-start record: a draft shown before this server process started still sends after a typed prompt', async () => {
  await withWire(async (sends) => {
    const rev = seed('wf100aaaa', Date.now() - Math.round(process.uptime() * 1000) - 60_000, 'shown before this process started');
    tick(); turns.record(PROJECT, Date.now());
    assert.ok(!fs.existsSync(startFile()), 'no record from the hook');
    const r = await drafts.vibe_send.handler({ id: 'wf100aaaa', rev });
    assert.equal(r.data.sent, true, r.display);
    assert.equal(sends.length, 1);
  });
});

test('a session-start record dated more than 5 seconds ahead is ignored', async () => {
  turns.recordSessionStart(PROJECT, Date.now() + 10 * 60_000);
  assert.equal(turns.lastSessionStart(PROJECT), null, 'ignored');
  await withWire(async (sends) => {
    const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'not stranded' });
    tick(); turns.record(PROJECT, Date.now());
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, true, 'a future record does not strand it');
    assert.equal(sends.length, 1);
  });
  turns.recordSessionStart(PROJECT, Date.now() + 3000);
  assert.ok(turns.lastSessionStart(PROJECT), 'within 5 seconds: kept (clock skew)');
  fs.rmSync(startFile());
});

test('the server keeps no start of its own', () => {
  assert.equal(typeof turns.serverStart, 'undefined');
  assert.equal(typeof turns.setServerStart, 'undefined');
  assert.ok(!/setServerStart|SERVER_STARTED_AT/.test(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')));
});
