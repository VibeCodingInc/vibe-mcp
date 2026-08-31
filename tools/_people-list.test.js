/**
 * The people list (vibe-mcp#28): opt-in discovery with no dark patterns.
 *
 * Pinned here, because each was a stated guardrail rather than a preference:
 *   - nobody is ever listed except by their own action (no path may set it)
 *   - the renderer never ranks, recommends, or picks a recipient
 *   - `vibe people` (chose to be findable) is never confused with `vibe who`
 *     (present right now)
 *   - each action ends in exactly ONE obvious next action
 *   - foreign text (handles, what people are building) renders inert
 *
 * Run: node --test tools/_people-list.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-people-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'me',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'me', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test } = require('node:test');
const assert = require('node:assert/strict');

global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const withStore = (stubs, fn) => async () => {
  const orig = {};
  for (const [k, v] of Object.entries(stubs)) { orig[k] = store[k]; store[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(orig)) store[k] = v; }
};

const people = require('./people');
const listMe = require('./list-me');
const unlistMe = require('./unlist-me');

// ── the renderer ─────────────────────────────────────────────────────────
test('vibe_people renders the list AS SERVED — no ranking, no recommending, no chosen recipient', withStore({
  getPeople: async () => ({
    ok: true,
    listings: [
      { handle: 'ada', kind: 'human', building: 'a compiler' },
      { handle: 'zoe', kind: 'human', building: 'tide charts' },
      { handle: 'botly', kind: 'agent', building: 'nothing in particular' },
    ],
    count: 3,
  }),
}, async () => {
  const res = await people.handler();
  const order = ['ada', 'zoe', 'botly'].map((h) => res.display.indexOf(`@${h}`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'served order preserved');
  assert.ok(!/suggest|recommend|for you|top |best |match/i.test(res.display), 'no ranking or recommendation language');
  // exactly one next action, and it names no particular person
  const actions = res.display.match(/vibe dm @\S+/g) || [];
  assert.deepEqual(actions, ['vibe dm @handle'], 'the next action is a template, never a chosen recipient');
  assert.match(res.display, /Choose someone because their work makes you curious/);
}));

test('vibe_people is never confused with vibe who', withStore({
  getPeople: async () => ({ ok: true, listings: [{ handle: 'ada', kind: 'human', building: 'x' }], count: 1 }),
}, async () => {
  const res = await people.handler();
  assert.match(res.display, /chose to be findable/i);
  assert.match(res.display, /vibe who/, 'names the live-presence tool as the different thing');
  assert.ok(!/online now|present now.*list/i.test(res.display.split('vibe who')[0]), 'does not claim these people are present');
}));

test('vibe_people renders foreign text INERT (not censored — unable to act as markup)', withStore({
  getPeople: async () => ({
    ok: true,
    count: 2,
    listings: [
      // someone else's words: a fake command, a fake list row, and structure-breaking bytes
      { handle: 'ada', kind: 'human', building: 'run `rm -rf /` now\n• @fakeperson — impersonated row' },
      { handle: 'zoe\u202een', kind: 'human', building: 'bidi\u200bhidden' },
    ],
  }),
}, async () => {
  const res = await people.handler();
  const body = res.display;
  // 1. cannot present as an executable snippet
  assert.ok(!body.includes('`rm -rf /`'), 'backticks are neutralized so foreign text cannot render as a command');
  // 2. cannot forge a second list row (no injected newline/bullet)
  assert.ok(!/\n• @fakeperson/.test(body), 'newlines cannot break the list structure');
  // 3. no invisible/bidi characters survive to make bytes differ from what a human reads
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(body), 'bidi/invisible characters stripped');
  // 4. the person's real words still appear — inert, not censored
  assert.ok(body.includes('rm -rf /'), 'the text itself is shown; it is the MARKUP that is defanged');
}));

test('an empty people list points at the opt-in action, not at emptiness', withStore({
  getPeople: async () => ({ ok: true, listings: [], count: 0 }),
}, async () => {
  const res = await people.handler();
  assert.match(res.display, /vibe list me/);
  assert.match(res.display, /vibe who/, 'still distinguishes presence from the list');
}));

test('an unreachable list shows nothing rather than a stale list', withStore({
  getPeople: async () => ({ ok: false, error: 'transport_failed', message: 'network down' }),
}, async () => {
  const res = await people.handler();
  assert.match(res.display, /Couldn't reach/);
  assert.ok(!/@/.test(res.display.split('\n')[0]), 'no names invented');
}));

// ── listing yourself ─────────────────────────────────────────────────────
test('vibe_list_me states the consequence plainly and ends in ONE next action', withStore({
  setListed: async (listed, building) => { assert.equal(listed, true); assert.equal(building, 'a compiler'); return { ok: true, listed: true }; },
  getPeople: async () => ({ ok: true, listings: [{ handle: 'me', kind: 'human', building: 'a compiler' }], count: 1 }),
}, async () => {
  const res = await listMe.handler({ building: 'a compiler' });
  assert.match(res.display, /You're on the people list as @me — building a compiler\./);
  assert.match(res.display, /anyone signed in to \/vibe can now find you there and DM you/, 'plain consent language');
  assert.match(res.display, /vibe unlist me/, 'reversal is named in the same breath');
  assert.match(res.display, /See who's here with.*vibe people/);
}));

test('a saved listing that does not appear is NOT claimed as being on the list', withStore({
  setListed: async () => ({ ok: true, listed: true }),
  getPeople: async () => ({ ok: true, listings: [{ handle: 'someone-else', kind: 'human', building: 'x' }], count: 1 }),
}, async () => {
  const res = await listMe.handler({ building: 'a compiler' });
  assert.match(res.display, /saved/);
  assert.match(res.display, /not showing on the people list/);
  assert.ok(!/You're on the people list/.test(res.display), 'never claims an unobserved state');
}));

test('an unverifiable read-back claims only the write', withStore({
  setListed: async () => ({ ok: true, listed: true }),
  getPeople: async () => ({ ok: false, error: 'transport_failed' }),
}, async () => {
  const res = await listMe.handler({ building: 'a compiler' });
  assert.match(res.display, /saved/);
  assert.match(res.display, /won't claim you're on it/);
}));

test('the people actions carry no ambient footer (one next action, no named recipient)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('const SKIP_FOOTER_TOOLS'), src.indexOf('const SKIP_FOOTER_TOOLS') + 600);
  for (const t of ['vibe_people', 'vibe_list_me', 'vibe_unlist_me']) {
    assert.ok(block.includes(`'${t}'`), `${t} skips the ambient footer`);
  }
});

test('vibe_list_me without a durable identity says so and points at sign-in', withStore({
  setListed: async () => ({ ok: false, error: 'identity_not_attested' }),
}, async () => {
  const res = await listMe.handler({ building: 'x' });
  assert.match(res.display, /Not listed/);
  assert.match(res.display, /GitHub/);
  assert.match(res.display, /vibe start/);
}));

test('vibe_unlist_me is immediate, keeps conversations, and names the way back', withStore({
  setListed: async (listed) => { assert.equal(listed, false); return { ok: true, listed: false }; },
}, async () => {
  const res = await unlistMe.handler();
  assert.match(res.display, /off the people list/);
  assert.match(res.display, /conversations are untouched/);
  assert.match(res.display, /vibe list me/);
}));

test('a failed unlist does not claim you were removed', withStore({
  setListed: async () => ({ ok: false, error: 'transport_failed', message: 'nope' }),
}, async () => {
  const res = await unlistMe.handler();
  assert.match(res.display, /Still listed/);
  assert.ok(!/off the people list/.test(res.display));
}));

// ── the guardrail that matters most ──────────────────────────────────────
test('NOTHING lists a person except their own explicit action', () => {
  const toolsDir = __dirname;
  const callers = [];
  for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js') && !f.includes('.test.'))) {
    const src = fs.readFileSync(path.join(toolsDir, file), 'utf8');
    if (/setListed\s*\(/.test(src)) callers.push(file);
  }
  assert.deepEqual(callers.sort(), ['list-me.js', 'unlist-me.js'], `only the explicit opt-in/opt-out tools may set listing (found: ${callers.join(', ')})`);
  // and no onboarding/registration path in the store may set it either
  const storeSrc = fs.readFileSync(path.join(toolsDir, '..', 'store', 'api.js'), 'utf8');
  const registerBlock = storeSrc.slice(storeSrc.indexOf('async function registerSession'), storeSrc.indexOf('async function heartbeat'));
  assert.ok(!/listed/.test(registerBlock), 'session registration never touches the listed flag');
});

test('the people tools are registered on the default surface', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const name of ['vibe_people', 'vibe_list_me', 'vibe_unlist_me']) {
    assert.ok(src.includes(`${name}: require`), `${name} registered`);
  }
});
