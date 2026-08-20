/**
 * MCP protocol layer tests — spec 2026-07-28 dual-era behavior.
 *
 * Boots the real server (node cli.js) hermetically (temp HOME/VIBE_HOME, so no
 * real ~/.vibe identity hydrates) and drives it over newline-delimited
 * JSON-RPC on stdio, asserting:
 *   - server/discover answers with supported versions + capabilities (the
 *     MUST-implement of 2026-07-28, and the stdio backward-compat probe)
 *   - legacy initialize echoes a known client version instead of pinning
 *     2024-11-05
 *   - modern requests (_meta protocolVersion) get resultType + serverInfo
 *     _meta + CacheableResult fields
 *   - unsupported modern versions get UnsupportedProtocolVersionError (-32022)
 *   - ui://vibe/presence-board serves as an MCP App resource, and vibe_who
 *     declares it via _meta.ui.resourceUri
 *
 * Run with: node --test tools/_mcp-protocol.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..');
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const modernMeta = (version) => ({ _meta: { [META_VERSION]: version || '2026-07-28' } });

let workDir;
let responses; // byId map, filled once in before()

// Drive the server over stdio, hermetically; resolves to {id: message}.
function rpc(messages, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = path.join(workDir, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn('node', [path.join(SERVER_DIR, 'cli.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, VIBE_HOME: path.join(home, '.vibe') }
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(parse(out)); }, timeoutMs);
    child.stdout.on('data', d => {
      out += d.toString();
      // Resolve early once every request id has a response line.
      const byId = parse(out);
      if (messages.every(m => m.id === undefined || byId[m.id])) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(byId);
      }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
  function parse(text) {
    const byId = {};
    for (const line of text.split('\n')) {
      const s = line.trim(); if (!s) continue;
      try { const m = JSON.parse(s); if (m.id != null) byId[m.id] = m; } catch {}
    }
    return byId;
  }
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'vibe-protocol-'));
  responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'protocol-test', version: '1' } } },
    { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: 'not-a-version', capabilities: {}, clientInfo: { name: 'protocol-test', version: '1' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: modernMeta() },
    { jsonrpc: '2.0', id: 5, method: 'tools/list', params: modernMeta('1900-01-01') },
    { jsonrpc: '2.0', id: 6, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://vibe/presence-board' } },
    { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'ui://vibe/nope' } },
    { jsonrpc: '2.0', id: 9, method: 'server/discover', params: modernMeta('1900-01-01') }
  ]);
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('server/discover advertises versions, capabilities, and the ui extension', () => {
  const r = responses[1]?.result;
  assert.ok(r, 'no server/discover response');
  assert.equal(r.resultType, 'complete');
  assert.ok(r.supportedVersions.includes('2026-07-28'), 'missing modern version');
  assert.ok(r.supportedVersions.includes('2025-06-18'), 'missing legacy version (dual-era)');
  assert.ok(r.capabilities.tools, 'missing tools capability');
  assert.ok(r.capabilities.resources, 'missing resources capability');
  assert.deepEqual(
    r.capabilities.extensions['io.modelcontextprotocol/ui'],
    { mimeTypes: ['text/html;profile=mcp-app'] }
  );
  assert.equal(r._meta[META_SERVER_INFO].name, 'vibe');
  assert.equal(typeof r.ttlMs, 'number');
});

test('legacy initialize echoes a known client version (no more 2024-11-05 pin)', () => {
  assert.equal(responses[2]?.result?.protocolVersion, '2025-06-18');
  // Unknown requested version falls back to our latest legacy revision.
  assert.equal(responses[3]?.result?.protocolVersion, '2025-11-25');
  assert.equal(responses[2].result.serverInfo.name, 'vibe');
});

test('modern requests get resultType, serverInfo _meta, and cache fields', () => {
  const r = responses[4]?.result;
  assert.ok(r, 'no modern tools/list response');
  assert.equal(r.resultType, 'complete');
  assert.equal(r._meta[META_SERVER_INFO].name, 'vibe');
  // Hermetic env is unauthenticated: the pre-auth list must NOT be cacheable —
  // sign-in swaps the toolset and modern clients have no invalidation stream.
  assert.equal(r.ttlMs, 0);
  assert.equal(r.cacheScope, 'private');
  assert.ok(Array.isArray(r.tools) && r.tools.length > 0, 'no tools listed');
});

test('unsupported modern version returns UnsupportedProtocolVersionError', () => {
  const e = responses[5]?.error;
  assert.ok(e, 'expected an error for an unsupported version');
  assert.equal(e.code, -32022);
  assert.deepEqual(e.data.supported, ['2026-07-28']);
  assert.equal(e.data.requested, '1900-01-01');
  // The gate applies to server/discover too — no success under a protocol the
  // client didn't request. (_meta-less probes still get a DiscoverResult.)
  assert.equal(responses[9]?.error?.code, -32022);
});

test('presence board ships as an MCP App resource', () => {
  const listed = responses[6]?.result?.resources || [];
  assert.equal(listed[0]?.uri, 'ui://vibe/presence-board');
  const content = responses[7]?.result?.contents?.[0];
  assert.ok(content, 'resources/read returned nothing');
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.ok(content.text.toLowerCase().startsWith('<!doctype html'), 'not an HTML document');
  assert.ok(content._meta.ui, 'missing _meta.ui on the resource content');
});

test('unknown resource is -32602 (2026-07-28 realignment)', () => {
  assert.equal(responses[8]?.error?.code, -32602);
});

test('vibe_who declares the presence board via _meta.ui.resourceUri', () => {
  const tools = responses[4]?.result?.tools || [];
  const who = tools.find(t => t.name === 'vibe_who');
  assert.ok(who, 'vibe_who not in pre-auth tools/list');
  assert.equal(who._meta?.ui?.resourceUri, 'ui://vibe/presence-board');
});
