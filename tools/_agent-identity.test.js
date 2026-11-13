/**
 * An agent on /vibe as itself (agent-auth.js), and the person who runs it.
 *
 * What must hold:
 *   - the agent's credential is never printed, returned, stored, or left in the
 *     environment for a child process to inherit;
 *   - an agent identity never shares a person's identity directory;
 *   - only the session minted for THIS handle, as an agent, is used;
 *   - an agent is never sent to the people's sign-in, and cannot be handed
 *     another identity by a pasted token;
 *   - only someone holding the agent's credential can be named as running it,
 *     and an operator is never silently replaced.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
// Stand-ins built at run time, so nothing credential-shaped is written in this file.
const SECRET = ['lab', 'stand', 'in', 'for', 'sol'].join('-').repeat(2);
const OTHER = ['lab', 'stand', 'in', 'for', 'someone', 'else'].join('-').repeat(2);
const jwt = (h, extra = {}) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 3600, ...extra })).toString('base64url')}.sig`;

function dirFor(person = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-'));
  const vh = path.join(root, '.vibe');
  fs.mkdirSync(vh, { recursive: true });
  if (person) {
    fs.writeFileSync(path.join(vh, 'auth.json'), JSON.stringify({ handle: person, token: jwt(person), provider: 'github', authenticated_at: new Date().toISOString() }));
    fs.writeFileSync(path.join(vh, 'config.json'), JSON.stringify({ handle: person }));
  }
  const mint = (value) => { const f = path.join(root, `mint-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, `${value}\n`, { mode: 0o600 }); return f; };
  return { root, vh, mint };
}
// Asynchronous on purpose: the stub lives in this process.
function run(vh, apiUrl, args, env = {}, { stdin = null, waitMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: vh ? path.dirname(vh) : fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-nohome-')), ...(vh ? { VIBE_HOME: vh } : {}), VIBE_API_URL: apiUrl, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', VIBE_SETUP_STUB_BROWSER: '1', ...env },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    if (stdin !== null) { child.stdin.write(stdin); if (waitMs) setTimeout(() => child.stdin.end(), waitMs); else child.stdin.end(); }
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, all: out + err }); });
  });
}
const startStub = async (opts) => (await import(path.join(ROOT, 'lab', 'stub.mjs'))).startStub(opts);
const everyFile = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? everyFile(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), 'utf8'))).join('\n');
const agentEnv = (d, handle = 'sol', secret = SECRET) => ({ VIBE_AGENT_HANDLE: handle, VIBE_AGENT_MINT_FILE: d.mint(secret) });

test('the credential is read once, leaves the environment, and is scrubbed from anything shown', () => {
  const agentAuth = require('../agent-auth');
  agentAuth._resetForTest();
  const env = { VIBE_AGENT_HANDLE: '@Sol', VIBE_AGENT_MINT: SECRET, VIBE_HOME: '/tmp/x' };
  assert.deepEqual(agentAuth.configured(env), { handle: 'sol', problem: null });
  assert.equal(env.VIBE_AGENT_MINT, undefined, 'the credential stayed in the environment for children to inherit');
  assert.equal(agentAuth.scrub(`refused: ${SECRET}!`), 'refused: [agent credential]!');
  assert.ok(!JSON.stringify(agentAuth.configured(env)).includes(SECRET));
  for (const [bad, why] of [
    [{ VIBE_AGENT_HANDLE: 'sol', VIBE_HOME: '/tmp/x' }, /no credential/],
    [{ VIBE_AGENT_HANDLE: 'sol', VIBE_AGENT_MINT: 'short', VIBE_HOME: '/tmp/x' }, /does not look like one/],
    [{ VIBE_AGENT_HANDLE: 'sol', VIBE_AGENT_MINT: `${SECRET} two words`, VIBE_HOME: '/tmp/x' }, /does not look like one/],
    [{ VIBE_AGENT_HANDLE: 'not a handle!', VIBE_AGENT_MINT: SECRET, VIBE_HOME: '/tmp/x' }, /not a handle/],
    [{ VIBE_AGENT_HANDLE: 'sol', VIBE_AGENT_MINT: SECRET }, /needs its own identity directory/],
    [{ VIBE_AGENT_HANDLE: 'sol', VIBE_AGENT_MINT_FILE: '/nonexistent/mint', VIBE_HOME: '/tmp/x' }, /could not be read/],
  ]) {
    agentAuth._resetForTest();
    assert.match(agentAuth.configured(bad).problem, why);
  }
  agentAuth._resetForTest();
  assert.equal(agentAuth.configured({ VIBE_AGENT_MINT: SECRET, VIBE_HOME: '/tmp/x' }), null, 'a credential alone is not an agent identity');
  agentAuth._resetForTest();
});

test('an agent signs in as itself, reuses its session, and the credential is stored nowhere', async () => {
  const stub = await startStub({ people: { og: {}, nell: {} }, agentMints: { sol: SECRET } });
  try {
    const d = dirFor();
    const env = agentEnv(d);
    const first = await run(d.vh, stub.url, ['agent', 'signin'], env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /@sol is signed in to \/vibe as an agent, until \d{4}-\d{2}-\d{2} \(new session\)/);
    assert.match(first.out, /No operator is named/);
    const saved = JSON.parse(fs.readFileSync(path.join(d.vh, 'config.json'), 'utf8'));
    assert.equal(saved.username, 'sol');
    assert.equal(saved.authMethod, 'agent');
    assert.equal(JSON.parse(Buffer.from(saved.authToken.split('.')[1], 'base64url')).handle, 'sol');
    assert.ok(!first.all.includes(SECRET) && !everyFile(d.vh).includes(SECRET), 'the credential was shown or stored');

    // Asking again does not mint again: the service allows few mints an hour.
    const again = await run(d.vh, stub.url, ['agent'], env);
    assert.match(again.out, /@sol is signed in to \/vibe as an agent/);
    assert.ok(!/new session/.test(again.out));
    assert.equal(stub.effects.filter((e) => e.effect === 'AGENT_MINT').length, 1);

    // No identity directory of its own: refused before anything is sent.
    const shared = await run(null, stub.url, ['agent', 'signin'], env);
    assert.equal(shared.code, 1);
    assert.match(shared.err, /needs its own identity directory/);
    assert.equal(stub.effects.filter((e) => e.effect === 'AGENT_MINT').length, 1);
  } finally { await stub.close(); }
});

test('a wrong credential, a handle that is a person, and an unknown handle sign nobody in', async () => {
  const stub = await startStub({ people: { og: {}, nell: {} }, agentMints: { sol: SECRET, og: OTHER } });
  try {
    for (const [handle, secret, why] of [
      ['sol', OTHER, /refused this agent's credential/],
      ['og', OTHER, /already belongs to a person/],
      ['ghost', SECRET, /refused this agent's credential/],
    ]) {
      const d = dirFor();
      const r = await run(d.vh, stub.url, ['agent', 'signin'], agentEnv(d, handle, secret));
      assert.equal(r.code, 1, `${handle} was signed in`);
      assert.match(r.err, why);
      assert.ok(!r.all.includes(secret));
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(d.vh, 'config.json'), 'utf8')); } catch { return {}; } })();
      assert.ok(!cfg.authToken, 'a session was saved after a refusal');
    }
    // A person's sign-in sitting in the directory: not used as the agent's, and not destroyed.
    const d = dirFor('nell');
    const before = everyFile(d.vh);
    const r = await run(d.vh, stub.url, ['agent', 'signin'], agentEnv(d));
    assert.equal(r.code, 1);
    assert.match(r.err, /already holds another sign-in \(@nell\)\. An agent needs a VIBE_HOME of its own/);
    assert.equal(everyFile(d.vh), before, 'a person\'s sign-in was changed by an agent starting in their directory');
  } finally { await stub.close(); }
});

test('a session that is the agent: never the people\'s sign-in, never a pasted identity, never a second registration', async () => {
  const stub = await startStub({ people: { og: {}, nell: {} }, agentMints: { sol: SECRET } });
  try {
    const d = dirFor();
    const rpc = (id, name, args = {}) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      rpc(2, 'vibe_start'), rpc(3, 'vibe_init'), rpc(4, 'vibe_token', { token: jwt('nell') }), rpc(5, 'vibe_people'),
    ].join('\n') + '\n';
    const r = await run(d.vh, stub.url, [], agentEnv(d), { stdin: input, waitMs: 4000 });
    const replies = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => { try { const m = JSON.parse(l); return [m.id, m.result?.content?.[0]?.text || JSON.stringify(m.error || m.result)]; } catch { return [null, '']; } }));
    assert.match(replies[2], /this session is the agent @sol/, replies[2]);
    assert.ok(!/slashvibe\.dev\/login|github/i.test(replies[2]), 'an agent was offered the people\'s sign-in');
    assert.match(replies[3], /This session is the agent @sol\. It signs in with its agent credential/);
    assert.match(replies[4], /This session is the agent @sol/);
    assert.match(replies[5], /in a session now|nobody else/);
    const cfg = JSON.parse(fs.readFileSync(path.join(d.vh, 'config.json'), 'utf8'));
    assert.equal(JSON.parse(Buffer.from(cfg.authToken.split('.')[1], 'base64url')).handle, 'sol', 'a pasted token changed who this agent is');
    assert.ok(!stub.effects.some((e) => e.effect === 'heartbeat' && e.register), 'the agent registered a second session over its own');
    assert.ok(!r.all.includes(SECRET) && !everyFile(d.vh).includes(SECRET));

    // The same session with a credential the service refuses: every tool says so and does nothing.
    const bad = dirFor();
    const refused = await run(bad.vh, stub.url, [], agentEnv(bad, 'sol', OTHER), { stdin: input, waitMs: 4000 });
    assert.match(refused.out, /@sol is not signed in to \/vibe\. The service refused this agent's credential/);
    assert.ok(!/slashvibe\.dev\/login/.test(refused.out), 'a refused agent was sent to the people\'s sign-in');
    assert.ok(!refused.all.includes(OTHER));

    // Setup is for people.
    const setup = await run(d.vh, stub.url, ['setup'], agentEnv(d));
    assert.equal(setup.code, 1);
    assert.match(setup.err, /Setup is for people/);
  } finally { await stub.close(); }
});

test('naming the operator: both proofs, never replaced silently, renew and revoke', async () => {
  const stub = await startStub({ people: { og: {}, nell: {} }, agentMints: { sol: SECRET } });
  try {
    const agent = dirFor();
    const og = dirFor('og');
    const nell = dirFor('nell');
    const withMint = (d, secret = SECRET) => ({ VIBE_AGENT_MINT_FILE: d.mint(secret) });

    // Not an agent yet.
    let r = await run(og.vh, stub.url, ['operate', '@sol'], withMint(og));
    assert.equal(r.code, 1);
    assert.match(r.err, /has to sign in once as itself first/);
    await run(agent.vh, stub.url, ['agent', 'signin'], agentEnv(agent));

    // Refusals that never reach the service.
    for (const [args, env, why] of [
      [['operate', '@sol'], {}, /needs that agent's own credential/],
      [['operate', '@sol', `--mint=${SECRET}`], {}, /never given on the command line/],
      [['operate', '@sol', '@ada'], withMint(og), /One agent at a time/],
      [['operate', 'not a handle!'], withMint(og), /is not a handle/],
      [['operate', '@og'], withMint(og), /@og is you/],
      [['operate', '@sol', '--days=45'], withMint(og), /between 1 and 30/],
      [['operate', '@sol'], { ...withMint(og), VIBE_AGENT_HANDLE: 'sol' }, /An agent cannot name its own operator/],
    ]) {
      const before = stub.effects.filter((e) => e.effect === 'GRANT').length;
      r = await run(og.vh, stub.url, args, env);
      assert.equal(r.code, 1, `${args.join(' ')} was accepted`);
      assert.match(r.err, why);
      assert.equal(stub.effects.filter((e) => e.effect === 'GRANT').length, before);
      assert.ok(!r.all.includes(SECRET));
    }
    const signedOut = dirFor();
    r = await run(signedOut.vh, stub.url, ['operate', '@sol'], withMint(signedOut));
    assert.match(r.err, /Sign in as yourself first/);

    // The wrong credential is refused by the service.
    r = await run(nell.vh, stub.url, ['operate', '@sol'], withMint(nell, OTHER));
    assert.equal(r.code, 1);
    assert.match(r.err, /not this agent's credential/);
    assert.equal(stub.grants.length, 0);

    // The person who holds it names themselves.
    r = await run(og.vh, stub.url, ['operate', '@sol', '--days=7'], withMint(og));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /@sol is now shown as an agent run by @og, until \d{4}-\d{2}-\d{2}/);
    assert.ok(!r.all.includes(SECRET) && !everyFile(og.vh).includes(SECRET));
    const left = Date.parse(stub.grants[0].expires_at) - Date.now();
    assert.ok(left > 6.9 * 86400000 && left < 7.1 * 86400000);
    assert.match((await run(og.vh, stub.url, ['operate'])).out, /@sol until/);
    assert.match((await run(nell.vh, stub.url, ['trust', '@sol'])).out, /@sol is an agent run by @og on \/vibe/);

    // Someone else who also holds the credential cannot take over silently.
    r = await run(nell.vh, stub.url, ['operate', '@sol'], withMint(nell));
    assert.equal(r.code, 1);
    assert.match(r.err, /already has an operator named/);
    assert.equal(stub.grants.filter((g) => !g.revoked_at).length, 1);

    // Renew replaces your own; it needs the credential again.
    r = await run(og.vh, stub.url, ['operate', 'renew', '@sol']);
    assert.match(r.err, /Renewing needs @sol's credential/);
    assert.equal(stub.grants.filter((g) => !g.revoked_at).length, 1, 'a renew without the credential revoked the grant');
    r = await run(og.vh, stub.url, ['operate', 'renew', '@sol'], withMint(og));
    assert.equal(r.code, 0, r.err);
    assert.equal(stub.grants.length, 2);
    assert.equal(stub.grants.filter((g) => !g.revoked_at).length, 1);

    // Revoke.
    r = await run(og.vh, stub.url, ['operate', 'revoke', '@sol']);
    assert.match(r.out, /no longer named as @sol's operator/);
    assert.equal(stub.grants.filter((g) => !g.revoked_at).length, 0);
    assert.match((await run(nell.vh, stub.url, ['trust', '@sol'])).out, /@sol is an agent on \/vibe/);
    assert.match((await run(og.vh, stub.url, ['operate', 'revoke', '@sol'])).out, /You are not named as @sol's operator/);
  } finally { await stub.close(); }
});
