'use strict';
// The Send box over the real stdio server (index.js as a child process), with
// /vibe's API played by a local HTTP server on 127.0.0.1 that records every
// write. Both protocol eras:
//   2025-11-25   the server sends elicitation/create during the call;
//   2026-07-28   the call returns resultType "input_required", and the client
//                retries with inputResponses + requestState.
// As shipped the server does not serve 2026-07-28 (index.js SERVE_STATELESS:
// Claude Code 2.1.330 answers input_required without showing the box), so
// the stateless tests run the server through test/fixtures/stateless-server.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const INDEX = path.join(__dirname, '..', 'index.js');
const STATELESS = path.join(__dirname, '..', 'test', 'fixtures', 'stateless-server.cjs');
const turns = require('../turns');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
const NOT_ACCEPTED = 'Not sent. It is still a draft for @linus. Only if they ask again: show it with vibe_prepare and wait for them to say send.';
const MODERN = '2026-07-28';
const meta = (caps) => ({ 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': caps });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** /vibe's API, locally: identity lookups answer "a person", every write is recorded. */
async function api() {
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method !== 'GET') writes.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      const m = req.url.match(/^\/api\/identity\/([^/?]+)/);
      if (m) return res.end(JSON.stringify({ handle: decodeURIComponent(m[1]), kind: 'human' }));
      if (req.method === 'POST' && /\/messages/.test(req.url)) return res.end(JSON.stringify({ success: true, message: { id: `msg_${writes.length}` }, id: `msg_${writes.length}` }));
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, writes, close: () => new Promise((r) => server.close(r)), sent: (text) => writes.some((w) => w.body.includes(text)) };
}

/** `stateless`: null (as shipped), 'no-box' (2026-07-28 served), 'box-shown' (served, and its box counted as shown). */
function server(apiUrl, extraEnv = {}, { stateless = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-stdio-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-stdio-project-'));
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-box-stdio-claude-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));
  const env = { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: apiUrl, CLAUDE_CONFIG_DIR: claude, CLAUDE_PROJECT_DIR: project, ...extraEnv };
  delete env.VIBE_AGENT_HANDLE; delete env.VIBE_LAB_BOX_HOOK; delete env.VIBE_TURNS_DIR;
  // The host is only what the requests say: no Claude Code environment leaks in from the test runner.
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CODEX_SANDBOX; delete env.CODEX_HOME; delete env.CURSOR_TRACE_ID; delete env.CURSOR_CHANNEL;
  // The arrival hook has recorded turns here: the turn check is live.
  turns.record(project, Date.now() - 60_000, { VIBE_HOME: home });
  const argv = stateless ? [STATELESS, ...(stateless === 'box-shown' ? ['--box-shown'] : [])] : [INDEX];
  const child = spawn(process.execPath, argv, { env, cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
  const rows = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { rows.push(JSON.parse(l)); } catch {} }
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const waitFor = (pred, ms = 15_000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => { const r = rows.find(pred); if (r) return resolve(r); if (Date.now() - t0 > ms) return reject(new Error(`timed out; saw ${JSON.stringify(rows).slice(0, 800)}`)); setTimeout(check, 20); };
    check();
  });
  const personTurn = async () => { await sleep(3); turns.record(project, Date.now(), { VIBE_HOME: home }); };
  const draftStatus = (id) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'drafts.json'), 'utf8')).find((d) => d.id === id).status; } catch { return null; } };
  const close = () => { try { child.kill(); } catch {} for (const d of [home, project, claude]) fs.rmSync(d, { recursive: true, force: true }); };
  return { send, waitFor, rows, personTurn, draftStatus, close, child, get exited() { return exited; } };
}

const textOf = (r) => r.result.content[0].text;
const draftOf = (r) => ({ id: textOf(r).match(/draft (w[0-9a-f]+)/)[1], rev: textOf(r).match(/rev ([0-9a-f]{8})/)[1] });

/** A 2025-11-25 session with a box: initialize, prepare, the person types. */
async function legacyReady(s, message) {
  s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: 'claude-code', version: 'test' } } });
  await s.waitFor((r) => r.id === 1);
  s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message } } });
  const d = draftOf(await s.waitFor((r) => r.id === 2));
  await s.personTurn();
  return d;
}

test('2025-11-25: the box opens with the fixed first line and the text; Decline comes back as the one not-accepted result', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await legacyReady(s, 'over the wire');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    assert.equal(req.params.message, 'Send to @linus? (13 chars, all shown)\n> over the wire');
    assert.deepEqual(req.params.requestedSchema, { type: 'object', properties: {} });
    assert.equal(req.params.mode, 'form');
    s.send({ id: 4, method: 'tools/list' });
    await s.waitFor((r) => r.id === 4);   // answered while the box is open
    s.send({ id: req.id, result: { action: 'decline' } });
    assert.equal(textOf(await s.waitFor((r) => r.id === 3)), NOT_ACCEPTED);
    assert.equal(a.sent('over the wire'), false);
  } finally { s.close(); await a.close(); }
});

