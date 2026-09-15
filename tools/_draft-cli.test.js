// vibe-draft: another surface decides, the terminal package stays the only sender.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'draft-cli.js');

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-draft-'));
  fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
  // A credential is only usable if the token itself names its subject (auth-store
  // refuses an unattributable token), so the fixture is JWT-shaped, unsigned, local only.
  const token = `h.${Buffer.from(JSON.stringify({ sub: 'ada', handle: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
  fs.writeFileSync(path.join(home, '.vibe', 'auth.json'), JSON.stringify({ handle: 'ada', token, provider: 'test', authenticated_at: new Date().toISOString() }));
  return home;
}
function run(home, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, VIBE_HOME: path.join(home, '.vibe'), VIBE_API_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
// The store prunes drafts older than a day, so seeds are stamped now.
function seed(home, drafts) { fs.writeFileSync(path.join(home, '.vibe', 'drafts.json'), JSON.stringify(drafts.map((d) => ({ ...d, createdAt: Date.now() - (5 - (d.createdAt || 0)) })))); }

test('stdout is exactly one JSON object; logs go to stderr', () => {
  const home = scratch();
  const r = run(home, 'list');
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line of stdout');
  assert.deepEqual(r.json, { handle: 'ada', drafts: [] });
});

test('list shows only this account\'s PREVIEWED drafts, with the rev that binds a send, and no private context', () => {
  const home = scratch();
  seed(home, [
    { id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'which curve?', why: 'you named them', refs: [], context: 'PRIVATE SESSION TEXT', createdAt: 1 },
    { id: 'a2', status: 'suggested', from: 'ada', to: 'linus', body: 'not reviewed yet', refs: [], createdAt: 2 },
    { id: 'b1', status: 'previewed', from: 'bob', to: 'linus', body: 'someone else\'s', refs: [], createdAt: 3 },
    { id: 'a3', status: 'sent', from: 'ada', to: 'linus', body: 'gone', refs: [], createdAt: 4 },
  ]);
  const r = run(home, 'list');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.drafts.map((d) => d.id), ['a1']);
  const d = r.json.drafts[0];
  assert.equal(d.message, 'which curve?');
  assert.match(d.rev, /^[0-9a-f]{8}$/);
  assert.ok(!('context' in d), 'the session context never leaves the store');
  assert.ok(!JSON.stringify(r.json).includes('PRIVATE SESSION TEXT'));
});

test('send requires the exact rev that was shown — a stale rev sends nothing', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'which curve?', refs: [], createdAt: 1 }]);
  const r = run(home, 'send', 'a1', 'deadbeef');
  assert.equal(r.code, 0);
  assert.equal(r.json.sent, false);
  assert.match(r.json.display, /changed since that preview|rev/);
  const store = JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'drafts.json'), 'utf8'));
  assert.equal(store[0].status, 'previewed', 'nothing was claimed');
});

test('send with the shown rev goes through the SAME claim as the terminal: the draft is marked and a digest is bound (transport refused here, so it returns to previewed)', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'which curve?', refs: [], createdAt: 1 }]);
  const rev = run(home, 'list').json.drafts[0].rev;
  const r = run(home, 'send', 'a1', rev);
  assert.equal(r.code, 0);
  assert.equal(r.json.sent, false, 'no server reachable in the test');
  const store = JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'drafts.json'), 'utf8'));
  assert.ok(['previewed', 'unknown'].includes(store[0].status), `never left in 'sending': ${store[0].status}`);
  assert.match(store[0].approvedSha256 || '', /^[0-9a-f]{64}$/, 'the approval digest was computed at claim');
  assert.match(store[0].idempotencyKey || '', /^draft-a1-/, 'the same idempotency key family as the terminal');
});

test('discard cancels for every surface; a cancelled draft cannot be sent', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'which curve?', refs: [], createdAt: 1 }]);
  const rev = run(home, 'list').json.drafts[0].rev;
  assert.equal(run(home, 'discard', 'a1').json.status, 'cancelled');
  assert.deepEqual(run(home, 'list').json.drafts, []);
  const r = run(home, 'send', 'a1', rev);
  assert.equal(r.json.sent, false);
  assert.match(r.json.display, /cancelled/);
});

test('a large list is never truncated (stdout drains before exit)', () => {
  const home = scratch();
  seed(home, Array.from({ length: 120 }, (_, i) => ({ id: `d${i}`, status: 'previewed', from: 'ada', to: 'linus', body: 'x'.repeat(1900), refs: [], createdAt: i })));
  const r = run(home, 'list');
  assert.equal(r.code, 0);
  assert.ok(r.json, 'stdout parsed as JSON');
  assert.equal(r.json.drafts.length, 120);
});

test('send and discard report the STORED status, and an unconfirmed draft stays listed', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'which curve?', refs: [], createdAt: 1 }]);
  const rev = run(home, 'list').json.drafts[0].rev;
  const s = run(home, 'send', 'a1', rev);
  assert.ok(['previewed', 'unknown'].includes(s.json.status), `stored status reported: ${s.json.status}`);
  assert.equal(typeof s.json.definite, 'boolean');
  if (s.json.status === 'unknown') {
    const l = run(home, 'list');
    assert.equal(l.json.drafts[0].status, 'unknown', 'an unconfirmed send stays reachable');
    assert.equal(l.json.drafts[0].unconfirmed, true);
  }
  const d = run(home, 'discard', 'a1');
  assert.equal(d.json.cancelled, d.json.status === 'cancelled');
});

test('a draft whose sending process died is listed as unknown, not hidden (codex r2)', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'sending', claimedAt: Date.now() - 10 * 60 * 1000, claimedBy: 999999, from: 'ada', to: 'linus', body: 'which curve?', refs: [], createdAt: 1 }]);
  const r = run(home, 'list');
  assert.equal(r.json.drafts.length, 1);
  assert.equal(r.json.drafts[0].status, 'unknown');
  assert.equal(r.json.drafts[0].unconfirmed, true);
});

test('usage errors exit 2 and never touch the store', () => {
  const home = scratch();
  seed(home, [{ id: 'a1', status: 'previewed', from: 'ada', to: 'linus', body: 'x', refs: [], createdAt: 1 }]);
  assert.equal(run(home, 'send', 'a1').code, 2);
  assert.equal(run(home, 'frobnicate').code, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.vibe', 'drafts.json'), 'utf8'))[0].status, 'previewed');
});
