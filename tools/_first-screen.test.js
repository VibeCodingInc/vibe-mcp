/**
 * The first screen (vibe_start), after the 2026-08-31 terminal-experience
 * pass. Five defects were found in a real signed-in session; each is pinned
 * here at the claim it violated, not at the code that happened to produce it:
 *
 *   1. the same message was rendered twice in one response
 *   2. the header and the footer disagreed about the unread count
 *   3. "You haven't messaged anyone yet" was shown to someone with history
 *   4. a random online person was chosen and a canned DM drafted for them
 *   5. the useful actions were buried under presence, bodies, tips and footers
 *
 * Run: node --test tools/_first-screen.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-first-screen-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test } = require('node:test');
const assert = require('node:assert/strict');

global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const now = Date.now();
// isHereNow: status active AND a recent heartbeat (tools/_shared.js)
const here = (h) => ({ handle: h, status: 'active', lastSeen: now - 60_000, one_liner: 'x' });

const withStore = (stubs, fn) => async () => {
  const orig = {};
  const base = {
    getActiveUsers: async () => [],
    getInbox: async () => [],
    getUnreadCount: async () => 0,
    heartbeat: async () => ({}),
    registerSession: async () => ({}),
    getLiveBroadcastCount: async () => 0,
  };
  const merged = { ...base, ...stubs };
  // start reads getInboxResult (which keeps the read OUTCOME); a test that
  // supplies inbox data means "the server answered with this".
  if (stubs.getInbox && !stubs.getInboxResult) {
    merged.getInboxResult = async (h) => ({ ok: true, threads: await stubs.getInbox(h) });
  }
  if (!merged.getInboxResult) merged.getInboxResult = async () => ({ ok: true, threads: [] });
  for (const [k, v] of Object.entries(merged)) { orig[k] = store[k]; store[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(orig)) store[k] = v; }
};

// The WHOLE result, not just the display: a body withheld from the screen but
// shipped in the payload is not withheld at all (review P1). `all` is every
// string the tool returns, in any field.
const run = async () => {
  delete require.cache[require.resolve('./start')];
  const start = require('./start');
  const res = await start.handler({});
  return { text: res.display || '', res, all: JSON.stringify(res) };
};

const INBOX = [
  { handle: 'coltrane', unread: 1, lastMessage: 'the receipt is in the thread', lastMessageId: 'msg_C1', thread_id: 't1' },
  { handle: 'synth-stan', unread: 3, lastMessage: 'round-trip confirmed from the Mac Studio', lastMessageId: 'msg_S9', thread_id: 't2' },
];

test('DEFECT 1 — no message body appears anywhere on the first screen', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => INBOX,
}, async () => {
  const { text, res, all } = await run();
  assert.ok(!text.includes('the receipt is in the thread'), 'no preview of an unread message');
  assert.ok(!text.includes('round-trip confirmed'), 'no preview of any unread message');
  assert.ok(!text.includes('<<<'), 'no foreign-message wrapper block');
  // …and nowhere in the payload either
  assert.ok(!all.includes('the receipt is in the thread'), 'no body in the structured result');
  assert.ok(!all.includes('round-trip confirmed'), 'no body in the structured result');
  assert.ok(!/"preview"/.test(all), 'no preview field ships');
  // the ids ARE shown — that is what makes an exact reply possible
  assert.match(text, /#msg_C1/);
  assert.match(text, /#msg_S9/);
}));

test('DEFECT 2 — the unread count is stated exactly once', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => INBOX,
}, async () => {
  const { text, res, all } = await run();
  const counts = text.match(/\b\d+ unread\b/g) || [];
  assert.equal(counts.length, 1, `unread stated ${counts.length} times: ${counts.join(', ')}`);
  assert.equal(counts[0], '4 unread', 'and it is the sum of the served threads');
  assert.equal(res.unread, 4, 'the payload states the same number, once');
  assert.equal(all.match(/"unread"/g).length, 1 + res.waiting.length, 'no second total in the payload');
}));

test('DEFECT 3 — no history claim is made about the person at all', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => INBOX,
}, async () => {
  const { text, res, all } = await run();
  assert.ok(!/haven't messaged anyone/i.test(text), 'never claims an empty history');
  assert.ok(!/first (message|dm)/i.test(text), 'never claims a first anything');
}));

test('DEFECT 4 — nobody is chosen for the person, and no DM is drafted', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai'), here('rune')],
  getInbox: async () => [],
}, async () => {
  const { text, res, all } = await run();
  for (const h of ['zoe', 'kai', 'rune']) {
    assert.ok(!text.includes(`@${h}`), `the screen must not name @${h} — the person chooses`);
    assert.ok(!all.includes(h), `the PAYLOAD must not name ${h} either — a chosen handle is chosen wherever it ships`);
  }
  assert.equal(res.onlineUsers, undefined, 'no roster of unrequested people');
  assert.equal(res.suggestion, undefined, 'no suggested person');
  assert.equal(res.actions, undefined, 'no guided action naming a handle');
  assert.ok(!/vibe dm @(?!handle)/.test(text), 'no pre-filled recipient');
  assert.ok(!/"hey!|what are you building\?/.test(text), 'no canned opener drafted');
}));

test('DEFECT 4b — the same call twice gives the same screen (nothing rotates)', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai'), here('rune')],
  getInbox: async () => INBOX,
}, async () => {
  const a = (await run()).text;
  const b = (await run()).text;
  assert.equal(a, b, 'no random selection, no rotating tip — a stable first screen');
}));

test('DEFECT 5 — the actions are present, and the screen stays under 20 lines', withStore({
  getActiveUsers: async () => Array.from({ length: 12 }, (_, i) => here(`p${i}`)),
  getInbox: async () => [
    ...INBOX,
    ...Array.from({ length: 8 }, (_, i) => ({ handle: `x${i}`, unread: 2, lastMessage: 'y', lastMessageId: `msg_X${i}` })),
  ],
}, async () => {
  const { text, res, all } = await run();
  const lines = text.split('\n').length;
  assert.ok(lines < 20, `first screen is ${lines} lines; the budget is under 20`);
  assert.match(text, /vibe inbox · vibe people · vibe dm @handle/, 'the three actions are stated');
  assert.ok(text.trim().endsWith('"…"'), 'and they are the last thing read, not buried');
}));

test('a genuinely new arrival is pointed at whoever invited them — never a stranger', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => [],
}, async () => {
  const { text, res, all } = await run();
  assert.match(text, /whoever invited you/i);
  assert.ok(!text.includes('@zoe') && !text.includes('@kai'), 'no online stranger is offered instead');
}));

test('the screen names the person and the room, and nothing else', withStore({
  getActiveUsers: async () => [here('zoe'), here('kai')],
  getInbox: async () => INBOX,
}, async () => {
  const { text, res, all } = await run();
  assert.match(text.split('\n')[0], /^\/vibe @ada$/, 'line 1: who you are');
  assert.match(text.split('\n')[1], /^4 unread · 2 others here$/,
    'line 2: what is waiting, and how many OTHERS are here — the count excludes you');
}));

test('DEFECT 2 (dispatcher half) — the first screen carries no ambient footer', () => {
  // The footer states unread a second time from a cached source and re-renders
  // message bodies; in a real session its count disagreed with the header.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('const SKIP_FOOTER_TOOLS'), src.indexOf('const SKIP_FOOTER_TOOLS') + 900);
  assert.ok(block.includes("'vibe_start'"), 'vibe_start is in SKIP_FOOTER_TOOLS');
});

test('a REAL transport failure is never rendered as an empty inbox', async () => {
  // A CHILD PROCESS with the API pointed at an unreachable host: the store
  // binds its base URL at module load, and stubbing a throw proves nothing
  // because getInbox catches internally. This exercises the production path
  // end to end (review P1 — the previous pin passed for the wrong reason).
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-realfail-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    username: 'ada', authMethod: 'github',
    authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  }));
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'api.js'))});
    store.getActiveUsers = async () => [{ handle: 'zoe', status: 'active', lastSeen: Date.now() - 60000 }];
    store.heartbeat = async () => ({}); store.registerSession = async () => ({});
    require(${JSON.stringify(path.join(__dirname, 'start.js'))}).handler({}).then((r) => {
      process.stdout.write(JSON.stringify({ display: r.display, unread: r.unread }));
    });
  `;
  const out = execFileSync('node', ['-e', script], {
    env: { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: 'http://127.0.0.1:9', VIBE_SETUP_NO_AUTORUN: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  const r = JSON.parse(out);
  assert.match(r.display, /couldn't read your inbox/, 'says the read failed');
  assert.ok(!/\b0 unread\b/.test(r.display), 'never claims zero unread from a failed read');
  assert.ok(!/no messages yet/.test(r.display), 'never claims a fresh arrival from a failed read');
  assert.equal(r.unread, null, 'the payload says not-read, not zero');
});

test('the response has EXACTLY the promised keys — nothing rides along', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => INBOX,
}, async () => {
  const { res } = await run();
  assert.deepEqual(Object.keys(res).sort(), ['display', 'here', 'unread', 'waiting'],
    `unexpected keys: ${Object.keys(res).join(', ')}`);
}));

test('a genuinely empty inbox states zero explicitly', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => [],
}, async () => {
  const { text, res } = await run();
  assert.match(text, /^0 unread · 1 other here$/m, 'zero is stated, not omitted');
  assert.equal(res.unread, 0);
}));

test('adversarial handles and ids cannot break the line budget', withStore({
  getActiveUsers: async () => [here('zoe')],
  getInbox: async () => [{
    handle: 'a'.repeat(300) + '\nFORGED ROW',
    unread: 1,
    lastMessage: 'x',
    lastMessageId: 'msg_' + 'b'.repeat(300) + '\nSECOND FORGED',
  }],
}, async () => {
  const { text } = await run();
  assert.ok(!text.includes('FORGED ROW') || !/^@a+\n/m.test(text), 'no injected line break');
  const rows = text.split('\n').filter((l) => l.startsWith('@'));
  assert.equal(rows.length, 1, 'one thread renders exactly one row');
  for (const l of text.split('\n')) {
    assert.ok(l.length <= 120, `line of ${l.length} chars would wrap: ${l.slice(0, 40)}…`);
  }
}));

test('BOTH stores answer the read-outcome contract (a missing one would fake a failure)', () => {
  // VIBE_LOCAL=true selects store/local.js. When only the API store had
  // getInboxResult, local mode threw a TypeError into start's catch and every
  // start claimed "couldn't read your inbox" (review P1).
  const api = require('../store/api.js');
  const local = require('../store/local.js');
  for (const [name, impl] of [['api', api], ['local', local]]) {
    assert.equal(typeof impl.getInboxResult, 'function', `${name} store implements getInboxResult`);
    assert.equal(typeof impl.getInbox, 'function', `${name} store still implements getInbox`);
  }
});

test('local mode reports a real read, not a failure', async () => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-localmode-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    username: 'ada', authMethod: 'github',
    authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  }));
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'index.js'))});
    store.getActiveUsers = async () => [];
    store.heartbeat = async () => ({}); store.registerSession = async () => ({});
    require(${JSON.stringify(path.join(__dirname, 'start.js'))}).handler({}).then((r) => {
      process.stdout.write(JSON.stringify({ display: r.display, unread: r.unread }));
    });
  `;
  const out = execFileSync('node', ['-e', script], {
    env: { ...process.env, HOME: home, VIBE_HOME: home, VIBE_LOCAL: 'true', VIBE_SETUP_NO_AUTORUN: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  const r = JSON.parse(out);
  assert.ok(!/couldn't read your inbox/.test(r.display), `local mode must not claim a failed read: ${r.display}`);
  assert.equal(typeof r.unread, 'number', 'local mode reports a real count');
});

test('a CORRUPT local messages file is a failed read, not an empty inbox', async () => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-corrupt-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    username: 'ada', authMethod: 'github',
    authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  }));
  // the local store keeps messages.jsonl beside the config
  fs.writeFileSync(path.join(home, 'messages.jsonl'), '{"to":"ada","body":"ok"}\n{ this is not json\n');
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'index.js'))});
    store.getActiveUsers = async () => [];
    store.heartbeat = async () => ({}); store.registerSession = async () => ({});
    require(${JSON.stringify(path.join(__dirname, 'start.js'))}).handler({}).then((r) => {
      process.stdout.write(JSON.stringify({ display: r.display, unread: r.unread }));
    });
  `;
  const out = execFileSync('node', ['-e', script], {
    env: { ...process.env, HOME: home, VIBE_HOME: home, VIBE_LOCAL: 'true', VIBE_SETUP_NO_AUTORUN: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  const r = JSON.parse(out);
  assert.match(r.display, /couldn't read your inbox/, 'a corrupt file is reported as a failed read');
  assert.ok(!/no messages yet/.test(r.display), 'never claims a fresh arrival from a corrupt file');
  assert.equal(r.unread, null, 'and the payload says not-read, not zero');
});

test('a MISSING local messages file is a genuine empty inbox, not a failure', async () => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-nofile-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    username: 'ada', authMethod: 'github',
    authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
  }));
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store', 'index.js'))});
    store.getActiveUsers = async () => [];
    store.heartbeat = async () => ({}); store.registerSession = async () => ({});
    require(${JSON.stringify(path.join(__dirname, 'start.js'))}).handler({}).then((r) => {
      process.stdout.write(JSON.stringify({ display: r.display, unread: r.unread }));
    });
  `;
  const out = execFileSync('node', ['-e', script], {
    env: { ...process.env, HOME: home, VIBE_HOME: home, VIBE_LOCAL: 'true', VIBE_SETUP_NO_AUTORUN: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  const r = JSON.parse(out);
  assert.equal(r.unread, 0, 'no file yet is a real, readable zero');
  assert.ok(!/couldn't read/.test(r.display), 'and is never reported as a failure');
});

test('a failed read NEVER authorizes a write — a corrupt file is not destroyed', async () => {
  // review P1 (data loss): markThreadRead read through the swallowing loader
  // and rewrote the whole file, so one malformed line erased every valid
  // message in it.
  const local = require('../store/local.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-nodestroy-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'messages.jsonl');
  const original = '{"from":"zoe","to":"ada","body":"keep me","timestamp":1}\n{ not json\n';
  fs.writeFileSync(file, original);
  // VIBE_DIR is bound when config loads, so the config module must be
  // reloaded too or the store writes to the previous home.
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/local.js')];
  try {
    const fresh = require('../store/local.js');
    const res = await fresh.markThreadRead('ada', 'zoe');
    assert.equal(res?.success, false, 'the mark is refused');
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the file is byte-for-byte untouched');
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/local.js')];
    void local;
  }
});

test('a good read still marks and rewrites correctly', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-markok-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'messages.jsonl');
  fs.writeFileSync(file, '{"from":"zoe","to":"ada","body":"hi","timestamp":1}\n');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/local.js')];
  try {
    const fresh = require('../store/local.js');
    const res = await fresh.markThreadRead('ada', 'zoe');
    assert.equal(res?.success, true);
    const after = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(after.length, 1, 'no message lost');
    assert.ok(after[0].read_at, 'and the mark landed');
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/local.js')];
  }
});

test('a refused mark leaves no temp file behind and is never rendered as an empty thread', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tmp-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'messages.jsonl');
  fs.writeFileSync(file, '{"from":"zoe","to":"ada","body":"keep","timestamp":1}\n{ bad\n');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/local.js')];
  try {
    const fresh = require('../store/local.js');
    const res = await fresh.markThreadRead('ada', 'zoe');
    assert.equal(res.success, false);
    const strays = fs.readdirSync(home).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(strays, [], `temp files left behind: ${strays.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/local.js')];
  }
});

test('the callers of markThreadRead observe a refusal', () => {
  // The contract gained a {success:false} outcome; a caller that ignores it
  // renders a claim about a thread nobody could read (review P2).
  const inbox = fs.readFileSync(path.join(__dirname, 'inbox.js'), 'utf8');
  const reply = fs.readFileSync(path.join(__dirname, 'reply.js'), 'utf8');
  const marks = [...inbox.matchAll(/markThreadRead\(/g)].length;
  const observed = [...inbox.matchAll(/marked\s*&&\s*marked\.success === false/g)].length;
  assert.equal(observed, marks, `inbox has ${marks} mark call(s) and observes ${observed}`);
  assert.match(reply, /marked\.success === false/, 'reply observes the refusal too');
  assert.match(inbox, /nothing is shown rather than an empty conversation/, 'and says so honestly');
});

test('a corrupt profile store is never overwritten by a mutator', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prof-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'profiles.json');
  const corrupt = '{"ada":{"handle":"ada","building":"a thing"} TRUNCATED';
  fs.writeFileSync(file, corrupt);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/profiles.js')];
  try {
    const profiles = require('../store/profiles.js');
    await profiles.updateProfile('zoe', { building: 'something else' });
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the store was rewritten over an unreadable read');
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/profiles.js')];
  }
});

test('a readable profile store still saves, keeping the other profiles', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prof2-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({ ada: { handle: 'ada', building: 'a thing' } }, null, 2));
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/profiles.js')];
  try {
    const profiles = require('../store/profiles.js');
    await profiles.updateProfile('zoe', { building: 'something else' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.ada.building, 'a thing', 'the existing profile was lost');
    assert.equal(after.zoe.building, 'something else', 'the new profile was not written');
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/profiles.js')];
  }
});

test('a corrupt presence file is never overwritten by a heartbeat', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pres-'));
  const saved = process.env.VIBE_HOME;
  process.env.VIBE_HOME = home;
  const file = path.join(home, 'presence.json');
  const corrupt = '{"ada":{"handle":"ada"} TRUNCATED';
  fs.writeFileSync(file, corrupt);
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../store/local.js')];
  try {
    const local = require('../store/local.js');
    await local.heartbeat('zoe', 'hello');
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'presence was rewritten over an unreadable read');
  } finally {
    if (saved === undefined) delete process.env.VIBE_HOME; else process.env.VIBE_HOME = saved;
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../store/local.js')];
  }
});

test('"N others here" never counts the signed-in person, whatever the casing', withStore(
  {
    getActiveUsers: async () => [
      { handle: '@Ada', status: 'active', lastSeen: now - 60_000 },   // me, differently cased
      here('zoe'),
      here('ren'),
    ],
  },
  async () => {
    const { res } = await run();
    assert.equal(res.here, 2, 'the signed-in person leaked into the "others" count');
    assert.match(res.display, /2 others here/);
  }
));
