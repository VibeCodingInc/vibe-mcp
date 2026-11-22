'use strict';
// lab/no-box-proxy.cjs: the lab's `--no-box` host. Real Claude Code declares
// elicitation, so removing only the lab's hook measured "nobody at the
// keyboard" (every box cancelled), not "a host that cannot show the box". The
// proxy removes the client's elicitation capability and relays everything else
// unchanged, so the server takes the turn-check path. No `claude` here: a fake
// server and client, then the real index.js behind the proxy against the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'lab', 'no-box-proxy.cjs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-no-box-proxy-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const CAPS = 'io.modelcontextprotocol/clientCapabilities';

/** Run the proxy in front of `serverArgs`; feed it `chunks` (strings) with small gaps; collect stdout and the exit code. */
function throughProxy(serverArgs, chunks, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY, ...serverArgs], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    (async () => {
      for (const c of chunks) { child.stdin.write(c); await new Promise((r) => setTimeout(r, 15)); }
      child.stdin.end();
    })();
  });
}

// A fake server: echoes each line it receives as {"echo": "<the raw line>"},
// sends one server->client request first, says something on stderr, and exits 7
// when its stdin ends.
const FAKE = path.join(DIR, 'fake-server.cjs');
fs.writeFileSync(FAKE, `
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'x', requestedSchema: { type: 'object', properties: {} } } }) + '\\n');
process.stderr.write('fake server stderr\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); process.stdout.write(JSON.stringify({ echo: l }) + '\\n'); } });
process.stdin.on('end', () => { if (buf) process.stdout.write(JSON.stringify({ echo: buf, unterminated: true }) + '\\n'); process.exit(7); });
`);

test('the proxy removes elicitation from initialize and from per-request _meta; everything else passes unchanged', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} }, roots: { listChanged: true } }, clientInfo: { name: 'claude-code', version: '2.1.330' } } };
  const call = { jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'vibe_send', arguments: { id: 'w1', rev: 'r1' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', [CAPS]: { elicitation: { form: {} }, sampling: {} }, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code' } } } };
  const discover = { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: { [CAPS]: { elicitation: {} } } } };
  const plain = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { [CAPS]: { roots: {} } } } });
  const response = JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', result: { action: 'decline' } });
  const callLine = JSON.stringify(call);
  const r = await throughProxy([process.execPath, FAKE], [
    `${JSON.stringify(init)}\n`,
    callLine.slice(0, 40), callLine.slice(40, 90), `${callLine.slice(90)}\n`,   // one message in three chunks
    `${JSON.stringify(discover)}\n${plain}\nnot json at all\n${response}\n`,
    '{"jsonrpc":"2.0","id":9,"method":"ping"}',                                  // no trailing newline
  ]);
  assert.equal(r.code, 7, `the server's exit code is the proxy's: ${r.err}`);
  assert.match(r.err, /fake server stderr/, 'stderr is forwarded');
  const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].method, 'elicitation/create', 'server -> client passes untouched');
  assert.equal(lines[0].id, 'srv-1');
  const echoes = lines.slice(1).map((x) => x.echo);
  assert.equal(echoes.length, 7, 'every line, in order');
  const got = (i) => JSON.parse(echoes[i]);
  assert.deepEqual(got(0), { ...init, params: { ...init.params, capabilities: { roots: { listChanged: true } } } });
  assert.deepEqual(got(1), { ...call, params: { ...call.params, _meta: { ...call.params._meta, [CAPS]: { sampling: {} } } } }, 'reassembled across chunks; id kept');
  assert.deepEqual(got(2).params._meta[CAPS], {});
  assert.equal(echoes[3], plain, 'a message without elicitation goes byte for byte');
  assert.equal(echoes[4], 'not json at all');
  assert.equal(echoes[5], response, 'a client response goes byte for byte');
  assert.equal(echoes[6], '{"jsonrpc":"2.0","id":9,"method":"ping"}', 'an unterminated last line is forwarded at the end');
});

test('a JSON-RPC batch is rewritten message by message', () => {
  const { rewrite } = require(PROXY);
  const out = JSON.parse(rewrite(JSON.stringify([{ id: 1, method: 'initialize', params: { capabilities: { elicitation: {} } } }, { id: 2, method: 'tools/list' }])));
  assert.deepEqual(out, [{ id: 1, method: 'initialize', params: { capabilities: {} } }, { id: 2, method: 'tools/list' }]);
});

// ── the real server behind the proxy ─────────────────────────────────────────

const turns = require('../turns');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;

