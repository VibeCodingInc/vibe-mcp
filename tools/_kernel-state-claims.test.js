/**
 * Every state CLAIM the kernel makes must be a state FACT.
 *
 * These tests pin the claims fixed in the default-surface polish pass, each of
 * which was rendering false in production when found:
 *
 *   1. "Sent to @x" appeared when nothing was sent — store.sendMessage returned
 *      null on a thrown transport error, and dm/reply read null as success.
 *   2. The 🤖 agent badge and (op: @handle) tag never rendered — the store's
 *      normalized field is `isAgent`, the board read `is_agent`. Same dead
 *      filter let the first-DM nudge point a newcomer at an agent.
 *   3. 🟢 appeared next to "_25m ago_" — the server files anyone seen <30m as
 *      "active", but green must mean a recent confirmed heartbeat.
 *   4. vibe_status with no mood was a raw TypeError instead of copy.
 *   5. Error copy advertised tools a default install doesn't register
 *      (`vibe doctor` is admin-gated) and a sign-in syntax that doesn't exist
 *      (`vibe init @yourhandle`).
 *
 * Run: node --test tools/_kernel-state-claims.test.js
 */

// A throwaway identity so requireInit passes without touching ~/.vibe.
// Must happen before any require pulls in config.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-claims-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// authMethod matters: without it config.hasOAuth() is false and vibe_init falls
// through the already-signed-in short-circuit into the LIVE browser OAuth flow.
// A test must never be able to reach that path.
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  // principal_id matters too (#320): a handle-only token now correctly REFUSES
  // the already-signed-in short-circuit (it falls through to reauth), so the
  // fixture must prove a principal for every test that expects the signed-in
  // surface. The handle-only shape gets its own pin below.
  authToken: `h.${b64({ sub: 'ada', principal_id: 'prin_ada_1', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  one_liner: 'migration cleanup',
}));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// No test may leave this process and touch the real network.
global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const mins = (n) => Date.now() - n * 60_000;

/** Stub the store surface a tool touches, reload the tool, return its handler. */
function toolWith(name, stubs) {
  const originals = {};
  for (const [k, v] of Object.entries(stubs)) {
    originals[k] = store[k];
    store[k] = v;
  }
  const toolPath = require.resolve(`./${name}.js`);
  delete require.cache[toolPath];
  const tool = require(toolPath);
  return {
    run: (args = {}) => tool.handler(args),
    restore: () => {
      for (const [k, v] of Object.entries(originals)) store[k] = v;
      delete require.cache[toolPath];
    },
  };
}

const QUIET_STORE = {
  getUnreadCount: async () => 0,
  getInbox: async () => [],
  getRawInbox: async () => [],
  getThread: async () => [],
  markThreadRead: async () => {},
  sendTypingIndicator: async () => {},
  getTypingUsers: async () => [],
  getActiveUsers: async () => [],
  heartbeat: async () => ({ ok: true }),
};

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ── 1. A send that delivered nothing must never claim delivery ─────────────

test('dm: a falsy store result is a failure, not "Sent to @x"', async () => {
  const h = toolWith('dm', { ...QUIET_STORE, getActiveUsers: async () => [], sendMessage: async () => null });
  try {
    const r = await h.run({ handle: 'rune', message: 'hello' });
    assert.ok(!/Sent to/i.test(r.display), 'must not claim the send succeeded');
    assert.match(r.display, /didn't send|not.*deliver/i, 'must say nothing was delivered');
  } finally { h.restore(); }
});

test('reply: a falsy store result is a failure, not "✓ Replied"', async () => {
  const h = toolWith('reply', {
    ...QUIET_STORE,
    getInbox: async () => [{ handle: 'rune', lastMessage: 'hi', unread: 1, lastTimestamp: mins(4) }],
    sendMessage: async () => null,
  });
  try {
    // The first-five-minutes repair made a target-less reply REFUSE before
    // any send (never guess the newest) — so this falsy-result pin names its
    // thread explicitly to reach the store, which is the path under test.
    const r = await h.run({ message: 'hello', to: 'rune' });
    assert.ok(!/Replied to/i.test(r.display), 'must not claim the reply succeeded');
    assert.ok(!/marked as read/i.test(r.display), 'must not claim the thread state changed');
    assert.match(r.display, /didn't send|not.*deliver/i);
  } finally { h.restore(); }
});

test('inbox: an explicit handle reopens a read thread without list-only work', async () => {
  const history = [
    {
      from: 'juno',
      body: 'the durable reply is already here',
      timestamp: mins(3),
      isAgent: false,
    },
    {
      from: 'ada',
      body: 'the original question',
      timestamp: mins(6),
      isAgent: false,
    },
  ];
  history._threadId = 'thread_ada_juno';
  history._lastMessageId = 'message_latest';
  let opened = null;
  let inboxCalls = 0;
  let typingCalls = 0;
  let checklistCalls = 0;
  let onboardingCalls = 0;
  const marked = [];
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ success: true, messages: [] }) };
  };
  const h = toolWith('inbox', {
    ...QUIET_STORE,
    getInbox: async () => { inboxCalls += 1; return []; },
    getThread: async (me, them) => {
      opened = { me, them };
      return history;
    },
    markThreadRead: async (...args) => { marked.push(args); },
    getTypingUsers: async () => { typingCalls += 1; return []; },
    trackChecklistCompletion: async () => { checklistCalls += 1; },
    getOnboardingData: async () => { onboardingCalls += 1; return { success: true }; },
  });
  try {
    const first = await h.run({ handle: 'juno' });
    const second = await h.run({ handle: '@JUNO' });
    assert.deepEqual(opened, { me: 'ada', them: 'juno' },
      'the named thread must be fetched even after its read cursor advances');
    assert.match(first.display, /Thread/);
    assert.match(second.display, /the durable reply is already here/);
    assert.ok(!/nothing unread/i.test(second.display),
      'the inbox summary must not hide a conversation the caller explicitly opened');
    assert.equal(inboxCalls, 0, 'named navigation must not fetch the inbox list');
    assert.equal(fetchCalls, 0, 'named navigation must not poll the guest queue');
    assert.equal(typingCalls, 0, 'typing presence must not hold a named thread open');
    assert.equal(checklistCalls, 0, 'named navigation must not run welcome checklist writes');
    assert.equal(onboardingCalls, 0, 'named navigation must not fetch recommendations');
    assert.deepEqual(marked, [
      ['ada', 'juno', 'message_latest', 'thread_ada_juno'],
      ['ada', 'juno', 'message_latest', 'thread_ada_juno'],
    ], 'read marking must reuse metadata from the direct thread response');
    assert.equal(first.footer, 'minimal', 'named navigation must request a non-blocking footer');
  } finally {
    global.fetch = originalFetch;
    h.restore();
  }
});

test('inbox: no handle with zero unread keeps the caught-up summary', async () => {
  let opened = false;
  const h = toolWith('inbox', {
    ...QUIET_STORE,
    getInbox: async () => [{
      handle: 'juno',
      unread: 0,
      lastMessage: 'already read',
      lastTimestamp: mins(3),
    }],
    getThread: async () => {
      opened = true;
      return [];
    },
  });
  try {
    const r = await h.run({});
    assert.equal(opened, false, 'the list view must not fetch a thread the caller did not name');
    assert.match(r.display, /nothing unread/i);
    assert.match(r.display, /your recent threads:.*@juno/i);
  } finally { h.restore(); }
});

test('dm: a remedy-carrying error is shown as-is, with no second instruction', async () => {
  const h = toolWith('dm', {
    ...QUIET_STORE,
    getActiveUsers: async () => [],
    sendMessage: async () => ({ error: 'auth_expired', message: 'Your /vibe session expired. Run `vibe init` to reconnect.' }),
  });
  try {
    const r = await h.run({ handle: 'rune', message: 'hello' });
    assert.match(r.display, /vibe init/, 'the remedy must survive');
    assert.ok(!/retry/i.test(r.display), 'no contradictory second instruction after a specific fix');
  } finally { h.restore(); }
});

test('send-failure copy never advertises admin-gated or unregistered tools', async () => {
  const h = toolWith('dm', {
    ...QUIET_STORE,
    getActiveUsers: async () => [],
    sendMessage: async () => ({ error: 'mystery_error' }),
  });
  try {
    const r = await h.run({ handle: 'rune', message: 'hello' });
    assert.ok(!/vibe doctor/i.test(r.display), 'vibe_doctor is admin-only; a default install cannot run it');
    assert.match(r.display, /vibe help troubleshooting/, 'the one next action must be a tool that exists');
  } finally { h.restore(); }
});

test('dm: sending to someone away states the async delivery model', async () => {
  const away = [{ handle: 'juno', one_liner: 'docs pass', lastSeen: mins(38), status: 'away', isAgent: false }];
  const h = toolWith('dm', {
    ...QUIET_STORE,
    getActiveUsers: async () => away,
    sendMessage: async () => ({ success: true, id: 'm_test' }),
  });
  try {
    const r = await h.run({ handle: 'juno', message: 'when you pick docs back up' });
    assert.match(r.display, /Sent to \*\*@juno\*\*/);
    assert.match(r.display, /away.*next turn/i, 'the away beat must say the message waits');
  } finally { h.restore(); }
});

// ── 2. People and agents are different things, visibly ─────────────────────

const ROOM = [
  { handle: 'atlas', one_liner: 'reviewing migrations', lastSeen: mins(1), status: 'active', isAgent: true, operator: 'rune' },
  { handle: 'rune', one_liner: 'schema + rollback tests', lastSeen: mins(2), status: 'active', isAgent: false },
];

test('who: an agent row carries the 🤖 badge and its operator', async () => {
  const h = toolWith('who', { ...QUIET_STORE, getActiveUsers: async () => ROOM });
  try {
    const r = await h.run();
    assert.match(r.display, /@atlas\*?\*?.* 🤖/, 'the agent must be visibly an agent');
    assert.match(r.display, /op: @rune/, 'the operator must be named');
    const atlas = r.structured.users.find((u) => u.handle === 'atlas');
    const rune = r.structured.users.find((u) => u.handle === 'rune');
    assert.equal(atlas.isAgent, true, 'structured mirror must agree with the board');
    assert.equal(atlas.operator, 'rune');
    assert.equal(rune.isAgent, false);
  } finally { h.restore(); }
});

test('the first-DM nudge never targets an agent', () => {
  const { pickDormantTarget } = require('./_shared.js');
  const target = pickDormantTarget(ROOM);
  assert.equal(target.handle, 'rune', 'the nudge must pick the human, not the agent');
  assert.equal(pickDormantTarget([ROOM[0]]), null, 'a room of only agents nudges nobody');
});

// ── 3. Green means a recent confirmed heartbeat ─────────────────────────────

test('who: server-"active" with a 25m-old heartbeat renders as away, not 🟢', async () => {
  const room = [
    { handle: 'rune', one_liner: 'schema + rollback tests', lastSeen: mins(2), status: 'active', isAgent: false },
    { handle: 'mira', one_liner: 'ci triage', lastSeen: mins(25), status: 'active', isAgent: false },
  ];
  const h = toolWith('who', { ...QUIET_STORE, getActiveUsers: async () => room });
  try {
    const r = await h.run();
    assert.ok(!/🟢 \*\*@mira\*\*/.test(r.display), 'a 25m-old heartbeat must not be green');
    assert.match(r.display, /💤 \*\*@mira\*\*/, 'the stale row still exists — as away');
    assert.match(r.display, /🟢 \*\*@rune\*\*/, 'a live heartbeat stays green');
    assert.equal(r.structured.users.find((u) => u.handle === 'mira').status, 'away',
      'the structured mirror must present the same fact as the board');
  } finally { h.restore(); }
});

// ── 3b. The freshness rule is defined once and honest at the boundary ──────

test('isHereNow: one rule for green, shared by who and dm', () => {
  const { isHereNow, RECENT_HEARTBEAT_MS } = require('./_shared.js');
  assert.equal(RECENT_HEARTBEAT_MS, 10 * 60 * 1000);
  assert.equal(isHereNow({ status: 'active', lastSeen: mins(9) }), true, 'a 9m heartbeat is here');
  assert.equal(isHereNow({ status: 'active', lastSeen: mins(11) }), false, 'an 11m silence is not');
  assert.equal(isHereNow({ status: 'away', lastSeen: mins(1) }), false, 'away is away, however fresh');
  assert.equal(isHereNow(null), false, 'nobody is not here');
});

// ── 3c. Signing off ends presence, not identity ────────────────────────────

// getAuthToken() reads the per-process session file BEFORE config.json, so a
// pin that plants a handle-only credential must clear both or it leaks forward.
// The principal fall-through lands in the REAL OAuth flow. A test must never
// reach it: an earlier version of this pin actually opened a sign-in window on
// the developer's machine, and left a callback listener running afterwards.
function stubOauth() {
  // Belt: CI is what openBrowser itself checks, so this holds even if the
  // module stub below is defeated by require ordering.
  const priorCI = process.env.CI;
  process.env.CI = '1';
  const oauthPath = require.resolve('../oauth-callback');
  const real = require.cache[oauthPath];
  require.cache[oauthPath] = {
    id: oauthPath, filename: oauthPath, loaded: true,
    exports: {
      ...(real ? real.exports : {}),
      beginOAuth: async () => { throw new Error('reauth-flow-reached'); },
    },
  };
  return () => {
    if (priorCI === undefined) delete process.env.CI; else process.env.CI = priorCI;
    if (real) require.cache[oauthPath] = real; else delete require.cache[oauthPath];
    try { require('./init.js')._resetPendingAuth(); } catch {}
  };
}

function clearSessionToken() {
  try { fs.unlinkSync(path.join(HOME, `.session_${process.pid}`)); } catch {}
}

test('init (#320): a handle-only session never claims "already signed in"', async () => {
  // The trap this pins shut: web reauth minted a principal-bearing cookie, but
  // ~/.vibe/auth.json kept the Aug-13 handle-only token and vibe_init
  // short-circuited — leaving the terminal with NO path to the server's reauth
  // action. A valid handle-only credential must fall through instead.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(keep);
  cfg.authToken = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // definitive AND valid: the fall-through is only correct about a session the
  // server confirmed alive. Stubbing `definitive: false` here pinned the exact
  // opposite of the offline invariant (round-1 review of #35).
  const restoreOauth = stubOauth();
  const h = toolWith('init', {
    ...QUIET_STORE,
    verifyAuthToken: async () => ({ definitive: true, valid: true }),
  });
  try {
    const r = await h.run({});
    const display = r?.display || '';
    assert.ok(!/Already signed in/.test(display),
      'a handle-only session must not short-circuit — it has no principal to be signed in AS');
  } finally {
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
  }
});

test('init (#320): offline is not a missing principal — it still short-circuits', async () => {
  // The regression this guards: falling through on a handle-only token
  // REGARDLESS of reachability rebuilds the #91 sign-in loop for anyone whose
  // server is slow or unreachable. Unreachable is not invalid.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(keep);
  cfg.authToken = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  for (const verification of [
    { definitive: false },                       // server could not say
    null,                                        // raced the 2.5s timeout
  ]) {
    const h = toolWith('init', { ...QUIET_STORE, verifyAuthToken: async () => verification });
    const restoreOauth = stubOauth();
    try {
      const r = await h.run({});
      assert.match(r?.display || '', /Already signed in/,
        `an unreachable server (${JSON.stringify(verification)}) forced a sign-in instead of short-circuiting`);
    } finally {
      restoreOauth();
      h.restore();
      clearSessionToken();
    }
  }
  fs.writeFileSync(cfgPath, keep);
});

test('init (#320): one identity\'s handle-only mint is never reported to another', async () => {
  // The flag was a process-global boolean: Ada's mint told Bob he had a
  // server-side minting problem.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const initPath = require.resolve('./init.js');
  const restoreOauth = stubOauth();
  const h = toolWith('init', {
    ...QUIET_STORE,
    verifyAuthToken: async () => ({ definitive: true, valid: true }),
  });
  try {
    const tool = require(initPath);
    // Ada's sign-in comes back handle-only.
    await tool._completeSignInForTest({ token: `h.${b64({ sub: 'ada' })}.sig`, handle: 'ada' }, 'x');
    // Now the process is serving Bob, who also holds a handle-only token. The
    // credential names us (auth-store is the authority), so switching the file
    // alone would leave the session still being Ada.
    const bobToken = `h.${b64({ sub: 'bob', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.username = 'bob';
    cfg.authToken = bobToken;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    clearSessionToken();
    const authStore = require('../auth-store');
    authStore.setToken(bobToken);
    authStore.setHandle('bob');
    const r = await h.run({});
    assert.ok(!/server-side minting issue/.test(r?.display || ''),
      "Ada's mint was reported to Bob");
  } finally {
    require(initPath)._resetMintStateForTest();
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
    const authStore = require('../auth-store');
    const restored = JSON.parse(keep);
    authStore.setToken(restored.authToken);
    authStore.setHandle(restored.username);
  }
});

