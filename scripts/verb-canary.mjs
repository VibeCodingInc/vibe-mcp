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

// Deterministic expectations (review P2: no vacuous matching): the canary
// pins each verb to ONE expected state on any machine — off flags make
// remember/reflect/call machine-independent; the synthetic credential makes
// message granted. Each verb must appear exactly once WITH a reason.
const CONTROLLED_ENV = { VIBE_REMEMBER: 'off', VIBE_REFLECT: 'off', VIBE_CALL: 'off' };
const EXPECTED = { remember: 'off', reflect: 'off', call: 'off', message: 'granted' };

const hosts = {
  'claude-code': { CLAUDECODE: '1', ...CONTROLLED_ENV },
  codex: { CODEX_HOME: mkdtempSync(join(tmpdir(), 'codex-home-')), ...CONTROLLED_ENV },
};

let failed = false;
for (const [name, env] of Object.entries(hosts)) {
  const r = await runHost(name, env);
  const missing = VERBS.filter((v) => !r.tools.includes(v));
  const states = [...r.manifestText.matchAll(/(remember|reflect|message|call) — (\w+) · (.+)/g)];
  const seen = new Map(states.map(([, verb, state, why]) => [verb, { state, why }]));
  const problems = [];
  if (states.length !== 4) problems.push(`expected 4 state lines, saw ${states.length}`);
  for (const [verb, want] of Object.entries(EXPECTED)) {
    const got = seen.get(verb);
    if (!got) problems.push(`${verb}: missing`);
    else {
      if (!LEGAL.has(got.state)) problems.push(`${verb}: illegal state ${got.state}`);
      if (got.state !== want) problems.push(`${verb}: expected ${want}, got ${got.state}`);
      if (!got.why || got.why.trim().length < 5) problems.push(`${verb}: no reason given`);
    }
  }
  if (missing.length) problems.push(`missing tools: ${missing}`);
  if (r.tools.includes('vibe_mind')) problems.push('retired vibe_mind still listed');
  if (r.tools.includes('vibe_doctor')) problems.push('admin doctor leaked into default list');
  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${r.tools.length} tools; ${[...seen].map(([v, g]) => `${v}=${g.state}`).join(' ')}${ok ? '' : '; PROBLEMS: ' + problems.join(' | ')}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
