/**
 * One announcement per message.
 *
 * Lab 2026-11-20 (run-02 Maddy and Ines, run-03 Mira): a session opened with
 * "/vibe · 1 message waiting · from @oren: …" and, at the next prompt or tool
 * call of the same session, the arrival hook said "@oren wrote you: …" for the
 * same message. A message that lands in the minute before a session opens is
 * both "waiting" (the session-start hook reads the inbox) and, within the
 * server's clock slack, an "arrival" (presence.js on its first look).
 *
 * The session-start line owns a message it has shown: it takes the same
 * one-per-machine claim the arrival presenters use, so the server never spools
 * it and the arrival hook stays quiet for that id. A message that arrives
 * after the session opened is still announced, once.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;

function homeFor(handle, knownHandles = []) {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-once-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(knownHandles.map((h) => [h, 1])) }));
  return vh;
}
function sitDown(vh, apiUrl, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve({ out: JSON.parse(out), raw: out }); });
  });
}
function arrivalHook(vh, event) {
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1' }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: path.join(vh, 'arrivals') }, encoding: 'utf8',
  });
  return JSON.parse(out.stdout);
}
const startStub = async (people) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people });
/** The thread rows the server's poll reads (store.getInbox shape), straight from the stub. */
async function inboxRows(stub, me) {
  const r = await fetch(`${stub.url}/api/v2/threads`, { headers: { Authorization: `Bearer ${jwt(me)}` } }).then((x) => x.json());
  return r.threads.map((t) => ({ handle: t.with, unread: t.unread, lastMessage: t.last_message.body, lastMessageId: t.last_message.id,
    lastFrom: t.last_message.from, lastActorKind: 'human', muted: false, lastTimestamp: Date.parse(t.last_message.created_at) }));
}

test('shown at session start, then not announced again by the arrival hook in that session', async () => {
  const stub = await startStub({ oren: {}, maddy: {} });
  try {
    // Sent seconds before the session opened: inside the server's arrival slack.
    const m = stub.post('oren', 'maddy', '7 min, cut Nov 12. Spec is stale.');
    const vh = homeFor('maddy', ['oren']);
    const env = { VIBE_HOME: vh };
    const start = await sitDown(vh, stub.url);
    assert.match(start.out.systemMessage, /Note from @oren \((just now|\d+m ago)\): 7 min, cut Nov 12\. Spec is stale\./);

    // The server's first look: the message is newer than the process (slack), so
    // it would be an arrival. It is already the session-start line's.
    const arrival = require('../arrival');
    const rows = await inboxRows(stub, 'maddy');
    assert.equal(arrival.pickArrivals(rows, 'maddy', { since: Date.now() }).length, 1, 'the slack really does make it an arrival candidate');
    assert.equal(arrival.isClaimed(m.id, env), true, 'the session-start line claimed what it showed');
    assert.deepEqual(arrival.record(rows, 'maddy', { since: Date.now(), env }), [], 'so the server does not spool it');
    assert.deepEqual(arrivalHook(vh, 'UserPromptSubmit'), { suppressOutput: true }, 'and the next prompt says nothing more');
    assert.deepEqual(arrivalHook(vh, 'PostToolUse'), { suppressOutput: true }, 'nor does the next tool call');
    assert.ok(!stub.effects.some((e) => e.effect === 'READ_CURSOR'), 'claiming is local: nothing was marked read');
  } finally { await stub.close(); }
});

test('a message that comes after the session opened is still announced, once', async () => {
  const stub = await startStub({ oren: {}, maddy: {} });
  try {
    stub.post('oren', 'maddy', 'first: the spec is stale');
    const vh = homeFor('maddy', ['oren']);
    const env = { VIBE_HOME: vh };
    await sitDown(vh, stub.url);

    const later = stub.post('oren', 'maddy', 'second: cut moved to Nov 14');
    const arrival = require('../arrival');
    const spooled = arrival.record(await inboxRows(stub, 'maddy'), 'maddy', { since: Date.now() - 60_000, env });
    assert.deepEqual(spooled.map((r) => r.id), [later.id]);
    const shown = arrivalHook(vh, 'UserPromptSubmit');
    assert.match(shown.systemMessage, /^\/vibe · Note from @oren \((just now|\d+m ago)\), waiting at your pause: second: cut moved to Nov 14$/);
    assert.deepEqual(arrivalHook(vh, 'PostToolUse'), { suppressOutput: true }, 'once');
  } finally { await stub.close(); }
});

test('a session start that shows nothing claims nothing', async () => {
  const stub = await startStub({ oren: {}, maddy: {} });
  try {
    const m = stub.post('oren', 'maddy', 'from someone maddy has never written to');
    const vh = homeFor('maddy', []); // oren is not known: counted, never shown
    const start = await sitDown(vh, stub.url);
    assert.ok(!start.raw.includes('from someone'), 'their words are not shown');
    assert.equal(require('../arrival').isClaimed(m.id, { VIBE_HOME: vh }), false, 'what was not shown is not claimed');
  } finally { await stub.close(); }
});