test('init (#320): a second handle-only mint says so instead of looping', async () => {
  // Falling through is right ONCE. If the sign-in that just completed came back
  // handle-only too, sending the person around again is a loop, not a fix.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(keep);
  cfg.authToken = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const initPath = require.resolve('./init.js');
  const restoreOauth = stubOauth();
  const h = toolWith('init', {
    ...QUIET_STORE,
    verifyAuthToken: async () => ({ definitive: true, valid: true }),
  });
  try {
    // Complete a sign-in whose token proves only the handle.
    const tool = require(initPath);
    await tool._completeSignInForTest(
      { token: `h.${b64({ sub: 'ada' })}.sig`, handle: 'ada' }, 'migration cleanup'
    );
    const r = await h.run({});
    const display = r?.display || '';
    assert.match(display, /still proves only your handle/,
      'a repeat handle-only mint must be named, not retried silently');
    assert.match(display, /server-side minting issue/);
    assert.ok(!/Already signed in/.test(display));
  } finally {
    require(initPath)._resetMintStateForTest();   // module state must not leak
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
  }
});

test('init (already signed in): bye keeps your identity — no logout, no re-init', async () => {
  const h = toolWith('init', {
    ...QUIET_STORE,
    verifyAuthToken: async () => ({ definitive: false }),
  });
  try {
    const r = await h.run({});
    assert.match(r.display, /Already signed in as @ada/);
    assert.match(r.display, /vibe bye/, 'the sign-off that exists must be the one named');
    assert.match(r.display, /you stay @ada/i, 'must say identity survives the sign-off');
    assert.ok(!/logout/i.test(r.display), 'vibe logout is not a registered tool');
    assert.ok(!/init.*sign in again|sign in again.*init/i.test(r.display),
      'bye keeps the saved identity — re-init is a false instruction');
  } finally { h.restore(); }
});

