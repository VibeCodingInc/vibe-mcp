/**
 * New, or still waiting.
 *
 * Lab 2026-11-21: judges reported that a message the person had already seen
 * was listed as "waiting" again in the next day's session. Measured before this
 * change (0.9.21):
 *   - seen at session start, unanswered: the next session said exactly the
 *     same "1 message waiting · from @mira: …" as the first;
 *   - announced mid-session by the arrival hook, unanswered: the next session
 *     said "1 message waiting" as if it were new;
 *   - seen and then answered: not listed (0.9.19 holds).
 * Seen but unanswered IS still waiting, so it is still listed. What changed is
 * the wording: it says "still waiting since <when>", never as if new. Seen is
 * the local one-per-machine `.shown` claim; nothing is marked read.
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
const { sinceWhen, waitingCount } = require('../session-start-hook.cjs');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;

function homeFor(handle, knownHandles = []) {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-still-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(knownHandles.map((h) => [h, 1])) }));
  return vh;
}
let sessions = 0;
function sitDown(vh, apiUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: `still${++sessions}` }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve({ out: JSON.parse(out), raw: out }); });
  });
}
const waiting = (out) => String(out.systemMessage || '').split('\n').filter((l) => /waiting/.test(l)).join('\n');
const startStub = async (people) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people });

test('seen at one session start, unanswered: the next session lists it as still waiting, not as new', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    const m = stub.post('mira', 'oren', 'does scheduled_at come back as UTC?');
    m.created_at = new Date(Date.now() - 26 * 3600e3).toISOString();
    const vh = homeFor('oren', ['mira']);
    const first = await sitDown(vh, stub.url);
    assert.equal(waiting(first.out), '/vibe · 1 message waiting · from @mira: “does scheduled_at come back as UTC?”', 'first time: plain waiting');
    const next = await sitDown(vh, stub.url);
    const when = sinceWhen(Date.parse(m.created_at));
    assert.equal(waiting(next.out), `/vibe · 1 message still waiting since ${when} · from @mira: “does scheduled_at come back as UTC?”`);
    assert.match(next.out.hookSpecificOutput.additionalContext, /@mira's message was already shown to the person before this session and is still unanswered \(written [^)]+\)\. Present it as still waiting, not as new\./);
    assert.ok(!stub.effects.some((e) => e.effect === 'READ_CURSOR'), 'nothing was marked read');
  } finally { await stub.close(); }
});

test('announced mid-session by the arrival hook, unanswered: the next session says still waiting', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    const vh = homeFor('oren', ['mira']);
    await sitDown(vh, stub.url); // nothing yet
    stub.post('mira', 'oren', 'second question: page size?');
    const r = await fetch(`${stub.url}/api/v2/threads`, { headers: { Authorization: `Bearer ${jwt('oren')}` } }).then((x) => x.json());
    const rows = r.threads.map((t) => ({ handle: t.with, unread: t.unread, lastMessage: t.last_message.body, lastMessageId: t.last_message.id,
      lastFrom: t.last_message.from, lastActorKind: 'human', muted: false, lastTimestamp: Date.parse(t.last_message.created_at) }));
    require('../arrival').record(rows, 'oren', { since: Date.now() - 60_000, env: { VIBE_HOME: vh } });
    const hook = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
      env: { ...process.env, VIBE_ARRIVALS_DIR: path.join(vh, 'arrivals'), VIBE_TURNS_DIR: path.join(vh, 'turns') }, encoding: 'utf8',
    });
    assert.match(JSON.parse(hook.stdout).systemMessage, /^\/vibe · @mira wrote you: "second question: page size\?"$/);
    const next = await sitDown(vh, stub.url);
    assert.equal(waiting(next.out), '/vibe · 1 message still waiting since earlier today · from @mira: “second question: page size?”');
  } finally { await stub.close(); }
});

test('seen and then answered: not listed in the next session', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    stub.post('mira', 'oren', 'is site_tz an IANA name?');
    const vh = homeFor('oren', ['mira']);
    assert.match(waiting((await sitDown(vh, stub.url)).out), /1 message waiting · from @mira/);
    stub.post('oren', 'mira', 'it is, under site.tz.');
    const next = await sitDown(vh, stub.url);
    assert.equal(waiting(next.out), '');
    assert.ok(!next.raw.includes('site_tz'));
  } finally { await stub.close(); }
});

test('a new message beside one still waiting: the count says how many are new', async () => {
  const stub = await startStub({ oren: {}, mira: {}, ada: {} });
  try {
    stub.post('mira', 'oren', 'first question');
    const vh = homeFor('oren', ['mira', 'ada']);
    await sitDown(vh, stub.url);
    stub.post('ada', 'oren', 'are you on the release today?');
    const next = await sitDown(vh, stub.url);
    assert.match(waiting(next.out), /^\/vibe · 2 messages waiting, 1 new · latest from @/);
  } finally { await stub.close(); }
});

test('sinceWhen and waitingCount', () => {
  const now = new Date(2026, 10, 21, 15, 0).getTime();
  assert.equal(sinceWhen(new Date(2026, 10, 21, 9, 0).getTime(), now), 'earlier today');
  assert.equal(sinceWhen(new Date(2026, 10, 20, 23, 0).getTime(), now), 'yesterday');
  assert.equal(sinceWhen(new Date(2026, 10, 18, 12, 0).getTime(), now), 'Wednesday');
  assert.equal(sinceWhen(new Date(2026, 10, 12, 12, 0).getTime(), now), 'Nov 12');
  const y = new Date(2026, 10, 20, 9, 0).getTime();
  assert.equal(waitingCount([{ seen: false }], now), '1 message waiting');
  assert.equal(waitingCount([{ seen: true, at: y }], now), '1 message still waiting since yesterday');
  assert.equal(waitingCount([{ seen: true, at: null }], now), '1 message still waiting');
  assert.equal(waitingCount([{ seen: false }, { seen: false }], now), '2 messages waiting');
  assert.equal(waitingCount([{ seen: true }, { seen: false }], now), '2 messages waiting, 1 new');
  assert.equal(waitingCount([{ seen: true }, { seen: true }], now), '2 messages still waiting, none new');
});
