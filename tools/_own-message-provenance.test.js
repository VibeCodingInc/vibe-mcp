'use strict';
// The person's own message in a thread is never read as unexplained.
//
// Found by simulation (lab, 0.9.21 and 0.9.22): the person approved a message
// in one session; a NEW session opened the thread, saw "**you** · 4m ago ·
// #msg_lab_1", had not sent it itself, and told the person a message under
// their name had come from somewhere unknown. In one run the person drafted an
// apology disowning their own message. Each line of theirs now says where it
// came from, using only what this machine knows (tools/drafts.js
// sentProvenance), and the guidance says "you" is the person.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-own-msg-'));
process.env.VIBE_HOME = HOME;
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-own-msg-project-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');
const line = require('../line');
const { render, FROM, FROM_ELSEWHERE } = require('./thread');

const MIN = 60 * 1000;
// Wording that would tell the person their own message is not theirs.
const ALARM = /didn't send|did not send|not sent by|unknown|unexplained|suspicious|don't know|not from you|someone else/i;

async function withWire(fn) {
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body) => ({ id: 'msg_here_1', storedLength: body.length });
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    return { ok: true, status: 200, json: async () => ({ handle: h, kind: 'human' }) };
  };
  try { await fn(); } finally { Object.assign(store, orig); global.fetch = origFetch; }
}

/** The rendered header line of one message. */
const lineOf = (out, id) => out.split('\n').find((l) => l.includes(`#${id}`));
const thread = (msgs) => render('ada', 'oren', msgs);

test.after(() => { for (const d of [HOME, PROJECT]) fs.rmSync(d, { recursive: true, force: true }); });