// ── 4. Missing input is a state with copy, not a crash ─────────────────────

test('status: no mood at all returns guidance, not a TypeError', async () => {
  const h = toolWith('status', QUIET_STORE);
  try {
    const r = await h.run({});
    assert.match(r.display, /vibe status/, 'must point at the command with its options');
  } finally { h.restore(); }
});

// ── 5. Guidance may only name flows that exist ──────────────────────────────

test('token: bad-token guidance matches the real handle-less init flow', async () => {
  const h = toolWith('token', QUIET_STORE);
  try {
    const r = await h.run({ token: 'abc' });
    assert.match(r.display, /vibe init/);
    assert.ok(!/@yourhandle/.test(r.display), 'init takes no handle — your GitHub username becomes it');
  } finally { h.restore(); }
});

test('init (#320): a sign-in that could not be saved never claims it was', async () => {
  // config.save/saveSessionData can REFUSE. "The refreshed credential was
  // saved" is a claim about disk and must be answered by disk (round-2 review).
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(keep);
  cfg.authToken = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const config = require('../config');
  const realSave = config.save;
  const realSaveToken = config.saveAuthToken;
  const restoreOauth = stubOauth();
  const h = toolWith('init', { ...QUIET_STORE, verifyAuthToken: async () => ({ definitive: true, valid: true }) });
  const initPath = require.resolve('./init.js');
  try {
    config.save = () => false;            // the disk refuses
    config.saveAuthToken = () => false;
    const tool = require(initPath);
    await tool._completeSignInForTest({ token: cfg.authToken, handle: 'ada' }, 'x');
    config.save = realSave;
    config.saveAuthToken = realSaveToken;
    const r = await h.run({});
    const display = r?.display || '';
    assert.ok(!/refreshed credential was saved/.test(display),
      'claimed a saved credential on a path where nothing was written');
    assert.match(display, /could not be saved/, 'the failure must be named, not swallowed');
  } finally {
    config.save = realSave;
    config.saveAuthToken = realSaveToken;
    require(initPath)._resetMintStateForTest();
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
  }
});