async function realSession(fn) {
  const { startStub } = await import(path.join(ROOT, 'lab', 'stub.mjs'));
  const stub = await startStub({ people: { ada: { says: 'me', kind: 'human' }, ben: { says: 'ben', kind: 'human' } } });
  const home = fs.mkdtempSync(path.join(DIR, 'home-'));
  const project = fs.mkdtempSync(path.join(DIR, 'project-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ handle: 'ada', token: jwt('ada'), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ handle: 'ada', one_liner: 'me' }));
  turns.record(project, Date.now() - 60_000, { VIBE_HOME: home });   // the arrival hook has run here
  const env = { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: stub.url, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: home };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'VIBE_AGENT_HANDLE', 'VIBE_TURNS_DIR', 'VIBE_LAB_BOX_HOOK']) delete env[k];
  const child = spawn(process.execPath, [PROXY, process.execPath, path.join(ROOT, 'index.js')], { env, cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
  const rows = []; let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { rows.push(JSON.parse(l)); } catch {} } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const wait = (id) => new Promise((resolve, reject) => { const t0 = Date.now(); const f = () => { const r = rows.find((x) => x.id === id); if (r) return resolve(r); if (Date.now() - t0 > 15_000) return reject(new Error(`no response ${id}: ${JSON.stringify(rows).slice(0, 500)}`)); setTimeout(f, 20); }; f(); });
  const personTurn = async () => { await new Promise((r) => setTimeout(r, 5)); turns.record(project, Date.now(), { VIBE_HOME: home }); };
  try { await fn({ send, wait, rows, personTurn, stub }); } finally { child.kill(); await stub.close(); }
}
const textOf = (r) => r.result.content[0].text;
const draftOf = (t) => ({ id: t.match(/draft (w[0-9a-f]+)/)[1], rev: t.match(/rev ([0-9a-f]{8})/)[1] });

test('behind the proxy, a Claude Code client that declares elicitation (2025-11-25) gets the turn check and no box', async () => {
  await realSession(async ({ send, wait, rows, personTurn, stub }) => {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: 'claude-code', version: '2.1.330' } } });
    await wait(1);
    send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'ben', message: 'shown, then sent after a turn' } } });
    const prep = textOf(await wait(2));
    assert.match(prep, /This app cannot show \/vibe's confirmation box, so sending relies on your typed reply\./, 'the server sees no box');
    const d = draftOf(prep);
    send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    assert.match(textOf(await wait(3)), /^Not sent yet: they have not typed a message since it was shown/);
    await personTurn();
    send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    assert.match(textOf(await wait(4)), /^Sent to \*\*@ben\*\*/);
    assert.equal(rows.some((r) => r.method === 'elicitation/create'), false, 'no box was opened');
    assert.equal(stub.effects.filter((e) => e.effect === 'SEND').length, 1);
  });
});

test('behind the proxy, a stateless (2026-07-28) request declaring elicitation gets no input_required, only the turn check', async () => {
  await realSession(async ({ send, wait, personTurn, stub }) => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', [CAPS]: { elicitation: { form: {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.330' } };
    send({ id: 1, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'ben', message: 'stateless, no box' }, _meta: meta } });
    const d = draftOf(textOf(await wait(1)));
    send({ id: 2, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: meta } });
    const refused = (await wait(2)).result;
    assert.equal(refused.resultType, 'complete');
    assert.match(refused.content[0].text, /^Not sent yet:/);
    await personTurn();
    send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: meta } });
    const sent = (await wait(3)).result;
    assert.equal(sent.resultType, 'complete', 'no input_required');
    assert.match(sent.content[0].text, /^Sent to \*\*@ben\*\*/);
    assert.equal(stub.effects.filter((e) => e.effect === 'SEND').length, 1);
  });
});

// ── population: wiring and the opposite check ───────────────────────────────

test('population --no-box: the sessions\' MCP config runs the proxy in front of the same server; the kept-open server runs it directly', async () => {
  const { useNoBoxProxy } = await import(path.join(ROOT, 'lab', 'population.mjs'));
  const mcp = path.join(DIR, 'mcp.json');
  const env = { VIBE_HOME: '/x/.vibe', VIBE_API_URL: 'http://127.0.0.1:1' };
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { vibe: { command: process.execPath, args: [path.join(ROOT, 'index.js')], env } } }));
  const id = { mcp };
  useNoBoxProxy(id);
  assert.equal(id.directMcp, mcp);
  const proxied = JSON.parse(fs.readFileSync(id.mcp, 'utf8')).mcpServers.vibe;
  assert.deepEqual(proxied, { command: process.execPath, args: [PROXY, process.execPath, path.join(ROOT, 'index.js')], env });
  assert.match(fs.readFileSync(path.join(ROOT, 'lab', 'harness.mjs'), 'utf8'), /id\.directMcp \|\| id\.mcp/, 'keepOpen uses the server itself');
});

test('--no-box summaries record the proxy, and a box-path result marks the world FAILED', async () => {
  const { boxExpectationFailure, writePopulation } = await import(path.join(ROOT, 'lab', 'population.mjs'));
  const box = 'Not sent. It is still a draft for @ben. Only if they ask again: show it with vibe_prepare and wait for them to say send.';
  assert.match(boxExpectationFailure({ box_path: false, refused_sends: { list: [{ returned: box }] } }), /^FAILED: --no-box, but 1 send\(s\) got a Send box result: the proxy did not take effect$/);
  assert.equal(boxExpectationFailure({ box_path: false, refused_sends: { list: [{ returned: 'Not sent yet: they have not typed a message since it was shown.' }] } }), null);
  const out = fs.mkdtempSync(path.join(DIR, 'pop-'));
  const agg = writePopulation(out, [{ file: 'w.json', id: 'w', summary: { id: 'w', archetype: 'a', box_path: false, no_box_via: 'proxy', failed: 'FAILED: --no-box, but 1 send(s) got a Send box result: the proxy did not take effect' } }], { noBox: true });
  assert.equal(agg.box_path, false);
  assert.equal(agg.no_box_via, 'proxy');
  assert.equal(agg.failed.length, 1, 'the run exits non-zero');
});

test('a server that cannot be started is reported, with a non-zero exit', async () => {
  const r = await throughProxy([path.join(DIR, 'no-such-server')], ['{}\n']);
  assert.equal(r.code, 127);
  assert.match(r.err, /no-box-proxy: could not start the server/);
});
