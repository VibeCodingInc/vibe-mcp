'use strict';
// vibe_people marks a conversation with a reply drafted and not sent. The
// draft id is given only where vibe_send checks the person has seen the draft
// here (turns.js); where that check is unavailable an id is all an agent would
// need to send, so the row keeps the plain words only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-people-unsent-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-people-unsent-project-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'oren', authMethod: 'github', authToken: jwt('oren') }));
const at = Date.now() - 3 * 3600e3;
fs.writeFileSync(path.join(HOME, 'drafts.json'), JSON.stringify([{ id: 'w1a2b3c4d', status: 'previewed', createdAt: at, revAt: at, revFor: 'x', from: 'oren', to: 'mira', body: 'hi', refs: [] }]));

const store = require('../store');
const people = require('./people');
const turns = require('../turns');
const host = require('../host');

store.getActiveUsersResult = async () => ({ ok: true, users: [] });
store.getInboxResult = async () => ({ ok: true, threads: [{ handle: 'mira', lastFrom: 'mira', unread: 1, lastTimestamp: Date.now() - 3600e3 }] });
const row = async () => (await people.handler()).display.split('\n').find((l) => l.startsWith('@mira'));

test.after(() => { for (const d of [HOME, PROJECT]) fs.rmSync(d, { recursive: true, force: true }); });

test('turn check unavailable (no hook-recorded turns): plain words, no draft id', async () => {
  host.setClientInfo({ name: 'claude-code', version: 'test' });
  assert.equal(turns.judge(Date.now()).check, 'unavailable');
  const r = await row();
  assert.match(r, /your reply is drafted but not sent/);
  assert.ok(!r.includes('w1a2b3c4d'), r);
});

test('turn check available: the draft id is given', async () => {
  turns.record(PROJECT, Date.now());
  assert.notEqual(turns.judge(Date.now()).check, 'unavailable');
  assert.match(await row(), /your reply is drafted but not sent \(draft w1a2b3c4d\)/);
});

test('a host without the turn hook: no draft id', async () => {
  host.setClientInfo({ name: 'codex', version: 'test' });
  const r = await row();
  assert.match(r, /your reply is drafted but not sent/);
  assert.ok(!r.includes('w1a2b3c4d'), r);
});