test('init (#320): a mint record never outlives the credential it is about', async () => {
  // Sign out, then load a legacy token under the SAME handle: the old record
  // must not attach itself to a credential it was never part of.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const initPath = require.resolve('./init.js');
  const restoreOauth = stubOauth();
  const h = toolWith('init', { ...QUIET_STORE, verifyAuthToken: async () => ({ definitive: true, valid: true }) });
  const authStore = require('../auth-store');
  try {
    const tool = require(initPath);
    await tool._completeSignInForTest({ token: `h.${b64({ sub: 'ada' })}.sig`, handle: 'ada' }, 'x');
    // …signed out, then a DIFFERENT legacy token, same handle.
    const later = `h.${b64({ sub: 'ada', iat: 1, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.username = 'ada';
    cfg.authToken = later;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    clearSessionToken();
    authStore.setToken(later);
    authStore.setHandle('ada');
    const r = await h.run({});
    assert.ok(!/server-side minting issue/.test(r?.display || ''),
      'a record about an old credential was applied to a new one');
  } finally {
    require(initPath)._resetMintStateForTest();
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
    const restored = JSON.parse(keep);
    authStore.setToken(restored.authToken);
    authStore.setHandle(restored.username);
  }
});

// A segment that decodes to the SAME bytes but is spelled differently — the
// trailing pad bits are unused, so more than one encoding exists and only one
// of them is canonical.
function nonCanonicalTwin(seg) {
  const target = Buffer.from(seg, 'base64url');
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    const variant = seg.slice(0, -1) + c;
    if (variant !== seg && Buffer.from(variant, 'base64url').equals(target)) return variant;
  }
  throw new Error('no non-canonical twin for this segment — the pin cannot run');
}

test('principalFromToken: a malformed JWT proves nothing', () => {
  const authStore = require('../auth-store');
  const H = b64({ alg: 'ES256', typ: 'JWT' });
  const P = b64({ principal_id: 'prin_ok' });
  assert.equal(authStore.principalFromToken(`${H}.${P}.sig`), 'prin_ok');
  for (const [name, tok] of [
    ['bad signature', `${H}.${P}.!!!`],
    ['impossible header', `A.${P}.sig`],
    ['non-JSON header', `aGVsbG8.${P}.sig`],
    ['missing signature', `${H}.${P}`],
    ['empty signature', `${H}.${P}.`],
    ['missing header', `.${P}.sig`],
    ['extra segment', `${H}.${P}.sig.x`],
    ['non-string', { toString() { return `${H}.${P}.sig`; } }],
    ['numeric pid', `${H}.${b64({ principal_id: 1 })}.sig`],
    ['null', null],
    // These are why the length and canonical-form guards exist. Without them
    // the pin passed with the guards reverted (round-4 review: vacuous).
    ['single-char signature', `${H}.${P}.A`],
    ['single-char signature _', `${H}.${P}._`],
    ['non-canonical payload', `${H}.${P.slice(0, -1)}B.sig`],
    // The case ONLY the canonical round-trip catches: same decoded bytes, so
    // the JSON still parses and every other guard passes it — it is simply not
    // the encoding it claims to be. Found by searching the alphabet for a twin.
    ['non-canonical twin', `${H}.${nonCanonicalTwin(P)}.sig`],
  ]) {
    assert.equal(authStore.principalFromToken(tok), null, `${name} reported a principal it did not prove`);
  }
});

test('vibe token: unreachable is not invalid', async () => {
  // The same defect as init's: {valid:false, definitive:false} is a timeout,
  // and telling that person to start a fresh sign-in cannot help them.
  const t = toolWith('token', {
    ...QUIET_STORE,
    verifyAuthToken: async () => ({ valid: false, definitive: false, error: 'connect ETIMEDOUT' }),
  });
  try {
    const r = await t.run({ token: `h.${b64({ sub: 'ada' })}.sig` });
    const display = r?.display || '';
    assert.ok(!/verification failed/i.test(display), 'a timeout was reported as a failed token');
    assert.ok(!/Start a fresh sign-in/.test(display), 'a timeout must not send the person to re-auth');
    assert.match(display, /couldn't reach|could not reach/i);
  } finally {
    t.restore();
  }
});

test('init (#320): an auth flow is never shared with a different identity', async () => {
  // Ada starts a flow; Bob starts one. Bob must not receive Ada's login URL —
  // completing it would have signed Bob in as Ada.
  const initPath = require.resolve('./init.js');
  const oauthPath = require.resolve('../oauth-callback');
  const realOauth = require.cache[oauthPath];
  const issued = [];
  require.cache[oauthPath] = {
    id: oauthPath, filename: oauthPath, loaded: true,
    exports: {
      ...(realOauth ? realOauth.exports : {}),
      beginOAuth: async ({ requestedHandle }) => {
        const url = `https://example.invalid/login?who=${requestedHandle}`;
        issued.push(requestedHandle);
        return { loginUrl: url, waitForCallback: () => new Promise(() => {}), cancel: async () => {} };
      },
    },
  };
  const priorCI = process.env.CI;
  process.env.CI = '1';
  delete require.cache[initPath];
  const tool = require(initPath);
  try {
    tool._resetPendingAuth();
    const a = await tool._ensureAuthFlowForTest({ requestedHandle: 'ada' });
    const b = await tool._ensureAuthFlowForTest({ requestedHandle: 'bob' });
    assert.notEqual(a.loginUrl, b.loginUrl, "Bob was handed Ada's login URL");
    assert.deepEqual(issued, ['ada', 'bob'], 'a flow was reused across identities');
    const again = await tool._ensureAuthFlowForTest({ requestedHandle: 'bob' });
    assert.equal(again.loginUrl, b.loginUrl, 'the same identity must still share one flow');
  } finally {
    tool._resetPendingAuth();
    if (priorCI === undefined) delete process.env.CI; else process.env.CI = priorCI;
    if (realOauth) require.cache[oauthPath] = realOauth; else delete require.cache[oauthPath];
    delete require.cache[initPath];
  }
});