test('2025-11-25: Accept goes through to delivery', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await legacyReady(s, 'accepted and delivered');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    s.send({ id: req.id, result: { action: 'accept', content: {} } });
    const res = await s.waitFor((r) => r.id === 3);
    assert.doesNotMatch(textOf(res), /^Not sent/);
    assert.equal(a.sent('accepted and delivered'), true);
  } finally { s.close(); await a.close(); }
});

test('2025-11-25: a response with "error": null and a result is a normal result', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await legacyReady(s, 'error null result');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    s.send({ id: req.id, error: null, result: { action: 'accept' } });
    await s.waitFor((r) => r.id === 3);
    assert.equal(a.sent('error null result'), true);
  } finally { s.close(); await a.close(); }
});

test('2025-11-25: the call is cancelled, then Accept arrives: nothing is sent, the box is withdrawn, the call gets no response', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await legacyReady(s, 'cancelled then accepted');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    s.send({ method: 'notifications/cancelled', params: { requestId: 3, reason: 'user pressed Esc' } });
    const withdrawn = await s.waitFor((r) => r.method === 'notifications/cancelled' && r.params.requestId === req.id);
    assert.ok(withdrawn);
    s.send({ id: req.id, result: { action: 'accept' } });
    await sleep(800);
    assert.equal(s.rows.some((r) => r.id === 3), false, 'no response to a cancelled call');
    assert.equal(a.sent('cancelled then accepted'), false);
    assert.equal(s.draftStatus(d.id), 'previewed');
  } finally { s.close(); await a.close(); }
});

test('2025-11-25: a box left open past the timeout is withdrawn and nothing is sent', async () => {
  const a = await api(); const s = server(a.url, { VIBE_BOX_TIMEOUT_MS: '300' });
  try {
    const d = await legacyReady(s, 'nobody answered');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    await s.waitFor((r) => r.method === 'notifications/cancelled' && r.params.requestId === req.id);
    assert.equal(textOf(await s.waitFor((r) => r.id === 3)), NOT_ACCEPTED);
    assert.equal(a.sent('nobody answered'), false);
  } finally { s.close(); await a.close(); }
});

test('2025-11-25: stdin closes with the box open: nothing is sent', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await legacyReady(s, 'host went away');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    await s.waitFor((r) => r.method === 'elicitation/create');
    s.child.stdin.end();
    const t0 = Date.now();
    while (!s.exited && Date.now() - t0 < 5000) await sleep(20);
    assert.equal(s.exited, true);
    assert.equal(a.sent('host went away'), false);
    assert.equal(s.draftStatus(d.id), 'previewed');
  } finally { s.close(); await a.close(); }
});

test('a notification gets no response', async () => {
  const a = await api(); const s = server(a.url);
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
    await s.waitFor((r) => r.id === 1);
    s.send({ method: 'notifications/initialized' });
    s.send({ method: 'notifications/cancelled', params: { requestId: 99 } });
    s.send({ id: 2, method: 'tools/list' });
    await s.waitFor((r) => r.id === 2);
    assert.equal(s.rows.filter((r) => r.error && (r.id === undefined || r.id === null)).length, 0);
  } finally { s.close(); await a.close(); }
});

test('2026-07-28 (fixture, box counted as shown): the call returns input_required; the retry with Accept and the requestState delivers', async () => {
  const a = await api(); const s = server(a.url, {}, { stateless: 'box-shown' });
  try {
    const caps = { elicitation: { form: {} } };
    s.send({ id: 1, method: 'server/discover', params: { _meta: meta(caps), clientInfo: { name: 'claude-code', version: 'test' } } });
    await s.waitFor((r) => r.id === 1);
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'stateless and sent' }, _meta: meta(caps) } });
    const prep = await s.waitFor((r) => r.id === 2);
    assert.match(textOf(prep), /Send to @linus/);
    const d = draftOf(prep);
    await s.personTurn();
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: meta(caps) } });
    const first = (await s.waitFor((r) => r.id === 3)).result;
    assert.equal(first.resultType, 'input_required');
    const req = first.inputRequests.send_confirmation;
    assert.equal(req.method, 'elicitation/create');
    assert.equal(req.params.message, 'Send to @linus? (18 chars, all shown)\n> stateless and sent');
    assert.equal(req.params.mode, 'form');
    assert.equal(typeof first.requestState, 'string');
    assert.equal(first.content, undefined, 'nothing for the model in the input request');
    assert.equal(s.rows.some((r) => r.method === 'elicitation/create'), false, 'no server-to-client request on the stateless path');
    assert.equal(a.sent('stateless and sent'), false);
    s.send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: d, inputResponses: { send_confirmation: { action: 'accept', content: {} } }, requestState: first.requestState, _meta: meta(caps) } });
    const done = (await s.waitFor((r) => r.id === 4)).result;
    assert.equal(done.resultType, 'complete');
    assert.doesNotMatch(done.content[0].text, /^Not sent/);
    assert.equal(a.sent('stateless and sent'), true);
  } finally { s.close(); await a.close(); }
});

