/**
 * First-five-minutes repair (coordinator, 2026-08-30):
 *   1. signed-out sign-in NEVER blocks the tool call — it returns a structured
 *      auth_required state, the login URL, and one human sentence; the callback
 *      listener stays alive and the NEXT start recognizes the credential.
 *   2. the inbox exposes every thread's stable message id; vibe_reply consumes
 *      that id exactly and never guesses the newest message.
 *
 * Run: node --test tools/_first-five-minutes.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-f5m-'));
process.env.VIBE_HOME = HOME;
process.env.SSH_CONNECTION = 'test 1 2 3'; // never pop a real browser from tests

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// No test may reach the network.
global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const stubStore = (stubs) => {
  const orig = {};
  for (const [k, v] of Object.entries(stubs)) { orig[k] = store[k]; store[k] = v; }
  return () => { for (const [k, v] of Object.entries(orig)) store[k] = v; };
};

const init = require('./init');
const config = require('../config');
const authStore = require('../auth-store');

afterEach(() => init._resetPendingAuth());

const quietStore = () => stubStore({
  registerSession: async () => ({}), heartbeat: async () => ({}),
  getUnreadCount: async () => 0, verifyAuthToken: async () => null,
});

test('signed-out sign-in returns IMMEDIATELY with a structured auth_required state and the one sentence', async () => {
  const restore = quietStore();
  try {
    const t0 = Date.now();
    const res = await init.handler({});
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, `returned in ${ms}ms — must not wait for OAuth`);
    assert.equal(res.data.state, 'auth_required');
    assert.match(res.data.login_url, /^https?:\/\//);
    assert.equal(res.data.sentence, 'Open this, sign in with GitHub, then say vibe start.');
    assert.equal(res.data.browser_opened, false, 'a remote/headless session must not claim a browser opened');
    assert.ok(res.display.includes(res.data.login_url), 'the URL is in the human text');
    assert.ok(res.display.includes('No browser could be opened from here.'));
  } finally { restore(); }
});

test('repeated start while waiting reuses the SAME flow and says it is still waiting', async () => {
  const restore = quietStore();
  try {
    const a = await init.handler({});
    const b = await init.handler({});
    assert.equal(a.data.login_url, b.data.login_url, 'one flow, one URL');
    assert.ok(b.display.includes('Still waiting for your sign-in.'));
  } finally { restore(); }
});

test('the callback listener outlives the tool call; completion persists the credential for the next start', async () => {
  const restore = quietStore();
  try {
    const res = await init.handler({});
    const url = new URL(res.data.login_url);
    const redirect = new URL(url.searchParams.get('redirect'));
    // Simulate GitHub finishing: hit the still-listening local callback with the
    // flow's state and a synthetic token (actor step is skipped by a plain GET
    // callback in non-actor mode; in actor-aware mode the legacy GET lands the
    // token and shows the capture page — either way the token is delivered on
    // the actor-callback or resolved on completion).
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `h.${b64({ sub: 'newbie', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
    redirect.searchParams.set('token', token);
    redirect.searchParams.set('handle', 'newbie');
    const status = await new Promise((resolve) => http.get(redirect, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)));
    assert.equal(status, 200, 'listener is alive after the tool returned');
    // actor-aware flow: legacy GET parks the token; the actor POST completes it.
    const actorUrl = new URL(redirect); actorUrl.pathname = '/actor-callback'; actorUrl.search = `state=${url.searchParams.get('state')}`;
    // "no actor credential available" is the legitimate null-actor outcome
    const actorStatus = await new Promise((resolve) => {
      const req = http.request(actorUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', () => resolve(0)); req.end('actor_status=unavailable');
    });
    assert.equal(actorStatus, 204, 'actor step accepted');
    // completion is asynchronous — give it a beat
    for (let i = 0; i < 20 && !authStore.isAuthenticated(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(authStore.isAuthenticated(), true, 'credential persisted in memory by the background completion');
    assert.equal(config.getHandle(), 'newbie', 'identity recognized for the next start');
  } finally { restore(); }
});

// ── replyable inbox ──────────────────────────────────────────────────────
test('vibe_reply with no target REFUSES and lists the visible ids — never the newest by default', async () => {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'me', authMethod: 'github',
    authToken: `h.${Buffer.from(JSON.stringify({ sub: 'me', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig` }));
  delete require.cache[require.resolve('../config')]; delete require.cache[require.resolve('./reply')];
  const restore = stubStore({
    getInbox: async () => [
      { handle: 'ada', unread: 2, lastMessage: 'first one', lastMessageId: 'msg_A1', thread_id: 'thread_1' },
      { handle: 'bob', unread: 0, lastMessage: 'older', lastMessageId: 'msg_B1', thread_id: 'thread_2' },
    ],
    sendMessage: async () => { throw new Error('MUST NOT SEND'); },
  });
  try {
    const reply = require('./reply');
    const res = await reply.handler({ message: 'hi' });
    assert.match(res.display, /Not sent/);
    assert.ok(res.display.includes('#msg_A1') && res.display.includes('#msg_B1'), 'candidates listed with ids');
  } finally { restore(); }
});

test('vibe_reply consumes the exact id and resolves its thread without a `to`', async () => {
  const sent = [];
  const restore = stubStore({
    getInbox: async () => [
      { handle: 'ada', unread: 1, lastMessage: 'first one', lastMessageId: 'msg_A1', thread_id: 'thread_1' },
      { handle: 'bob', unread: 3, lastMessage: 'newest of all', lastMessageId: 'msg_B9', thread_id: 'thread_2' },
    ],
    getThread: async () => [{ id: 'msg_A1', from: 'ada', body: 'first one' }],
    sendMessage: async (from, to, body, kind, _n, opts) => { sent.push({ to, body, replyTo: opts?.replyTo }); return { id: 'msg_new' }; },
    sendTypingIndicator: async () => {}, markThreadRead: async () => {},
  });
  try {
    const reply = require('./reply');
    const res = await reply.handler({ message: 'answering ada', reply_to: 'msg_A1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ada', 'resolved the thread from the id, not the newest unread (bob)');
    assert.equal(sent[0].replyTo, 'msg_A1');
    assert.ok(!/Not sent/.test(res.display));
  } finally { restore(); }
});

test('the inbox list exposes each thread\'s stable message id', async () => {
  const restore = stubStore({
    getInbox: async () => [
      { handle: 'ada', unread: 2, lastMessage: 'x', lastMessageId: 'msg_A1', thread_id: 'thread_1', lastTimestamp: 2 },
      { handle: 'bob', unread: 1, lastMessage: 'y', lastMessageId: 'msg_B1', thread_id: 'thread_2', lastTimestamp: 1 },
    ],
    getTypingUsers: async () => [],
  });
  try {
    delete require.cache[require.resolve('./inbox')];
    const inbox = require('./inbox');
    const res = await inbox.handler({});
    assert.ok(res.display.includes('#msg_A1') && res.display.includes('#msg_B1'), `ids visible: ${res.display}`);
    assert.match(res.display, /reply_to/);
  } finally { restore(); }
});