test('verifyAuthToken: a REAL unreachable server is not a verdict', async () => {
  // The round-3 finding: request() resolves on transport failure, so this
  // classified ECONNREFUSED as definitive — the server saying no. The stubbed
  // {definitive:false} pins passed while production did the opposite, which is
  // the whole reason this one runs against a dead endpoint in a child process.
  const { execFileSync } = require('node:child_process');
  const script = `
    process.env.VIBE_API_URL = 'http://127.0.0.1:9';
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'api.js'))});
    store.verifyAuthToken('h.eyJzdWIiOiJhZGEifQ.sig').then((v) => {
      process.stdout.write(JSON.stringify(v));
    });
  `;
  const out = execFileSync('node', ['-e', script], {
    env: { ...process.env, VIBE_SETUP_NO_AUTORUN: '1', CI: '1' },
    encoding: 'utf8', timeout: 60000,
  });
  const v = JSON.parse(out);
  assert.equal(v.valid, false);
  assert.equal(v.definitive, false, 'an unreachable server was reported as a verdict about the token');
});

test('init (#320): a failed token write still reports the failure', async () => {
  // Keying the persist-failure record by the NEW token was wrong: when the
  // token write is what failed, disk still holds the OLD token, so the next
  // call never matched and silently started another flow (round-3 review).
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(keep);
  cfg.authToken = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const config = require('../config');
  const realSaveToken = config.saveAuthToken;
  const restoreOauth = stubOauth();
  const h = toolWith('init', { ...QUIET_STORE, verifyAuthToken: async () => ({ definitive: true, valid: true }) });
  const initPath = require.resolve('./init.js');
  try {
    config.saveAuthToken = () => false;          // ONLY the token write fails
    const tool = require(initPath);
    await tool._completeSignInForTest({ token: `h.${b64({ sub: 'ada', iat: 99 })}.sig`, handle: 'ada' }, 'x');
    config.saveAuthToken = realSaveToken;
    const display = (await h.run({}))?.display || '';
    assert.match(display, /could not be saved/, 'a failed token write started another flow instead of saying so');
  } finally {
    config.saveAuthToken = realSaveToken;
    require(initPath)._resetMintStateForTest();
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
  }
});

