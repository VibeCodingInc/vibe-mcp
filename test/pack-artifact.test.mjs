// Hermetic packed-artifact test.
//
// Guards the three ways the packaged server has silently broken before:
//   1. files-allowlist incompleteness — a required module not in `files` passes
//      when run from the repo but throws on a clean install. So we pack + install
//      into a throwaway dir and boot from THERE, not from the source tree.
//   2. surface drift — asserts the installed server exposes exactly the expected
//      registered tools.
//   3. help drift — asserts every `vibe X` command help advertises maps to a
//      registered tool, so help can't drift back to listing tools that don't ship.
//
// Hermetic: HOME and VIBE_HOME point at a temp dir, so no real ~/.vibe config
// hydrates (an earlier smoke test read the real @brightseth identity — this does not).
//
// Run: node --test test/pack-artifact.test.mjs   (also: npm run test:pack)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let workDir;   // throwaway root: install + isolated HOME
let installedCli;
let installedDir; // node_modules/slashvibe-mcp

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'vibe-pack-'));
  // 1. pack from the server dir into workDir
  const packOut = execFileSync('npm', ['pack', SERVER_DIR, '--pack-destination', workDir], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tgz = readdirSync(workDir).find(f => f.endsWith('.tgz'));
  assert.ok(tgz, `npm pack produced no tarball (got: ${packOut})`);
  // 2. install the tarball into a clean project under workDir
  const proj = path.join(workDir, 'proj');
  execFileSync('mkdir', ['-p', proj]);
  execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  execFileSync('npm', ['install', path.join(workDir, tgz), '--no-audit', '--no-fund', '--no-save'], {
    cwd: proj, stdio: 'ignore',
  });
  installedDir = path.join(proj, 'node_modules', 'slashvibe-mcp');
  installedCli = path.join(installedDir, 'cli.js');
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// Drive the installed server over newline-delimited JSON-RPC on stdio, hermetically.
// VIBE_EXTRAS is scrubbed from the inherited env so the default surface is
// deterministic regardless of the dev machine; pass extras:true to opt in.
function rpc(messages, { timeoutMs = 15000, extras = false } = {}) {
  return new Promise((resolve, reject) => {
    const home = path.join(workDir, 'home');
    execFileSync('mkdir', ['-p', home]);
    const env = { ...process.env, HOME: home, VIBE_HOME: path.join(home, '.vibe') }; // hermetic
    delete env.VIBE_EXTRAS;
    if (extras) env.VIBE_EXTRAS = '1';
    const child = spawn('node', [installedCli], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(parse(out)); }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    // give it a beat, then close stdin so it can flush and exit
    setTimeout(() => { try { child.stdin.end(); } catch {} }, timeoutMs - 2000);
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

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-test', version: '1' } } };
const INITED = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('installs from the tarball and boots (files allowlist is complete)', async () => {
  // Booting from a clean install is what proves no required module was left out of
  // the `files` allowlist — running from the repo would hide such a gap.
  const r = await rpc([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.ok(r[1]?.result, 'server did not respond to initialize — a required file may be missing from the pack');
  const preAuth = (r[2]?.result?.tools || []).map(t => t.name);
  assert.ok(preAuth.length > 0, 'installed server exposed no tools on boot');
});

test('installed artifact exposes both documented executable shims', () => {
  // npm can leave the script files in the tarball while dropping invalid `bin`
  // metadata. A module-level boot still passes in that state, but the command a
  // person actually runs (`npx slashvibe-mcp`) does not exist.
  const binDir = path.join(workDir, 'proj', 'node_modules', '.bin');
  assert.ok(existsSync(path.join(binDir, 'slashvibe-mcp')),
    'installed package has no slashvibe-mcp executable shim');
  assert.ok(existsSync(path.join(binDir, 'vibe-setup')),
    'installed package has no vibe-setup executable shim');
});

test('installed artifact can install, run, and remove the read-only SessionStart hook', () => {
  const home = path.join(workDir, 'hook-home');
  const claudeConfig = path.join(home, '.claude');
  const settingsFile = path.join(claudeConfig, 'settings.json');
  const fixture = path.join(home, 'waiting.json');
  execFileSync('mkdir', ['-p', claudeConfig]);
  writeFileSync(settingsFile, `${JSON.stringify({ model: 'sonnet' }, null, 2)}\n`);
  writeFileSync(fixture, JSON.stringify({
    messages: [{ id: 'msg_pack_hook', from: 'maya', text: 'The packed hook works.' }],
  }));
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeConfig,
    VIBE_HOME: path.join(home, '.vibe'),
  };

  execFileSync(process.execPath, [installedCli, 'hook', 'install'], { env, stdio: 'pipe' });
  const installed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(installed.model, 'sonnet');
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.match(installed.hooks.SessionStart[0].hooks[0].command,
    /^npx -y slashvibe-mcp@\d+\.\d+\.\d+ hook run$/);

  // Reinstall is idempotent, including after the exact command has shipped in a tarball.
  execFileSync(process.execPath, [installedCli, 'hook', 'install'], { env, stdio: 'pipe' });
  const reinstalled = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(reinstalled.hooks.SessionStart.length, 1);

  const output = JSON.parse(execFileSync(process.execPath, [installedCli, 'hook', 'run'], {
    encoding: 'utf8',
    env: { ...env, VIBE_SESSION_START_FIXTURE: fixture },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
  }));
  assert.match(output.systemMessage, /no delivery receipt written; may appear again/);
  assert.match(output.hookSpecificOutput.additionalContext, /The packed hook works\./);

  execFileSync(process.execPath, [installedCli, 'hook', 'uninstall'], { env, stdio: 'pipe' });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { model: 'sonnet' });
});

test('installed MCP artifact cannot raise native desktop notifications', () => {
  // Buddy owns Mac background continuity and notification. The MCP process owns
  // delivery into the active terminal session; shipping a second macOS notifier
  // here makes one DM speak twice and lets a dead Buddy pass its lifecycle gate.
  assert.equal(existsSync(path.join(installedDir, 'notify.js')), false,
    'the packed MCP artifact still ships its retired desktop notifier');

  const pending = [installedDir];
  const offenders = [];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = readFileSync(file, 'utf8');
        if (/\bosascript\b|display notification|terminal-notifier/i.test(source)) {
          offenders.push(path.relative(installedDir, file));
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `the MCP artifact contains native desktop notification code: ${offenders.join(', ')}`);
});

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function spawnInstalledServer() {
  const vibeHome = path.join(workDir, 'lifecycle-vibe');
  execFileSync('mkdir', ['-p', vibeHome]);
  // A primary config, even empty, prevents the backward-compat loader from
  // consulting the developer machine's legacy ~/.vibecodings identity.
  writeFileSync(path.join(vibeHome, 'config.json'), '{}');
  return spawn('node', [installedCli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VIBE_HOME: vibeHome },
  });
}

test('installed MCP process exits when its host closes stdin', async () => {
  const child = spawnInstalledServer();
  const exited = waitForExit(child);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('installed MCP process handles host termination gracefully', async () => {
  const child = spawnInstalledServer();
  const exited = waitForExit(child);
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('the installed artifact exposes exactly the surface: six tools and sign-in plumbing', async () => {
  const src = readFileSync(path.join(installedDir, 'index.js'), 'utf8');
  const registered = [...src.matchAll(/^\s{2}(vibe_[a-z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(registered, ['vibe_discard', 'vibe_init', 'vibe_people', 'vibe_prepare', 'vibe_send', 'vibe_start', 'vibe_thread', 'vibe_token']);
  const r = await rpc([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.deepEqual((r[2]?.result?.tools || []).map((t) => t.name).sort(),
    ['vibe_init', 'vibe_people', 'vibe_send', 'vibe_start', 'vibe_thread', 'vibe_token']);
});

test('the installed artifact ships the arrival hook, and it runs with no dependencies', () => {
  const hook = path.join(installedDir, 'hooks', 'arrival-hook.cjs');
  const out = execFileSync('node', [hook], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    env: { ...process.env, VIBE_ARRIVALS_DIR: path.join(workDir, 'no-such-spool') }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { suppressOutput: true });
});
