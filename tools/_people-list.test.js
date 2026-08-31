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
  const order = ['ada', 'zoe', 'botly'].map((h) => res.display.indexOf(`@${h}\``));
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
  assert.match(res.display, /not on the people list I just read back/);
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
test('NOTHING anywhere in the package lists a person except their own explicit action', () => {
  // Whole-package scan (review P2): a `listed` write hidden in heartbeat,
  // onboarding, presence, init/start or any store function would have passed
  // the old tools-only scan.
  const root = path.join(__dirname, '..');
  // scripts/ and games/ SHIP (they are in package.json files), so the
  // invariant must cover them (review P2).
  const skipDirs = new Set(['node_modules', '.git', 'test', 'docs']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
      if (!/\.(js|cjs|mjs)$/.test(entry.name) || entry.name.includes('.test.')) continue;
      const rel = path.relative(root, path.join(dir, entry.name));
      const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      // any call that sets the flag, or any request body carrying it
      const setsFlag = /setListed\s*\(/.test(src) || /listed\s*:\s*(true|false|want|listed)/.test(src);
      if (setsFlag) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(
    offenders.sort(),
    ['store/api.js', 'tools/list-me.js', 'tools/unlist-me.js'].sort(),
    `only the two explicit tools (via the one store helper) may set listing — found: ${offenders.join(', ')}`
  );
  // …and the store's own write helper is the ONLY place the body is built
  const storeSrc = fs.readFileSync(path.join(root, 'store', 'api.js'), 'utf8');
  const writes = storeSrc.split('\n').filter((l) => /listed\s*:/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.ok(writes.length <= 2, `listed is written in one place only (found ${writes.length} lines)`);
  const registerBlock = storeSrc.slice(storeSrc.indexOf('async function registerSession'), storeSrc.indexOf('async function heartbeat'));
  assert.ok(!/listed/.test(registerBlock), 'session registration never touches the listed flag');
});

// ── the review's own reproductions, pinned ───────────────────────────────
test('a plainly FAILED write says so; an unconfirmed one does not (see the unconfirmed pin)', withStore({
  setListed: async () => ({ ok: false, error: 'transport_failed', message: 'network down' }),
}, async () => {
  const off = await unlistMe.handler();
  assert.match(off.display, /Still listed/, 'a definite failure may say the state is unchanged');
  assert.ok(!/off the people list/.test(off.display), 'no removal claim');
}));

test('the REAL response interpreters decide these outcomes (not a stub)', () => {
  const { interpretListedResponse, interpretDirectoryResponse } = require('../store/api.js');
  // a write the server does not echo
  assert.equal(interpretListedResponse({ success: true, user: {} }, true).error, 'unconfirmed');
  assert.equal(interpretListedResponse({ success: true }, true).error, 'unconfirmed');
  // a write the server echoes as the OTHER value
  assert.equal(interpretListedResponse({ success: true, user: { listed: false } }, true).error, 'unconfirmed');
  assert.equal(interpretListedResponse({ success: true, user: { listed: true } }, false).error, 'unconfirmed');
  // the honest success
  assert.deepEqual(interpretListedResponse({ success: true, user: { listed: true } }, true), { ok: true, listed: true });
  // explicit refusals keep their code
  assert.equal(interpretListedResponse({ success: false, error: 'identity_not_attested' }, true).error, 'identity_not_attested');
  // directory: malformed is a FAILURE, empty array is a legitimate empty list
  assert.equal(interpretDirectoryResponse({ success: true }).error, 'malformed_response');
  assert.equal(interpretDirectoryResponse({ success: true, listings: 'nope' }).error, 'malformed_response');
  assert.deepEqual(interpretDirectoryResponse({ success: true, listings: [], count: 0 }).listings, []);
});

test('an unconfirmed write claims NEITHER success nor "nothing changed"', withStore({
  setListed: async () => ({ ok: false, error: 'unconfirmed', message: 'the server did not say whether the change took' }),
}, async () => {
  const on = await listMe.handler({ building: 'x' });
  assert.match(on.display, /can't tell whether you were listed/);
  assert.ok(!/nothing changed/.test(on.display), 'never asserts the write did not happen');
  assert.ok(!/You're on the people list/.test(on.display), 'never asserts it did');
  const off = await unlistMe.handler();
  assert.match(off.display, /can't tell whether you were taken off/);
  assert.ok(!/nothing changed/.test(off.display));
  assert.ok(!/off the people list/.test(off.display));
  assert.match(off.display, /vibe list me/, 'the unknown-outcome branch names the reversal too');
}));

test('foreign prose cannot emphasize ANYTHING — including by pairing with the surface\'s own markdown', withStore({
  getPeople: async () => ({
    ok: true, count: 2,
    listings: [
      // a LONE underscore: the review's reproduction — it must not close or
      // open emphasis against the tool's own authored copy or the next row
      { handle: 'vibe_tester', kind: 'human', building: '_attacker' },
      { handle: 'ada', kind: 'human', building: '__bold__ _it_ ~~gone~~ trailing_' },
    ],
  }),
}, async () => {
  const res = await people.handler();
  const rows = res.display.split('\n').filter((l) => l.startsWith('• '));
  // no underscore or tilde survives anywhere in a rendered ROW
  for (const row of rows) {
    const prose = row.split(' — ')[1] || '';
    assert.ok(!/[_~]/.test(prose), `no emphasis character survives in foreign prose: ${prose}`);
  }
  // identity is rendered EXACTLY, inside a code span where pairing is impossible
  assert.ok(res.display.includes('`@vibe_tester`'), 'the handle is exact, fenced, unmangled');
  assert.ok(res.display.includes('attacker') && res.display.includes('bold') && res.display.includes('gone'),
    'words preserved — defanged, not censored');
}));

test('a malformed directory response is a read FAILURE, never an empty list', withStore({
  getPeople: async () => ({ ok: false, error: 'malformed_response', message: 'the list came back without entries' }),
}, async () => {
  const res = await people.handler();
  assert.match(res.display, /Couldn't reach/);
  assert.ok(!/nobody is on the list/.test(res.display), 'never renders emptiness from a broken read');
}));

test('HTML and Markdown in foreign text cannot forge a row, hide, or style', withStore({
  getPeople: async () => ({
    ok: true,
    count: 1,
    listings: [{ handle: 'ada', kind: 'human', building: '<br>• @forged — fake row **official** <details>hidden</details>' }],
  }),
}, async () => {
  const res = await people.handler();
  assert.ok(!/<br>|<details>|<\/details>/.test(res.display), 'no HTML element survives');
  assert.ok(!/\*\*official\*\*/.test(res.display), 'no Markdown emphasis survives');
  assert.equal((res.display.match(/^• `@/gm) || []).length, 1, 'exactly one row rendered');
  assert.ok(res.display.includes('forged'), 'the words are still shown — inert, not censored');
}));

test('an equivalent served handle is recognized by the canonical contract', withStore({
  setListed: async () => ({ ok: true, listed: true }),
  getPeople: async () => ({ ok: true, count: 1, listings: [{ handle: '@ME', kind: 'human', building: 'x' }] }),
}, async () => {
  const res = await listMe.handler({ building: 'a compiler' });
  assert.match(res.display, /You're on the people list as @me/, '@ME is the same person as me');
  void 0;
}));

test('every list-me branch names the reversal', withStore({
  setListed: async () => ({ ok: true, listed: true }),
  getPeople: async () => ({ ok: true, count: 0, listings: [] }),
}, async () => {
  const absent = await listMe.handler({ building: 'x' });
  assert.match(absent.display, /vibe unlist me/, 'saved-but-absent names the reversal');
  assert.ok(!/publishes some accounts/.test(absent.display), 'asserts no unverified cause');
}));

test('an unreadable list-back still names the reversal', withStore({
  setListed: async () => ({ ok: true, listed: true }),
  getPeople: async () => ({ ok: false, error: 'transport_failed' }),
}, async () => {
  const res = await listMe.handler({ building: 'x' });
  assert.match(res.display, /won't claim you're on it/);
  assert.match(res.display, /vibe unlist me/);
}));

test('the people tools are registered on the default surface', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const name of ['vibe_people', 'vibe_list_me', 'vibe_unlist_me']) {
    assert.ok(src.includes(`${name}: require`), `${name} registered`);
  }
});
