'use strict';
// The installer's last screen (notice.js setupReceipt; BRIEF-20, minute 1-2).
// A newcomer usually runs setup beside a Claude Code session that is already
// open, goes back to it, finds no /vibe there and concludes nothing happened;
// and a friend's question already waiting for them was never mentioned. The
// last lines are now, in order: notes waiting (only when one bounded read
// right after sign-in found some; handles only, for people this machine
// knows), "Open a fresh Claude Code session ...", and who invited them.
//
// setup() itself is never run here (it signs in to production). The text is
// built by pure functions (waitingLine, finalLines) and the read is
// readWaiting, tested against a loopback server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-receipt-'));
process.env.HOME = SCRATCH;
process.env.VIBE_HOME = path.join(SCRATCH, '.vibe');
process.env.VIBE_SETUP_NO_AUTORUN = '1';
fs.mkdirSync(process.env.VIBE_HOME, { recursive: true });

const ROOT = path.join(__dirname, '..');
const setup = require('../setup.js');
const FRESH = 'Open a fresh Claude Code session to load /vibe. Sessions that are already open will not see it.';

test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

test('the waiting line: how many notes, from whom, handles only', () => {
  const w = setup.waitingLine;
  assert.equal(w(null), null, 'the read failed: nothing about notes');
  assert.equal(w({ total: 0, named: [], others: 0 }), null, 'none: nothing, never "no notes"');
  assert.equal(w({ total: 1, named: ['ben'], others: 0 }), '1 note waiting from @ben.');
  assert.equal(w({ total: 3, named: ['ben'], others: 0 }), '3 notes waiting from @ben.');
  assert.equal(w({ total: 2, named: ['ben', 'maya'], others: 0 }), '2 notes waiting, from @ben and @maya.');
  assert.equal(w({ total: 3, named: ['ben', 'maya', 'kenji'], others: 0 }), '3 notes waiting, from @ben, @maya and 1 other.');
  assert.equal(w({ total: 3, named: ['ben', 'maya'], others: 1 }), '3 notes waiting, from @ben, @maya and 1 other.');
  assert.equal(w({ total: 5, named: ['ben', 'maya'], others: 3 }), '5 notes waiting, from @ben, @maya and 3 others.');
  assert.equal(w({ total: 2, named: ['ben'], others: 1 }), '2 notes waiting, from @ben and 1 other.');
  assert.equal(w({ total: 1, named: [], others: 1 }), '1 note waiting, from someone you have not written to.');
  assert.equal(w({ total: 4, named: [], others: 3 }), '4 notes waiting, from 3 people you have not written to.');
  assert.equal(w({ total: 1, named: ['Not A Handle!'], others: 0 }), '1 note waiting, from someone you have not written to.', 'nothing that is not a handle is printed');
});

test('the last screen, exactly: no notes, one note, read failed, invited', () => {
  const text = (o) => setup.finalLines(o).map((l) => l.text);
  assert.deepEqual(text({ waiting: { total: 0, named: [], others: 0 } }), [FRESH], 'no notes');
  assert.deepEqual(text({ waiting: { total: 1, named: ['ben'], others: 0 } }), ['1 note waiting from @ben.', FRESH], 'one note');
  assert.deepEqual(text({ waiting: null }), [FRESH], 'read failed or timed out');
  const invited = [
    '@ben invited you, so what they write reaches you while you work.',
    'Nothing was sent and no line was opened. Undo: npx slashvibe-mcp mute @ben',
  ];
  assert.deepEqual(text({ waiting: { total: 1, named: ['ben'], others: 0 }, inviteLines: invited }), ['1 note waiting from @ben.', FRESH, ...invited], 'invited, with a note from the inviter');
  assert.deepEqual(text({ waiting: null, inviteLines: invited }), [FRESH, ...invited], 'invited, read failed');
  assert.equal(setup.FRESH_SESSION, FRESH);
  for (const o of [{}, { waiting: { total: 2, named: ['ben', 'maya'], others: 0 }, inviteLines: invited }]) {
    for (const l of setup.finalLines(o)) assert.ok(!l.text.includes('!'), `no exclamation marks: ${l.text}`);
  }
});