test('2026-07-28 (fixture, box counted as shown): a request that does not declare elicitation gets no box (the turn check, as before)', async () => {
  const a = await api(); const s = server(a.url, {}, { stateless: 'box-shown' });
  try {
    s.send({ id: 1, method: 'server/discover', params: { _meta: meta({}), clientInfo: { name: 'claude-code', version: 'test' } } });
    await s.waitFor((r) => r.id === 1);
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'no box declared' }, _meta: meta({}) } });
    const d = draftOf(await s.waitFor((r) => r.id === 2));
    await s.personTurn();
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: meta({}) } });
    const res = (await s.waitFor((r) => r.id === 3)).result;
    assert.equal(res.resultType, 'complete');
    assert.equal(a.sent('no box declared'), true);
  } finally { s.close(); await a.close(); }
});

test('a client without the capability, or on an older protocol, never gets a box', async () => {
  for (const init of [
    { protocolVersion: '2025-11-25', capabilities: {} },
    { protocolVersion: '2025-03-26', capabilities: { elicitation: {} } },
  ]) {
    const a = await api(); const s = server(a.url);
    try {
      s.send({ id: 1, method: 'initialize', params: { ...init, clientInfo: { name: 'claude-code', version: 'test' } } });
      await s.waitFor((r) => r.id === 1);
      s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'no box' } } });
      const d = draftOf(await s.waitFor((r) => r.id === 2));
      await s.personTurn();
      s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
      await s.waitFor((r) => r.id === 3);
      assert.equal(s.rows.some((r) => r.method === 'elicitation/create'), false, JSON.stringify(init));
      assert.equal(a.sent('no box'), true);
    } finally { s.close(); await a.close(); }
  }
});

test('2026-07-28 (fixture): the host is read from each request\'s _meta clientInfo (no discover, no env): prepare and send in one turn is refused, with no box', async () => {
  const a = await api(); const s = server(a.url, {}, { stateless: 'no-box' });
  try {
    const caps = { elicitation: { form: {} } };
    const m = { ...meta(caps), 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.330' } };
    const text = `one agent turn only: ${'long enough that the box shows only its start, so the turn check applies. '.repeat(2).trim()}`;
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: text }, _meta: m } });
    const d = draftOf(await s.waitFor((r) => r.id === 2));
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: m } });
    const res = (await s.waitFor((r) => r.id === 3)).result;
    assert.equal(res.resultType, 'complete', 'no input request');
    assert.match(res.content[0].text, /^Not sent yet:/);
    assert.equal(a.sent('one agent turn only'), false);
  } finally { s.close(); await a.close(); }
});

// ── as shipped: the box only where Claude Code is known to show it ──────────

/** What Claude Code 2.1.330 sends first (log of a real session, 2026-11-21). */
const CC_INFO = { name: 'claude-code', title: 'Claude Code', version: '2.1.330', description: "Anthropic's agentic coding tool", websiteUrl: 'https://claude.com/claude-code' };
const CC_DISCOVER = {
  id: 'server-discover-probe-1', method: 'server/discover',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': CC_INFO, 'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true }, elicitation: { form: {}, url: {} }, extensions: { 'io.modelcontextprotocol/tasks': {} } } } },
};

test('as shipped: server/discover is "Method not found" (-32601), so the stdio probe falls back to initialize; a stateless request gets -32022 naming the initialize-era versions', async () => {
  const a = await api(); const s = server(a.url);
  try {
    s.send(CC_DISCOVER);
    const discover = await s.waitFor((r) => r.id === 'server-discover-probe-1');
    assert.deepEqual(discover, { jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found: server/discover' } });
    s.send({ id: 7, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'stateless refused' }, _meta: meta({ elicitation: { form: {} } }) } });
    const refused = await s.waitFor((r) => r.id === 7);
    assert.deepEqual(refused, { jsonrpc: '2.0', id: 7, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: MODERN } } });
    s.send({ id: 8, method: 'tools/list', params: { _meta: meta({}) } });
    assert.equal((await s.waitFor((r) => r.id === 8)).error.code, -32022);
  } finally { s.close(); await a.close(); }
});

