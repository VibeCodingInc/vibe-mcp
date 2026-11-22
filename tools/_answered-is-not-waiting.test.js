/**
 * Answered is not waiting.
 *
 * Lab 2026-11-20, p01 in two runs: a person answered a message (once by an
 * approved draft, once by their agent over an open line), and the next session
 * still opened with "/vibe · 1 message waiting · from @mira: …". The new agent
 * said "I didn't reply" and offered to draft one, and in one run sent a second
 * answer to a question already answered.
 *
 * Replying does not mark anything read (seeing is not reading), and that stays.
 * The summary is what changed: a conversation whose newest message is the
 * person's own is answered, not waiting, whichever way the answer was sent. If
 * the other person writes again, it is waiting again. Looking writes nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const line = require('../line');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;

function homeFor(handle, knownHandles = []) {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-answered-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle, token: jwt(handle), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle }));
  fs.writeFileSync(path.join(vh, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: Object.fromEntries(knownHandles.map((h) => [h, 1])) }));
  return vh;
}
function sitDown(vh, apiUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', VIBE_NOTICE_OFF: 'arrivalHeader,emptyStates' /* these pin the waiting-count wording and a silent empty start; the new forms are tested in _voice.test.js */ },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve({ out: JSON.parse(out), raw: out }); });
  });
}
/** The waiting line alone: the stub also says who is here (everyone it knows). */
const waiting = (out) => String(out.systemMessage || '').split('\n').filter((l) => /waiting/.test(l)).join('\n');
const startStub = async (people) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people });

/** A send as the platform receives it from each path: same wire, its own origin. */
async function sendAs(stub, from, to, body, { origin = null, replyTo = null } = {}) {
  const r = await fetch(`${stub.url}/api/v2/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt(from)}` },
    body: JSON.stringify({ to, body, ...(origin ? { origin } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  return (await r.json()).id;
}

const ANSWERS = {
  'an approved draft': async (stub, q) => sendAs(stub, 'oren', 'mira', 'UTC with a Z, and a stale cursor is 409.', { origin: 'context_move', replyTo: q }),
  'their agent over an open line (vibe_answer)': async (stub, q) => sendAs(stub, 'oren', 'mira', 'UTC with a Z, and a stale cursor is 409.' + line.ANSWERED('oren'), { origin: 'agent_line', replyTo: q }),
  'the terminal': async (stub) => sendAs(stub, 'oren', 'mira', 'UTC, Z, 409.'),
};

for (const [how, answer] of Object.entries(ANSWERS)) {
  test(`answered by ${how}: the next session does not say it is waiting`, async () => {
    const stub = await startStub({ oren: {}, mira: {} });
    try {
      const q = await sendAs(stub, 'mira', 'oren', 'does scheduled_at come back as UTC with a Z?', { origin: 'context_move' });
      const vh = homeFor('oren', ['mira']);
      const before = await sitDown(vh, stub.url);
      assert.match(waiting(before.out), /^\/vibe · 1 message waiting · from @mira: does scheduled_at come back as UTC with a Z\?/, 'unanswered: waiting');

      await answer(stub, q);
      const after = await sitDown(vh, stub.url);
      assert.equal(waiting(after.out), '', `answered, yet shown as waiting: ${after.raw}`);
      assert.ok(!after.raw.includes('scheduled_at'), 'their answered words are not in the session at all');
      assert.ok(!stub.effects.some((e) => e.effect === 'READ_CURSOR'), 'nothing was marked read, by answering or by looking');
      const t = await fetch(`${stub.url}/api/v2/threads`, { headers: { Authorization: `Bearer ${jwt('oren')}` } }).then((r) => r.json());
      assert.equal(t.threads[0].unread, 1, 'their message is still unread on the wire: only the summary changed');
    } finally { await stub.close(); }
  });
}

test('they write again after the answer: waiting again, with their new words', async () => {
  const stub = await startStub({ oren: {}, mira: {} });
  try {
    const q = await sendAs(stub, 'mira', 'oren', 'is site_tz an IANA name?');
    await sendAs(stub, 'oren', 'mira', 'it is, under site.tz.', { replyTo: q });
    const vh = homeFor('oren', ['mira']);
    assert.equal(waiting((await sitDown(vh, stub.url)).out), '');

    await sendAs(stub, 'mira', 'oren', 'and can the board get more than 50 per page?');
    const again = await sitDown(vh, stub.url);
    assert.equal(waiting(again.out), '/vibe · 1 message waiting · from @mira: and can the board get more than 50 per page?');
    assert.ok(!again.raw.includes('is site_tz an IANA name'), 'the answered question is not brought back');
  } finally { await stub.close(); }
});

test('an answered conversation sits beside a waiting one: only the waiting one is shown', async () => {
  const stub = await startStub({ oren: {}, mira: {}, ada: {} });
  try {
    await sendAs(stub, 'mira', 'oren', 'first question');
    await sendAs(stub, 'oren', 'mira', 'first answer');
    await sendAs(stub, 'ada', 'oren', 'are you on the release today?');
    const { out } = await sitDown(homeFor('oren', ['mira', 'ada']), stub.url);
    assert.equal(waiting(out), '/vibe · 1 message waiting · from @ada: are you on the release today?');
  } finally { await stub.close(); }
});