test('setup prints the last screen last, after the line to pass on, and only through the switch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
  const body = src.slice(src.indexOf('async function setup()'));
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('invite.accept(') < at('readWaiting({'), 'the inviter is marked before the inbox is read, so a note from them is named');
  assert.ok(at('invite.line(') < at('finalLines({'), 'the last lines come after the line to pass on');
  assert.equal((body.match(/readWaiting\(/g) || []).length, 1, 'one read');
  assert.match(body, /require\('\.\/notice'\)\.on\('setupReceipt'\)/);
  // What the receipt prints in place of the old ending: no exclamation mark, no welcome.
  const on = body.slice(at("console.log(receipt"), at(": `${colors.green}  ✓ Setup complete!"));
  assert.ok(!on.includes('!'), on);
  assert.match(body, /if \(!receipt\) \{\n\s+console\.log\(`\$\{colors\.cyan\}  Welcome to \/vibe/, 'the welcome is only on the switched-off path');
});

// ── the read ────────────────────────────────────────────────────────────────

function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); handler(req, res); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const json = (body, status = 200) => (req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const thread = (from, over = {}) => ({ id: `t_${from}`, with: from, unread: 1, last_message: { id: `m_${from}`, from, body: 'did you rename search_docs to query_corpus?', created_at: new Date().toISOString(), actor: { kind: 'human' } }, ...over });

function home(reach = { quiet: false, muted: {}, known: {} }) {
  const vh = fs.mkdtempSync(path.join(SCRATCH, 'vh-'));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify(reach));
  return { VIBE_HOME: vh };
}

test('one read with the new token: notes from people, named only when known here', async () => {
  const { server, seen, url } = await serve(json({ threads: [
    thread('ben', { unread: 2 }),
    thread('maya'),
    thread('stranger_x'),
    thread('maya_agent', { last_message: { id: 'm_a', from: 'maya_agent', body: 'hi', actor: { kind: 'agent' } } }),
    thread('muted_m'),
    thread('ada', { last_message: { id: 'm_mine', from: 'ada', body: 'my own reply' } }),
    thread('read_r', { unread: 0 }),
    thread('door_d', { last_message: { id: 'm_d', from: 'door_d', body: require('../door').card('door_d', 'https://example.com/thing', 'the thing') } }),
  ], total_unread: 9 }));
  try {
    const env = home({ quiet: false, muted: { muted_m: 1 }, known: { ben: 1, maya: 1 } });
    const w = await setup.readWaiting({ apiUrl: url, token: 'tok123', handle: 'ada', env });
    assert.equal(seen.length, 1, 'exactly one request');
    assert.equal(seen[0].url, '/api/messages?user=ada');
    assert.equal(seen[0].auth, 'Bearer tok123');
    assert.equal(w.named.join(','), 'ben,maya');
    assert.equal(w.others >= 1, true, 'the stranger is counted, not named');
    assert.ok(!w.named.includes('stranger_x') && !w.named.includes('maya_agent') && !w.named.includes('muted_m') && !w.named.includes('ada'));
    const line = setup.waitingLine(w);
    assert.ok(!line.includes('stranger_x') && !line.includes('rename'), 'no stranger handle, no message text');
    assert.equal(line, "4 notes waiting, from @ben, @maya and 1 other.");
  } finally { server.close(); }
});

test('the inviter marked by --from is named', async () => {
  const { server, url } = await serve(json({ threads: [thread('ben')] }));
  try {
    const env = home();
    assert.equal(setup.waitingLine(await setup.readWaiting({ apiUrl: url, token: 't', handle: 'maya', env })), '1 note waiting, from someone you have not written to.');
    require('../reach').know('ben', env);
    assert.equal(setup.waitingLine(await setup.readWaiting({ apiUrl: url, token: 't', handle: 'maya', env })), '1 note waiting from @ben.');
  } finally { server.close(); }
});

test('nothing is said about notes when the read fails, is refused, is malformed, finds none, or does not answer in time', async () => {
  const env = home({ quiet: false, muted: {}, known: { ben: 1 } });
  for (const [name, handler] of [
    ['server error', json({ error: 'boom' }, 500)],
    ['refused', json({ success: false, error: 'unauthorized' }, 200)],
    ['malformed', json({ nope: true })],
    ['not json', (req, res) => { res.writeHead(200); res.end('<html>'); }],
  ]) {
    const { server, seen, url } = await serve(handler);
    try {
      assert.equal(await setup.readWaiting({ apiUrl: url, token: 't', handle: 'ada', env }), null, name);
      assert.equal(seen.length, 1, `${name}: no retry`);
    } finally { server.close(); }
  }
  const empty = await serve(json({ threads: [] }));
  try {
    assert.equal(setup.waitingLine(await setup.readWaiting({ apiUrl: empty.url, token: 't', handle: 'ada', env })), null, 'none waiting');
  } finally { empty.server.close(); }
  // A server that never answers: bounded, one request.
  const hung = await serve(() => {});
  try {
    const t0 = Date.now();
    assert.equal(await setup.readWaiting({ apiUrl: hung.url, token: 't', handle: 'ada', env, timeoutMs: 300 }), null);
    assert.ok(Date.now() - t0 < 2000, 'bounded');
    assert.equal(hung.seen.length, 1);
  } finally { hung.server.closeAllConnections?.(); hung.server.close(); }
  // Nowhere to ask: nothing.
  assert.equal(await setup.readWaiting({ apiUrl: 'http://127.0.0.1:9', token: 't', handle: 'ada', env, timeoutMs: 500 }), null);
  assert.equal(setup.readWaiting.length, 0);
});

test('quiet, no token or a handle that is not a handle: no request at all', async () => {
  const { server, seen, url } = await serve(json({ threads: [thread('ben')] }));
  try {
    assert.equal(await setup.readWaiting({ apiUrl: url, token: 't', handle: 'ada', env: home({ quiet: true, muted: {}, known: { ben: 1 } }) }), null);
    assert.equal(await setup.readWaiting({ apiUrl: url, token: '', handle: 'ada', env: home() }), null);
    assert.equal(await setup.readWaiting({ apiUrl: url, token: 't', handle: '../x', env: home() }), null);
    assert.equal(seen.length, 0);
  } finally { server.close(); }
});
