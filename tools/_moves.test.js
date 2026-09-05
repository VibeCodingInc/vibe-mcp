/**
 * Context-guided messaging: the agent prepares, the person chooses.
 *
 * The one invariant every test here pins: NOTHING SENDS until vibe_send_draft
 * on a previewed draft. Suggesting, selecting, editing and cancelling are
 * state changes on a private local file. The send goes through vibe_dm once
 * with the exact previewed text and leaves a private return binding.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-moves-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada', authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
global.fetch = async () => ({ ok: false, json: async () => ({}) });
const store = require('../store/api.js');
const moves = require('./moves');

const NOW = Date.now();
const ROSTER = [
  { handle: 'ada', workingOn: 'the corpus run', status: 'active', lastSeen: NOW },
  { handle: 'grace', workingOn: 'retry queue backoff for payments', status: 'active', lastSeen: NOW, isAgent: false },
  { handle: 'linus', workingOn: 'kernel scheduler', status: 'away', lastSeen: NOW - 3 * 3600000 },
  { handle: 'bot_x', workingOn: 'payments retry', status: 'active', lastSeen: NOW, isAgent: true },
];
const THREADS = [
  { handle: 'linus', unread: 1, lastFrom: 'linus', lastMessage: 'did the payments retry fix land?', lastTimestamp: NOW - 2 * 3600000 },
];

let sends = [];
const originals = {};
function stub(stubs) { for (const [k, v] of Object.entries(stubs)) { originals[k] = store[k]; store[k] = v; } }
function restore() { for (const [k, v] of Object.entries(originals)) store[k] = v; }
const QUIET = {
  getActiveUsersResult: async () => ({ ok: true, users: ROSTER }),
  getActiveUsers: async () => ROSTER,
  getInboxResult: async () => ({ ok: true, threads: THREADS }),
  getInbox: async () => THREADS,
  getUnreadCount: async () => 0,
  getRawInbox: async () => [],
  getThread: async () => [],
  markThreadRead: async () => {},
  sendTypingIndicator: async () => {},
  heartbeat: async () => ({ ok: true }),
  sendMessage: async (from, to, message, type, payload, opts) => { sends.push({ from, to, message, opts }); return { id: `msg_${sends.length}`, success: true }; },
};
beforeEach(() => { sends = []; try { fs.unlinkSync(moves.DRAFTS_FILE); } catch {} try { fs.unlinkSync(moves.BINDINGS_FILE); } catch {} });
after(() => { restore(); fs.rmSync(HOME, { recursive: true, force: true }); });

// ── pure relevance ────────────────────────────────────────────────────────
test('no context → one question, no moves', () => {
  const out = moves.computeMoves(moves.cleanContext({}), 'ada', ROSTER, THREADS, NOW);
  assert.ok(out.ask); assert.equal(out.moves, undefined);
});
test('a result + someone who asked about it → answer them first, with the evidence', () => {
  const out = moves.computeMoves(moves.cleanContext({ project: 'payments', result: 'retry backoff is exponential now, 3 tries, tests green' }), 'ada', ROSTER, THREADS, NOW);
  assert.ok(out.moves.length >= 1 && out.moves.length <= 3);
  assert.equal(out.moves[0].to, 'linus');
  assert.equal(out.moves[0].kind, 'answer');
  assert.match(out.moves[0].why, /they wrote you .*did the payments retry fix land/);
  assert.match(out.moves[0].message, /^re: payments — retry backoff/);
  // grace overlaps on "payments"/"retry"/"backoff"; agents never appear
  assert.ok(out.moves.some(m => m.to === 'grace'));
  assert.ok(!out.moves.some(m => m.to === 'bot_x'));
  assert.ok(!out.moves.some(m => m.to === 'ada'));
});
test('a question + an overlapping one-liner → ask that person, here-now noted', () => {
  const out = moves.computeMoves(moves.cleanContext({ question: 'what backoff curve do you use for the retry queue?' }), 'ada', ROSTER, [], NOW);
  const g = out.moves.find(m => m.to === 'grace');
  assert.ok(g); assert.equal(g.kind, 'ask');
  assert.match(g.why, /their one-liner: "retry queue backoff for payments"/);
  assert.match(g.why, /here now/);
});
test('context but nobody relevant → one question naming the gap; no invented recipient', () => {
  const out = moves.computeMoves(moves.cleanContext({ result: 'the solar array sizing spreadsheet is done' }), 'ada', ROSTER, [], NOW);
  assert.ok(out.ask); assert.match(out.ask, /Who is this for\?/); assert.equal(out.moves, undefined);
});
test('never more than three moves; one per person while others qualify', () => {
  const roster = ROSTER.concat([{ handle: 'kay', workingOn: 'payments ledger', status: 'active', lastSeen: NOW }, { handle: 'ola', workingOn: 'payments ops', status: 'active', lastSeen: NOW }]);
  const out = moves.computeMoves(moves.cleanContext({ project: 'payments', result: 'ledger reconciles', question: 'does ops need the report daily?' }), 'ada', roster, THREADS, NOW);
  assert.ok(out.moves.length <= 3);
  assert.equal(new Set(out.moves.map(m => m.to)).size, out.moves.length);
});
test('context is cleaned: only http(s) refs survive, nothing else is kept', () => {
  const c = moves.cleanContext({ project: 'p', refs: [{ title: 'PR', url: 'https://github.com/x/y/pull/1' }, { title: 'local', url: 'file:///Users/me/secret' }], cwd: '/Users/me/secret' });
  assert.equal(c.refs.length, 1); assert.equal(c.cwd, undefined);
});

// ── the flow: suggest → select → (edit) → cancel | send ──────────────────
test('vibe_moves writes drafts locally and sends nothing', async () => {
  stub(QUIET);
  const res = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  assert.match(res.display, /nothing sent/);
  assert.ok(res.data.moves.length >= 1);
  const drafts = JSON.parse(fs.readFileSync(moves.DRAFTS_FILE, 'utf8'));
  assert.ok(drafts.every(d => d.status === 'suggested'));
  assert.equal(sends.length, 0);
});
test('selecting a draft shows the exact recipient, message, attachments and three actions — and sends nothing', async () => {
  stub(QUIET);
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now', refs: [{ title: 'PR #12', url: 'https://github.com/x/y/pull/12' }] } });
  const id = m.data.moves[0].id;
  const d = await moves.vibe_draft.handler({ id });
  assert.match(d.display, /\*\*To:\*\* @linus/);
  assert.match(d.display, /\*\*Message \(exact\):\*\*\nre: payments — retry backoff is exponential now\nPR #12: https:\/\/github.com\/x\/y\/pull\/12/);
  assert.match(d.display, /Send to @linus · Edit · Cancel — nothing has been sent/);
  assert.deepEqual(d.data.actions.map(a => a.label), ['Send to @linus', 'Edit', 'Cancel']);
  assert.equal(sends.length, 0);
});
test('edit replaces the text and previews again; still nothing sent', async () => {
  stub(QUIET);
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  const id = m.data.moves[0].id;
  await moves.vibe_draft.handler({ id });
  const e = await moves.vibe_draft.handler({ id, message: 'landed — exponential backoff, 3 tries. want the PR?' });
  assert.match(e.display, /landed — exponential backoff, 3 tries\. want the PR\?/);
  assert.equal(sends.length, 0);
});
test('cancel sends nothing and a cancelled draft cannot be sent later', async () => {
  stub(QUIET);
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  const id = m.data.moves[0].id;
  await moves.vibe_draft.handler({ id });
  const c = await moves.vibe_discard_draft.handler({ id });
  assert.match(c.display, /Cancelled — nothing sent/);
  const s = await moves.vibe_send_draft.handler({ id });
  assert.match(s.display, /was cancelled — nothing sent/);
  assert.equal(sends.length, 0);
});
test('a merely suggested (never previewed) draft cannot be sent', async () => {
  stub(QUIET);
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  const s = await moves.vibe_send_draft.handler({ id: m.data.moves[0].id });
  assert.match(s.display, /has not been reviewed yet/);
  assert.equal(sends.length, 0);
});
test('Send sends exactly the previewed text, once, and records a private return binding', async () => {
  stub(QUIET);
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  const id = m.data.moves[0].id;
  const d = await moves.vibe_draft.handler({ id });
  const s = await moves.vibe_send_draft.handler({ id });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'linus');
  assert.equal(sends[0].message, 're: payments — retry backoff is exponential now');
  assert.equal(sends[0].opts.origin, 'context_move');
  assert.match(s.display, /Sent to \*\*@linus\*\*/);
  const again = await moves.vibe_send_draft.handler({ id });
  assert.match(again.display, /already sent/); assert.equal(sends.length, 1);
  const b = JSON.parse(fs.readFileSync(moves.BINDINGS_FILE, 'utf8'));
  assert.equal(b.linus.project, 'payments');
  assert.ok(!JSON.stringify(b).includes('/Users/'), 'no paths in the binding');
  assert.equal(moves.getReturnBinding('@linus').project, 'payments');
});
test('free writing still works: handle + message previews without a wizard, and sends only on Send', async () => {
  stub(QUIET);
  const d = await moves.vibe_draft.handler({ handle: '@grace', message: 'coffee thursday?' });
  assert.match(d.display, /\*\*To:\*\* @grace \(here now\)/);
  assert.match(d.display, /coffee thursday\?/);
  assert.equal(sends.length, 0);
  await moves.vibe_send_draft.handler({ id: d.data.draft.id });
  assert.equal(sends.length, 1); assert.equal(sends[0].message, 'coffee thursday?');
});
test('vibe_inbox labels the reply thread with the work it came from', async () => {
  stub({ ...QUIET, getThread: async () => [{ id: 'msg_r1', from: 'linus', to: 'ada', body: 'yes — nice, ship it', timestamp: NOW }] });
  const m = await moves.vibe_moves.handler({ context: { project: 'payments', result: 'retry backoff is exponential now' } });
  const id = m.data.moves[0].id;
  await moves.vibe_draft.handler({ id });
  await moves.vibe_send_draft.handler({ id });
  const inboxPath = require.resolve('./inbox.js'); delete require.cache[inboxPath];
  const inbox = require(inboxPath);
  const res = await inbox.handler({ handle: 'linus' });
  assert.match(res.display, /↩ this is the reply to what you sent from \*\*payments\*\*/);
});
