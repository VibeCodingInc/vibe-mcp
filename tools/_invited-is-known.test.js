'use strict';
/**
 * You invite someone; they join and write to you first. That message reaches
 * you while you work.
 *
 * Lab 2026-11-20: the inviter's machine held the newcomer's first message as a
 * stranger's ("1 person you have not written to is waiting"), and across ten
 * simulated runs a question offered 10 times and sent 7 times got 1 answer.
 *
 * Now the line a person gives out carries an invitation code minted on their
 * own account (invite.codeFor). The newcomer's sign-in redeems it on the
 * platform, which then serves `invited_by_you` on the inviter's inbox row for
 * that one person. The inviter's machine treats that as known (reach.json, so
 * `mute` undoes it), and the arrival says "you invited them" once.
 *
 * Pinned here, against the lab stand-in API on 127.0.0.1 (lab/stub.mjs):
 *   - the whole round trip: invite, redeem, write first, arrive mid-work;
 *   - the field absent (today's platform): exactly today's behaviour, held;
 *   - nothing on the newcomer's side can make them known: only the platform's
 *     own redemption record, served to the inviter alone, does;
 *   - mute still wins; the inverse (the newcomer knows the inviter) is accept;
 *   - codes: own, plain, live ones reused; minted only when none; no code on
 *     any failure; the code rides into sign-in only when well formed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-invited-known-'));
process.env.VIBE_HOME = HOME;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ handle: 'ada', token: jwt('ada'), provider: 'github', authenticated_at: new Date().toISOString() }));

let stub; let store; let presence; let arrival; let reach; let invite; let authStore;
const HOOK = path.join(ROOT, 'hooks', 'arrival-hook.cjs');

test.before(async () => {
  stub = await (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub({ people: { ada: {}, nell: {}, mo: {} } });
  // store/api.js reads the API address once, when it is first loaded.
  process.env.VIBE_API_URL = stub.url;
  store = require('../store');
  authStore = require('../auth-store');
  presence = require('../presence');
  arrival = require('../arrival');
  reach = require('../reach');
  invite = require('../invite');
  authStore.isVerified = () => true;
  store.getActiveUsers = async () => [];
});
test.after(async () => { await stub.close(); });

const look = async (me) => {
  const read = await store.getInboxResult(me);
  assert.equal(read.ok, true, 'the stand-in answered');
  await presence.noteArrivals(me, read.threads);
  return read.threads;
};
const spooled = () => fs.readdirSync(arrival.spoolDir()).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(arrival.spoolDir(), f), 'utf8')));

test('the round trip: Ada invites, Nell signs in with the code and writes first, Ada sees it while she works', async () => {
  // Ada's session is open; its first look sees an empty inbox.
  await look('ada');

  // Ada is shown her invite line. It carries a code minted on her account.
  const code = await invite.codeFor('ada');
  assert.match(String(code), /^VIBE-[A-Z0-9]+-ADA$/);
  const bring = invite.line('ada', code);
  assert.equal(bring.command, `npx slashvibe-mcp setup --from @ada --invite ${code}`);
  assert.equal(bring.link, `https://www.slashvibe.dev/join?from=ada&invite=${code}`);
  assert.equal(await invite.codeFor('ada'), code, 'shown again, the same code: the allowance is not spent');
  assert.equal(stub.effects.filter((e) => e.effect === 'MINT_INVITE').length, 1);

  // Nell installs from it; her sign-in carries the code and redeems it.
  assert.equal(invite.inviteArg(['node', 'cli.js', 'setup', '--from', '@ada', '--invite', code]), code);
  assert.equal(stub.redeem(code, 'nell'), true);
  assert.equal(stub.redeem(code, 'mo'), false, 'one code, one person');

  // She writes first. Ada has never written to her.
  stub.post('nell', 'ada', 'made it in. which backoff did you land on for the retry queue?');
  assert.equal(reach.isKnown('nell'), false);
  const threads = await look('ada');
  assert.equal(threads.find((t) => t.handle === 'nell').invitedByYou, true);

  const [row] = spooled().filter((r) => r.from === 'nell');
  assert.ok(row, 'it arrived (spooled for Ada\'s next prompt), not held');
  assert.equal(row.line, '/vibe · @nell (you invited them) wrote you: "made it in. which backoff did you land on for the retry queue?"');
  assert.match(row.context, /someone they invited/);
  assert.equal(reach.isKnown('nell'), true, 'remembered as known, so `mute @nell` undoes it');

  // At Ada's next prompt the arrival hook puts it in front of her.
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: arrival.spoolDir() }, encoding: 'utf8',
  });
  assert.match(out.stdout, /@nell \(you invited them\) wrote you/);

  // Her second message is an ordinary arrival: "you invited them" is said once.
  stub.post('nell', 'ada', 'also: dead-letter after how many tries?');
  await look('ada');
  const second = spooled().find((r) => r.from === 'nell' && /dead-letter/.test(r.text));
  assert.equal(second.line, '/vibe · @nell wrote you: "also: dead-letter after how many tries?"');
  assert.ok(!stub.effects.some((e) => ['SEND', 'READ_CURSOR'].includes(e.effect)), 'looking sent nothing and marked nothing read');
});

test('a platform without the field: held exactly as today', async () => {
  const origThread = store.getThread;
  store.getThread = async () => [{ from: 'theo', body: 'hi', timestamp: Date.now() }];
  try {
    // invitedByYou absent from the row (the mapper reads a missing field as false).
    const t = { handle: 'theo', lastFrom: 'theo', unread: 1, lastMessage: 'hi ada', lastMessageId: 'msg_theo0001', lastTimestamp: Date.now(), muted: false, invitedByYou: false };
    await presence.noteArrivals('ada', [t]);
    assert.equal(arrival.isSpooled('msg_theo0001'), false, 'held, not shown');
    assert.equal(reach.isKnown('theo'), false);
  } finally { store.getThread = origThread; }
});

test('only the inviter\'s own row counts, mute still wins, and a row that is not theirs proves nothing', async () => {
  const origThread = store.getThread;
  store.getThread = async () => [{ from: 'zed', body: 'x', timestamp: Date.now() }];
  try {
    reach.mute('quin');
    const muted = { handle: 'quin', lastFrom: 'quin', unread: 1, lastMessage: 'hey', lastMessageId: 'msg_quin0001', lastTimestamp: Date.now(), muted: false, invitedByYou: true };
    // A row whose newest message is not from the conversation's other person.
    const odd = { handle: 'zed', lastFrom: 'yan', unread: 1, lastMessage: 'hey', lastMessageId: 'msg_odd00001', lastTimestamp: Date.now(), muted: false, invitedByYou: true };
    await presence.noteArrivals('ada', [muted, odd]);
    assert.equal(arrival.isSpooled('msg_quin0001'), false, 'muted stays muted');
    assert.equal(reach.isKnown('quin'), false);
    assert.equal(reach.isKnown('yan'), false);
  } finally { store.getThread = origThread; }
});

test('the newcomer cannot make themselves known: their own code, a claim, or someone else\'s code are not an invitation from Ada', async () => {
  // Mo mints a code of his own and "redeems" it: refused (never by its creator).
  const mos = stub.mintCode('mo');
  assert.equal(stub.redeem(mos, 'mo'), false);
  // A made-up code is nobody's.
  assert.equal(stub.redeem('VIBE-NOTREAL01-ADA', 'mo'), false);
  // Someone else's code makes Mo invited by THEM, and Ada's inbox says nothing.
  const kits = stub.mintCode('kit');
  assert.equal(stub.redeem(kits, 'mo'), true);
  stub.post('mo', 'ada', 'hi ada, kit sent me');
  const threads = await look('ada');
  assert.equal(threads.find((t) => t.handle === 'mo').invitedByYou, false);
  assert.equal(reach.isKnown('mo'), false);
});

test('the inverse already holds: the newcomer who installs with --from knows the inviter (accept)', async () => {
  const nellEnv = { VIBE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-nell-')) };
  const got = await invite.accept('@ada', 'nell', { apiUrl: stub.url, env: nellEnv });
  assert.equal(got.known, true);
  assert.equal(reach.isKnown('ada', nellEnv), true);
});

test('codeFor: reuses a plain live code of yours, never a named or nearly expired one; mints only when there is none; null on any failure', async () => {
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const later = new Date(Date.now() + 9 * 86400_000).toISOString();
  let minted = 0;
  const fake = (codes, extra = {}) => ({
    listMyInvites: async () => ({ success: true, can_generate: true, codes, ...extra }),
    createInvite: async (body) => { minted++; assert.deepEqual(body, {}, 'a plain code: no name, note or thought'); return { success: true, code: 'VIBE-FRESHCODE1-ADA' }; },
  });
  assert.equal(await invite.codeFor('ada', { store: fake([{ code: 'VIBE-PLAINAAAA1-ADA', status: 'available', expires_at: later }]) }), 'VIBE-PLAINAAAA1-ADA');
  assert.equal(minted, 0);
  assert.equal(await invite.codeFor('ada', { store: fake([
    { code: 'VIBE-NAMEDAAAA1-ADA', status: 'available', named_for: 'bo', expires_at: later },
    { code: 'VIBE-THOUGHTAA1-ADA', status: 'available', carries_thought: true, expires_at: later },
    { code: 'VIBE-SOONAAAAA1-ADA', status: 'available', expires_at: soon },
    { code: 'VIBE-USEDAAAAA1-ADA', status: 'used', expires_at: later },
  ]) }), 'VIBE-FRESHCODE1-ADA');
  assert.equal(minted, 1);
  assert.equal(await invite.codeFor('ada', { store: fake([], { can_generate: false }) }), null, 'no allowance left: no code, nothing minted');
  assert.equal(minted, 1);
  assert.equal(await invite.codeFor('ada', { store: { listMyInvites: async () => ({ success: false, statusCode: 401 }), createInvite: async () => { throw new Error('no'); } } }), null);
  assert.equal(await invite.codeFor('ada', { store: { listMyInvites: async () => { throw new Error('offline'); }, createInvite: async () => ({}) } }), null);
  assert.equal(await invite.codeFor('ada', { store: { listMyInvites: async () => ({ success: true, codes: [] }), createInvite: async () => ({ success: true, code: '"><script>' }) } }), null, 'a malformed code is never printed');
  assert.equal(await invite.codeFor('not a handle!', { store: fake([]) }), null);
  // No code: the line is exactly the one given out before.
  assert.deepEqual(invite.line('ada', null), { command: 'npx slashvibe-mcp setup --from @ada', link: 'https://www.slashvibe.dev/join?from=ada' });
  assert.deepEqual(invite.line('ada', 'bad code'), invite.line('ada'));
});

test('--invite: read only when well formed; carried into sign-in as invite_code, and only then', async () => {
  assert.equal(invite.inviteArg(['setup', '--invite=vibe-abcdefghjk-ada']), 'VIBE-ABCDEFGHJK-ADA');
  for (const bad of [['setup', '--invite', 'x&redirect=evil'], ['setup', '--invite'], ['setup'], ['setup', '--invite', 'VIBE-' + 'A'.repeat(40)]]) {
    assert.equal(invite.inviteArg(bad), null, bad.join(' '));
  }
  const { beginOAuth } = require('../oauth-callback');
  const withCode = await beginOAuth({ actorAware: true, inviteCode: 'VIBE-ABCDEFGHJK-ADA', timeoutMs: 60_000 });
  try { assert.equal(new URL(withCode.loginUrl).searchParams.get('invite_code'), 'VIBE-ABCDEFGHJK-ADA'); } finally { await withCode.cancel(); }
  const bad = await beginOAuth({ actorAware: true, inviteCode: 'x&y', timeoutMs: 60_000 });
  try { assert.equal(new URL(bad.loginUrl).searchParams.has('invite_code'), false); } finally { await bad.cancel(); }
});

test('sitting down: a message from someone you invited is shown, not counted as a stranger\'s', async () => {
  const vh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-walt-')), '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle: 'walt', token: jwt('walt'), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle: 'walt' }));
  const code = stub.mintCode('walt');
  assert.equal(stub.redeem(code, 'theo'), true);
  stub.post('theo', 'walt', 'dad it is theo, I am in');
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'hook', 'run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.dirname(vh), VIBE_HOME: vh, VIBE_API_URL: stub.url, CI: '1', VIBE_SETUP_NO_AUTORUN: '1' },
    });
    let s = ''; child.stdout.on('data', (d) => { s += d; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(timer); resolve(JSON.parse(s)); });
  });
  assert.ok(!/have not written to/.test(out.systemMessage || ''), out.systemMessage);
  assert.match(out.systemMessage || '', /theo/);
  assert.equal(reach.isKnown('theo', { VIBE_HOME: vh }), true);
});