test('init (#320): simultaneous flows for two identities are both tracked', async () => {
  // A single creation slot meant Ada and Bob starting at the same moment each
  // bound a listener while only the last was remembered — the other could
  // never be cancelled. And cancelling a live flow that belonged to someone
  // else dropped a callback already in flight, losing their credential.
  const initPath = require.resolve('./init.js');
  const oauthPath = require.resolve('../oauth-callback');
  const realOauth = require.cache[oauthPath];
  const cancelled = [];
  const made = [];
  require.cache[oauthPath] = {
    id: oauthPath, filename: oauthPath, loaded: true,
    exports: {
      ...(realOauth ? realOauth.exports : {}),
      beginOAuth: async ({ requestedHandle }) => {
        await new Promise((r) => setTimeout(r, 20));   // both in flight at once
        made.push(requestedHandle);
        return {
          loginUrl: `https://example.invalid/login?who=${requestedHandle}`,
          waitForCallback: () => new Promise(() => {}),
          cancel: async () => { cancelled.push(requestedHandle); },
        };
      },
    },
  };
  const priorCI = process.env.CI;
  process.env.CI = '1';
  delete require.cache[initPath];
  const tool = require(initPath);
  try {
    await tool._resetPendingAuth();
    const [a, b] = await Promise.all([
      tool._ensureAuthFlowForTest({ requestedHandle: 'ada' }),
      tool._ensureAuthFlowForTest({ requestedHandle: 'bob' }),
    ]);
    assert.notEqual(a.loginUrl, b.loginUrl, "Bob was handed Ada's login URL");
    assert.deepEqual(cancelled, [], "a live flow belonging to someone else was cancelled mid-callback");
    // …and BOTH must be reachable by the reset, or one listener leaks.
    await tool._resetPendingAuth();
    assert.deepEqual(cancelled.sort(), ['ada', 'bob'], 'a concurrently-created flow could not be cancelled');
  } finally {
    if (priorCI === undefined) delete process.env.CI; else process.env.CI = priorCI;
    if (realOauth) require.cache[oauthPath] = realOauth; else delete require.cache[oauthPath];
    delete require.cache[initPath];
  }
});