/** Exactly as Claude Code 2.1.330 opens: the discover probe, its error, then initialize 2025-11-25. */
async function claudeCodeReady(s, message) {
  s.send(CC_DISCOVER);
  assert.equal((await s.waitFor((r) => r.id === 'server-discover-probe-1')).error.code, -32601);
  s.send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } }, clientInfo: CC_INFO } });
  const init = (await s.waitFor((r) => r.id === 0)).result;
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.equal(init.serverInfo.name, 'vibe');
  assert.match(init.instructions, /Never send without the person's explicit choice/);
  s.send({ method: 'notifications/initialized' });
  s.send({ id: 1, method: 'tools/list' });
  assert.ok((await s.waitFor((r) => r.id === 1)).result.tools.some((t) => t.name === 'vibe_send'));
  s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message }, _meta: { 'claudecode/toolUseId': 'toolu_1', progressToken: 2 } } });
  const prep = await s.waitFor((r) => r.id === 2);
  assert.doesNotMatch(textOf(prep), /cannot show \/vibe's confirmation box/, 'the box will be shown');
  const d = draftOf(prep);
  // vibe_send in the same turn as the preview: the turn check refuses, with no box.
  s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
  assert.match(textOf(await s.waitFor((r) => r.id === 3)), /^Not sent yet:/);
  assert.equal(s.rows.some((r) => r.method === 'elicitation/create'), false);
  await s.personTurn();   // the person types "send"
  return d;
}

test('as Claude Code opens (discover -32601, initialize 2025-11-25): turn recorded, vibe_send opens the box with elicitation/create, Accept delivers', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await claudeCodeReady(s, 'the box, as shown');
    s.send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    assert.deepEqual(req.params, { message: 'Send to @linus? (17 chars, all shown)\n> the box, as shown', requestedSchema: { type: 'object', properties: {} }, mode: 'form' });
    assert.equal(a.sent('the box, as shown'), false, 'nothing before the answer');
    s.send({ id: req.id, result: { action: 'accept', content: {} } });
    const res = await s.waitFor((r) => r.id === 4);
    assert.match(textOf(res), /^Sent to \*\*@linus\*\*/);
    assert.equal(res.result.resultType, undefined, 'initialize-era results carry no stateless fields');
    assert.equal(a.sent('the box, as shown'), true);
    assert.equal(s.rows.some((r) => r.result && r.result.resultType === 'input_required'), false);
  } finally { s.close(); await a.close(); }
});

test('as Claude Code opens (discover -32601, initialize 2025-11-25): Decline in the box sends nothing', async () => {
  const a = await api(); const s = server(a.url);
  try {
    const d = await claudeCodeReady(s, 'declined in the box');
    s.send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: d } });
    const req = await s.waitFor((r) => r.method === 'elicitation/create');
    s.send({ id: req.id, result: { action: 'decline' } });
    assert.equal(textOf(await s.waitFor((r) => r.id === 4)), NOT_ACCEPTED);
    assert.equal(a.sent('declined in the box'), false);
    assert.equal(s.draftStatus(d.id), 'previewed');
  } finally { s.close(); await a.close(); }
});

test('2026-07-28 served (fixture) but no host seen to show its box: no input_required, the turn check alone, and an inputResponses "accept" never sends', async () => {
  const a = await api(); const s = server(a.url, {}, { stateless: 'no-box' });
  try {
    const caps = { elicitation: { form: {}, url: {} } };
    const m = { ...meta(caps), 'io.modelcontextprotocol/clientInfo': CC_INFO };
    s.send({ ...CC_DISCOVER, id: 1 });
    assert.equal((await s.waitFor((r) => r.id === 1)).result.resultType, 'complete');
    s.send({ id: 2, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'linus', message: 'no stateless box' }, _meta: m } });
    const prep = await s.waitFor((r) => r.id === 2);
    assert.match(textOf(prep), /This app cannot show \/vibe's confirmation box, so sending relies on your typed reply\./);
    const d = draftOf(prep);
    await s.personTurn();
    // What Claude Code 2.1.330 sent back with no box on screen, against a requestState it never got.
    const forged = Buffer.from(JSON.stringify({ v: 1, id: d.id, n: 'f'.repeat(32) })).toString('base64url');
    s.send({ id: 3, method: 'tools/call', params: { name: 'vibe_send', arguments: d, inputResponses: { send_confirmation: { action: 'accept', content: {} } }, requestState: forged, _meta: m } });
    assert.equal((await s.waitFor((r) => r.id === 3)).result.content[0].text, NOT_ACCEPTED);
    assert.equal(a.sent('no stateless box'), false);
    s.send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: d, _meta: m } });
    const res = (await s.waitFor((r) => r.id === 4)).result;
    assert.equal(res.resultType, 'complete', 'no input request');
    assert.match(res.content[0].text, /^Sent to \*\*@linus\*\*/);
    assert.equal(a.sent('no stateless box'), true);
  } finally { s.close(); await a.close(); }
});
