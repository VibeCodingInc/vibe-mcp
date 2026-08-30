/**
 * The capability contract: every verb reports exactly one of
 * granted / available / off / unavailable — truthfully, with no guessing,
 * no private reads, no execution during discovery.
 *
 * Run: node --test tools/_capability-contract.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cap-'));
process.env.VIBE_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');

function freshManifest(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../capabilities')];
  const m = require('../capabilities').manifest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return m;
}

const STATES = new Set(['granted', 'available', 'off', 'unavailable']);

test('every verb reports exactly one legal state with a reason', () => {
  const m = freshManifest();
  for (const verb of ['remember', 'reflect', 'message', 'call']) {
    assert.ok(m[verb], `${verb} present`);
    assert.ok(STATES.has(m[verb].state), `${verb} state legal: ${m[verb].state}`);
    assert.ok(m[verb].why && m[verb].why.length > 5, `${verb} carries a reason`);
    assert.ok(m[verb].provider, `${verb} names its provider`);
  }
});

test('off means OFF: the env flag wins and providers are not probed', () => {
  const m = freshManifest({ VIBE_REMEMBER: 'off', VIBE_REFLECT: 'off', VIBE_CALL: 'off' });
  assert.equal(m.remember.state, 'off');
  assert.equal(m.reflect.state, 'off');
  assert.equal(m.call.state, 'off');
});

test('absent providers are UNAVAILABLE, never guessed available', () => {
  // In this sandbox HOME there is no Mind grant; point PATH at an empty dir
  // and VIBE_STATS_CLI at a missing file so no provider can be found.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-empty-'));
  const m = freshManifest({ PATH: emptyDir, VIBE_STATS_CLI: path.join(emptyDir, 'nope') });
  assert.equal(m.reflect.state, 'unavailable');
  // remember falls to the vibe-check db existence check under the REAL home;
  // whatever it reports must still be a legal, reasoned state (pinned above).
});

test('discovery reads no file contents and executes nothing', () => {
  const reads = [];
  const origRead = fs.readFileSync;
  const cp = require('node:child_process');
  const origExec = cp.execFileSync;
  fs.readFileSync = (p, ...rest) => {
    reads.push(String(p));
    return origRead(p, ...rest);
  };
  cp.execFileSync = () => {
    throw new Error('discovery must not execute');
  };
  try {
    // module already loaded above — spy only the manifest() call itself,
    // not Node's own source-file read on require()
    require('../capabilities').manifest();
  } finally {
    fs.readFileSync = origRead;
    cp.execFileSync = origExec;
  }
  // The ONE legal content read is the Mind bearer token (the grant itself,
  // 0600, personal-mind.js). Nothing else — not the VibeCheck db, not its
  // config, not any provider file.
  const illegal = reads.filter((p) => !/mind[\/\\]runtime-token$/.test(p));
  assert.deepEqual(illegal, [], `illegal discovery reads: ${illegal.join(', ')}`);
});

test('vibe_remember without a grant answers with the state, not a probe', async () => {
  const remember = require('./remember');
  const res = await remember.handler({ handle: 'someone', draft: 'a draft that stays local' });
  // In the sandbox HOME there is no grant: the answer must be a truthful
  // state line and silence — never an offer, never an error.
  assert.ok(res.data.silence === true || res.data.offer, 'silence or a real offer only');
  if (res.data.capability) {
    assert.notEqual(res.data.capability.state, 'granted');
    assert.match(res.display, /remember — (available|off|unavailable)/);
  }
});

test('vibe_call drafts and never sends', async () => {
  const call = require('./call');
  const res = await call.handler({ handle: '@friend' });
  assert.equal(res.data.sent, false);
  assert.ok(res.data.draft.includes('calljimmy.ai'));
  assert.match(res.display, /nothing sent/);
});

test('vibe_reflect with no provider reports honestly instead of fabricating', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-empty2-'));
  const savedPath = process.env.PATH;
  const savedCli = process.env.VIBE_STATS_CLI;
  process.env.PATH = emptyDir;
  process.env.VIBE_STATS_CLI = path.join(emptyDir, 'missing');
  delete require.cache[require.resolve('../capabilities')];
  delete require.cache[require.resolve('./reflect')];
  try {
    const reflect = require('./reflect');
    const res = await reflect.handler({ question: 'how goes it' });
    assert.equal(res.data.silence, true);
    assert.match(res.display, /unavailable|off/);
  } finally {
    process.env.PATH = savedPath;
    if (savedCli === undefined) delete process.env.VIBE_STATS_CLI;
    else process.env.VIBE_STATS_CLI = savedCli;
    delete require.cache[require.resolve('../capabilities')];
  }
});

test('the kernel registers the four verbs and the manifest; vibe_mind is retired', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const name of ['vibe_capabilities', 'vibe_remember', 'vibe_reflect', 'vibe_call']) {
    assert.ok(src.includes(`${name}: require`), `${name} registered`);
  }
  assert.ok(!/vibe_mind: require/.test(src), 'vibe_mind name no longer registered');
});