test('verifyAuthToken: a 200 that says no is still an answer', async () => {
  // Round-4: keying "did the server answer?" on the ABSENCE of a statusCode
  // meant a 200 body carrying {success:false} was reported as offline.
  const http = require('node:http');
  // Answer immediately. Waiting for the request body's 'end' meant the reply
  // never went out and the client timed out — which would have "passed" this
  // pin for the wrong reason on the very defect it exists to catch.
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: false, valid: false, error: 'token revoked' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // execFile, NOT execFileSync: the sync form blocks this process's event
    // loop, so the server above can never answer the child and every run
    // "passes" as a timeout — on the exact defect this pin exists to catch.
    const { execFile } = require('node:child_process');
    const script = `
      const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'api.js'))});
      store.verifyAuthToken('h.eyJzdWIiOiJhZGEifQ.sig').then((v) => process.stdout.write(JSON.stringify(v)));
    `;
    const out = await new Promise((resolve, reject) => {
      execFile('node', ['-e', script], {
        env: { ...process.env, VIBE_API_URL: `http://127.0.0.1:${port}`, VIBE_SETUP_NO_AUTORUN: '1', CI: '1' },
        encoding: 'utf8', timeout: 60000,
      }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const v = JSON.parse(out);
    assert.equal(v.valid, false);
    assert.equal(v.definitive, true, 'a served refusal was reported as an unreachable server');
  } finally {
    server.close();
  }
});

test('init (#320): a stale persist complaint never attaches to a different credential', async () => {
  // Round-4 confirmed the handle-only key reintroduced the round-2 defect.
  // The record now names the person AND the credential they still hold.
  const cfgPath = path.join(HOME, 'config.json');
  const keep = fs.readFileSync(cfgPath, 'utf8');
  const original = `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  const cfg = JSON.parse(keep);
  cfg.username = 'ada';
  cfg.authToken = original;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const config = require('../config');
  const realSaveToken = config.saveAuthToken;
  const restoreOauth = stubOauth();
  const h = toolWith('init', { ...QUIET_STORE, verifyAuthToken: async () => ({ definitive: true, valid: true }) });
  const initPath = require.resolve('./init.js');
  const authStore = require('../auth-store');
  try {
    config.saveAuthToken = () => false;
    await require(initPath)._completeSignInForTest({ token: `h.${b64({ sub: 'ada', iat: 7 })}.sig`, handle: 'ada' }, 'x');
    config.saveAuthToken = realSaveToken;
    // The person still holds `original`, so the complaint applies…
    assert.match((await h.run({}))?.display || '', /could not be saved/);
    // …but an UNRELATED credential later loaded under the same name must not
    // inherit it.
    const unrelated = `h.${b64({ sub: 'ada', iat: 999, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
    const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    c2.authToken = unrelated;
    fs.writeFileSync(cfgPath, JSON.stringify(c2));
    clearSessionToken();
    authStore.setToken(unrelated);
    authStore.setHandle('ada');
    assert.ok(!/could not be saved/.test((await h.run({}))?.display || ''),
      'a stale complaint attached itself to a credential it was never about');
  } finally {
    config.saveAuthToken = realSaveToken;
    require(initPath)._resetMintStateForTest();
    restoreOauth();
    h.restore();
    fs.writeFileSync(cfgPath, keep);
    clearSessionToken();
    const restored = JSON.parse(keep);
    authStore.setToken(restored.authToken);
    authStore.setHandle(restored.username);
  }
});

test('init (#320): expired flows do not accumulate', async () => {
  const initPath = require.resolve('./init.js');
  const oauthPath = require.resolve('../oauth-callback');
  const realOauth = require.cache[oauthPath];
  require.cache[oauthPath] = {
    id: oauthPath, filename: oauthPath, loaded: true,
    exports: {
      ...(realOauth ? realOauth.exports : {}),
      beginOAuth: async ({ requestedHandle }) => ({
        loginUrl: `https://example.invalid/login?who=${requestedHandle}`,
        waitForCallback: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
  const priorCI = process.env.CI;
  process.env.CI = '1';
  delete require.cache[initPath];
  const tool = require(initPath);
  try {
    await tool._resetPendingAuth();
    for (let i = 0; i < 20; i++) {
      await tool._ensureAuthFlowForTest({ requestedHandle: `person${i}` });
    }
    assert.equal(tool._flowCountForTest(), 20);
    tool._forceExpireForTest();
    tool._ageOutFlowsForTest();
    await tool._ensureAuthFlowForTest({ requestedHandle: 'someone-new' });
    assert.equal(tool._flowCountForTest(), 1,
      'timed-out flows were retained — the map grows without bound');
  } finally {
    await tool._resetPendingAuth();
    if (priorCI === undefined) delete process.env.CI; else process.env.CI = priorCI;
    if (realOauth) require.cache[oauthPath] = realOauth; else delete require.cache[oauthPath];
    delete require.cache[initPath];
  }
});
