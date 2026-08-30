#!/usr/bin/env node
/**
 * Runtime-kernel canary (epic #329 acceptance 1 + 3): boot the REAL MCP
 * server over stdio under Claude Code and Codex host environments; verify
 * the four verbs + manifest register and every capability reports a legal,
 * reasoned state. Machine-verifiable; exits non-zero on any dishonesty.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBS = ['vibe_capabilities', 'vibe_remember', 'vibe_reflect', 'vibe_call', 'vibe_dm', 'vibe_inbox', 'vibe_reply'];
const LEGAL = new Set(['granted', 'available', 'off', 'unavailable']);

function rpc(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function runHost(name, env) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), `verb-canary-${name}-`));
    // A synthetic signed-in principal (same shape the test suite uses) so the
    // canary sees the POST-auth surface; nothing here can reach the network.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      username: 'canary',
      authMethod: 'github',
      authToken: `h.${b64({ sub: 'canary', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
      one_liner: 'verb canary',
    }));
    const child = spawn('node', [join(ROOT, 'index.js')], {
      env: { ...process.env, ...env, VIBE_HOME: home, VIBE_SETUP_NO_AUTORUN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const results = {};
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name}: timeout`)); }, 15000);
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 2) {
          results.tools = (msg.result?.tools || []).map((t) => t.name);
          rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vibe_capabilities', arguments: {} } });
        } else if (msg.id === 3) {
          const text = msg.result?.content?.[0]?.text || '';
          results.manifestText = text;
          clearTimeout(timer); child.kill();
          resolve(results);
        }
      }
    });
    child.on('error', reject);
    rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1' } } });
  });
}

const hosts = {
  'claude-code': { CLAUDECODE: '1' },
  codex: { CODEX_HOME: mkdtempSync(join(tmpdir(), 'codex-home-')) },
};

let failed = false;
for (const [name, env] of Object.entries(hosts)) {
  const r = await runHost(name, env);
  const missing = VERBS.filter((v) => !r.tools.includes(v));
  const states = [...r.manifestText.matchAll(/(remember|reflect|message|call) — (\w+)/g)];
  const badStates = states.filter(([, , s]) => !LEGAL.has(s));
  const ok = missing.length === 0 && states.length === 4 && badStates.length === 0
    && !r.tools.includes('vibe_mind') && !r.tools.includes('vibe_doctor');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${r.tools.length} tools; verbs ${VERBS.length - missing.length}/${VERBS.length}; states ${states.map(([, v, s]) => `${v}=${s}`).join(' ')}${missing.length ? `; MISSING ${missing}` : ''}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