test('(a) sent in this session: the line says the person chose Send in this session', async () => {
  turns.recordSessionStart(PROJECT, Date.now() - 10 * MIN);
  await withWire(async () => {
    const p = await drafts.vibe_prepare.handler({ handle: 'oren', message: 'the lease fixed it' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true, r.display);
  });
  const out = thread([{ id: 'msg_here_1', from: 'ada', body: 'the lease fixed it', timestamp: Date.now() - 4 * MIN }]);
  const l = lineOf(out, 'msg_here_1');
  assert.match(l, /^\*\*you\*\* · 4m ago · #msg_here_1 · you chose Send on this in this session$/);
  assert.doesNotMatch(out, ALARM);
});

test('(a) after a new session starts in the folder, the same send no longer claims "this session"', () => {
  turns.recordSessionStart(PROJECT, Date.now());
  const out = thread([{ id: 'msg_here_1', from: 'ada', body: 'the lease fixed it', timestamp: Date.now() - 4 * MIN }]);
  assert.equal(lineOf(out, 'msg_here_1'), `**you** · 4m ago · #msg_here_1 · ${FROM.this_machine}`);
  assert.doesNotMatch(out, ALARM);
});

test('(b) sent in an earlier session on this machine: one wording, true for either session', () => {
  const start = Date.now() - MIN;
  turns.recordSessionStart(PROJECT, start);
  drafts.transact((d) => { d.push({ id: 'wearlier1', from: 'ada', to: 'oren', body: 'ship it', status: 'sent', createdAt: start - 6 * MIN, sentAt: start - 4 * MIN, messageId: 'msg_lab_1' }); });
  const out = thread([
    { id: 'msg_lab_2', from: 'oren', body: 'ok', timestamp: Date.now() },
    { id: 'msg_lab_1', from: 'ada', body: 'ship it', timestamp: start - 4 * MIN },
  ]);
  assert.equal(lineOf(out, 'msg_lab_1'), '**you** · 5m ago · #msg_lab_1 · you chose Send on this from this machine, in this session or an earlier one');
  assert.doesNotMatch(out, /in an earlier session on this machine/, 'which session is never claimed from a stored record');
  assert.doesNotMatch(out, ALARM);
});

test('(b) a send known only from the week-long return note counts too', () => {
  const start = Date.now() - MIN;
  turns.recordSessionStart(PROJECT, start);
  fs.writeFileSync(drafts.BINDINGS_FILE, JSON.stringify({ oren: { from: 'ada', sentAt: start - 3 * 24 * 60 * MIN, messageId: 'msg_old_1', firstLine: 'x' } }));
  const out = thread([{ id: 'msg_old_1', from: 'ada', body: 'x', timestamp: start - 3 * 24 * 60 * MIN }]);
  assert.match(lineOf(out, 'msg_old_1'), / · #msg_old_1 · you chose Send on this from this machine, in this session or an earlier one$/);
});

test('a local record with no session start on file: the same "from this machine" wording', () => {
  fs.rmSync(path.join(HOME, 'turns'), { recursive: true, force: true });
  const out = thread([{ id: 'msg_lab_1', from: 'ada', body: 'ship it', timestamp: Date.now() - 4 * MIN }]);
  assert.equal(lineOf(out, 'msg_lab_1'), `**you** · 4m ago · #msg_lab_1 · ${FROM.this_machine}`);
});

test('(c) no local record: sent from their account, said without alarm', () => {
  turns.recordSessionStart(PROJECT, Date.now() - MIN);
  const out = thread([{ id: 'msg_phone_1', from: 'ada', body: 'from the app', timestamp: Date.now() - 4 * MIN }]);
  const l = lineOf(out, 'msg_phone_1');
  assert.equal(l, `**you** · 4m ago · #msg_phone_1 · ${FROM_ELSEWHERE}`);
  assert.match(l, /sent from your account/);
  assert.doesNotMatch(out, ALARM);
});

test('a record kept for another account on this machine is not claimed for this one', () => {
  drafts.transact((d) => { d.push({ id: 'wother1', from: 'bea', to: 'oren', body: 'hi', status: 'sent', createdAt: Date.now(), sentAt: Date.now() - MIN, messageId: 'msg_bea_1' }); });
  const out = thread([{ id: 'msg_bea_1', from: 'ada', body: 'hi', timestamp: Date.now() - MIN }]);
  assert.match(lineOf(out, 'msg_bea_1'), new RegExp(`· ${FROM_ELSEWHERE.replace(/[()]/g, '\\$&')}$`));
});

test('their agent\'s message over an open line says so', () => {
  const out = thread([{ id: 'msg_line_1', from: 'ada', body: 'who owns placement?' + line.ASKED('ada'), timestamp: Date.now() - MIN }]);
  assert.match(lineOf(out, 'msg_line_1'), / · sent by your agent over an open line$/);
});

test('the time is worded the same for their messages and the person\'s', () => {
  const t = Date.now() - 4 * MIN;
  const out = thread([
    { id: 'msg_t2', from: 'oren', body: 'a', timestamp: t },
    { id: 'msg_t1', from: 'ada', body: 'b', timestamp: t },
  ]);
  const age = (l) => l.split(' · ')[1];
  assert.equal(age(lineOf(out, 'msg_t1')), age(lineOf(out, 'msg_t2')));
  assert.equal(age(lineOf(out, 'msg_t1')), store.formatTimeAgo(t));
});

test('the guidance says a thread\'s "you" is the person, in the server instructions and the /vibe command', () => {
  const sentence = 'A message marked you in a thread';
  const theirs = 'It is theirs. Never describe it as unexplained, or as not sent by them, because this session did not send it.';
  // Loading index.js starts nothing (see its last lines).
  const instructions = require('../index.js').SERVER_INSTRUCTIONS;
  assert.ok(instructions.includes(sentence) && instructions.includes(theirs), 'SERVER_INSTRUCTIONS');
  const cmd = fs.readFileSync(path.join(__dirname, '..', 'hosts', 'vibe-command.md'), 'utf8');
  assert.ok(cmd.includes(sentence) && cmd.includes(theirs), 'hosts/vibe-command.md');
});
