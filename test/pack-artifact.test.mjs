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

// The default MCP tool surface (coreTools). A fresh install shows only the pre-auth
// subset until `vibe init` (progressive disclosure), and admin tools appear only
// under VIBE_ADMIN=true — so we assert the default surface hermetically from the
// installed coreTools registration, and separately assert the server BOOTS and its
// pre-auth surface is a subset of this set. Kept explicit so any surface change is
// a visible test edit.
// 0.8 core mode: the registration is split into kernelTools (always on) and
// extraTools (registered only under VIBE_EXTRAS=1). The full culture surface
// is kernel + extras — identical to the 0.7.1 twenty tools.
const EXPECTED_KERNEL = [
  'vibe_bye', 'vibe_dm', 'vibe_help', 'vibe_inbox', 'vibe_init', 'vibe_reply',
  'vibe_start', 'vibe_status', 'vibe_token', 'vibe_who',
  // The four verbs of the communications runtime (canon PR #333 / epic #329):
  // the manifest plus remember/reflect/call; message is dm/inbox/reply above.
  'vibe_capabilities', 'vibe_call', 'vibe_reflect', 'vibe_remember',
  // Opt-in people list (vibe-mcp#28): browse, list yourself, unlist yourself.
  'vibe_people', 'vibe_list_me', 'vibe_unlist_me',
].sort();
const EXPECTED_EXTRAS = [
  'vibe_corpse', 'vibe_email', 'vibe_fable', 'vibe_feed', 'vibe_game',
  'vibe_intro', 'vibe_play', 'vibe_poem', 'vibe_ship', 'vibe_weave',
].sort();

let workDir;   // throwaway root: install + isolated HOME
let installedCli;
let installedDir; // node_modules/slashvibe-mcp

// The MCP tool surfaces the INSTALLED artifact exposes. index.js splits
// registration into `kernelTools` (always on), `extraTools` (only when
// VIBE_EXTRAS=1), and `adminTools` (only when VIBE_ADMIN=true). We parse each
// object literal and load each module — keeping those with a definition.name.
// Hermetic (leaf modules, no server boot) and a per-module closure check: a
// module whose deps were left out of the pack throws on require.
function toolsFromBlock(startMarker, endMarker) {
  const req = createRequire(pathToFileURL(path.join(installedDir, 'index.js')));
  const idx = readFileSync(path.join(installedDir, 'index.js'), 'utf8');
  const block = idx.slice(idx.indexOf(startMarker), idx.indexOf(endMarker));
  assert.ok(block.includes('vibe_'), `could not locate the registration block at ${startMarker}`);
  const names = new Set();
  for (const m of block.matchAll(/(vibe_\w+)\s*:\s*require\(\s*['"](\.\/tools\/[\w-]+)['"]\s*\)/g)) {
    const mod = req(m[2]);
    if (mod && mod.definition && mod.definition.name) names.add(mod.definition.name);
  }
  return [...names].sort();
}

function kernelToolsFromInstall() {
  return toolsFromBlock('const kernelTools = {', 'const EXTRAS_ENABLED');
}

function extraToolsFromInstall() {
  return toolsFromBlock('const extraTools = {', 'const adminTools');
}

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
  // Pre-auth surface (progressive disclosure) must be a subset of the default
  // (kernel) registration.
  const registered = new Set(kernelToolsFromInstall());
  const stray = preAuth.filter(n => !registered.has(n));
  assert.deepEqual(stray, [], `pre-auth surface exposes unregistered tools: ${stray.join(', ')}`);
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

test('installed artifact registers exactly the expected tool surfaces', () => {
  // Read hermetically from the shipped index.js — no auth needed, so this is
  // stable regardless of whether a fresh env is signed in.
  assert.deepEqual(kernelToolsFromInstall(), EXPECTED_KERNEL,
    'kernel surface drift vs EXPECTED_KERNEL — update this list only when the registration intentionally changes');
  assert.deepEqual(extraToolsFromInstall(), EXPECTED_EXTRAS,
    'extras surface drift vs EXPECTED_EXTRAS — update this list only when the registration intentionally changes');
});

// Help drift, both modes: whatever mode the server is in, every `vibe X` help
// advertises must be registered IN THAT MODE. With extras off, extras must not
// be advertised in command form; with extras on, they may.
async function assertHelpMatchesSurface(extras, registered) {
  const r = await rpc([
    INIT, INITED,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vibe_help', arguments: { topic: 'commands' } } },
  ], { extras });
  const text = JSON.stringify(r[3]?.result || '');
  assert.ok(text.length > 20, 'vibe_help returned nothing to check');
  const advertised = new Set();
  for (const m of text.matchAll(/vibe (\w[\w-]*)/g)) {
    const base = m[1];
    if (base === 'help' || /^[A-Z]/.test(base)) continue; // meta + heading words like "Commands"
    advertised.add(base);
  }
  const orphan = [...advertised].filter(b => !registered.has(`vibe_${b}`));
  assert.deepEqual(orphan, [],
    `help (extras=${extras}) advertises commands with no registered tool: ${orphan.map(b => `vibe ${b}`).join(', ')}`);
}

test('help advertises no command that is not a registered tool (drift guard, kernel)', async () => {
  await assertHelpMatchesSurface(false, new Set(kernelToolsFromInstall()));
});

test('help advertises no command that is not a registered tool (drift guard, extras)', async () => {
  await assertHelpMatchesSurface(true, new Set([...kernelToolsFromInstall(), ...extraToolsFromInstall()]));
});

// The same guard, on the surface people actually read. vibe_help was protected while
// the BOARD rotated a suggestion advertising `play` — a tool 0.8.0 moved behind
// VIBE_EXTRAS — so a default session was routinely told to use something it does not
// have. Any tool whose output suggests a command belongs here, not just help.
test('the presence board suggests no command that is not registered', async () => {
  const registered = new Set(kernelToolsFromInstall());
  const src = readFileSync(path.join(installedDir, 'tools/who.js'), 'utf8');
  // Suggestions are written as `say "<verb> ..."` or bare `"<verb> with @handle"`.
  const suggested = new Set();
  for (const m of src.matchAll(/["`]\s*(?:say\s+")?(\w[\w-]*)\s+(?:with\s+)?@?handle/g)) {
    suggested.add(m[1].toLowerCase());
  }
  const orphan = [...suggested].filter((v) => !registered.has(`vibe_${v}`));
  assert.deepEqual(orphan, [],
    `the board suggests commands with no registered tool: ${orphan.map((v) => `vibe ${v}`).join(', ')}`);
});

test('restored play tools still read their legacy payload types (existing-session compat)', async () => {
  // Byte-identical restore, but assert the compat readers are present in the shipped code.
  const grep = (file, needle) => {
    const p = path.join(workDir, 'proj', 'node_modules', 'slashvibe-mcp', 'tools', file);
    const src = execFileSync('cat', [p], { encoding: 'utf8' });
    return src.includes(needle);
  };
  assert.ok(grep('game.js', "=== 'game'"), 'game.js lost its legacy game-payload reader');
  assert.ok(grep('poem.js', "=== 'poem'"), 'poem.js lost its legacy poem-payload reader');
  assert.ok(grep('corpse.js', "=== 'corpse'"), 'corpse.js lost its legacy corpse-payload reader');
});
