#!/usr/bin/env node
/**
 * RELEASE CONFORMANCE — run the artifact we are about to ship, against the service
 * we are about to ship it at.
 *
 * Every hermetic test passed while `npx slashvibe-mcp` told each new user
 * "Could not reach slashvibe.dev". Nothing was wrong with the code: /api/health
 * answers {"status":"healthy"} and the client demanded 'ok'. A unit test cannot see
 * that, because the disagreement only exists between two systems. Three code reviews
 * missed it; running the thing found it in ninety seconds.
 *
 * So this is not another unit test. It packs the real tarball, installs it under a
 * throwaway HOME, runs the actual command a person types, and asserts on what they
 * would see — plus the release-ordering checks that caught production advertising a
 * version npm had not published yet.
 *
 * Usage:  node scripts/release-conformance.mjs [--base https://www.slashvibe.dev]
 * Exit 0 = safe to publish/promote. Exit 1 = do not ship.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'https://www.slashvibe.dev';

// --registry: verify what npm ACTUALLY SERVES, not the tarball we just built.
// Without this the check proves "the thing on my disk works", which is not the
// question anyone is asking before sending invites.
const FROM_REGISTRY = process.argv.includes('--registry');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const localVersion = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;
console.log(`release conformance · slashvibe-mcp@${localVersion} · ${BASE}\n`);

// ── 1. the service answers what the client expects ─────────────────────────
let health;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10000) });
  health = { ok: r.ok, body: await r.json().catch(() => ({})) };
} catch (e) {
  health = { ok: false, body: { error: e.message } };
}
check('service health reachable', health.ok, `status=${JSON.stringify(health.body.status)}`);

// The bug itself, as a permanent check: whatever the server says, the SHIPPED
// client must accept it. Imported from the artifact, not reimplemented here.
const tmp = mkdtempSync(join(tmpdir(), 'vibe-release-'));
let tarball;
try {
  const args = FROM_REGISTRY
    ? ['pack', `slashvibe-mcp@${localVersion}`, '--pack-destination', tmp, '--silent']
    : ['pack', '--pack-destination', tmp, '--silent'];
  const out = execFileSync('npm', args, { cwd: PKG_DIR, encoding: 'utf8' }).trim();
  tarball = join(tmp, out.split('\n').pop());
  check(FROM_REGISTRY ? `registry serves ${localVersion}` : 'packs cleanly',
    existsSync(tarball), tarball.split('/').pop());
} catch (e) {
  check(FROM_REGISTRY ? `registry serves ${localVersion}` : 'packs cleanly', false, e.message);
}

// ── 2. install it the way a stranger would, under a HOME of its own ────────
const home = join(tmp, 'home');
const work = join(tmp, 'work');
execFileSync('mkdir', ['-p', home, work]);
let installed = false;
try {
  execFileSync('npm', ['install', tarball, '--silent', '--no-audit', '--no-fund'], {
    cwd: work, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  installed = existsSync(join(work, 'node_modules/slashvibe-mcp/package.json'));
} catch (e) { /* reported below */ }
check('installs from the packed artifact', installed);

if (installed) {
  const mod = join(work, 'node_modules/slashvibe-mcp');

  // ── 3. the SHIPPED connection test accepts the LIVE service ──────────────
  // This is #115. Not a copy of the logic — the artifact's own function.
  let accepts = false;
  process.env.VIBE_SETUP_NO_AUTORUN = '1';   // BEFORE the import: loading must not run it
  try {
    const setup = await import(join(mod, 'setup.js'));
    accepts = await setup.testConnection();
  } catch (e) {
    // fall through as a failure
  }
  check('shipped client accepts the live health response', accepts,
    accepts ? '' : 'the client and the server disagree — this is the #115 shape');

  // ── 4. it boots as an MCP server and reports its own version ─────────────
  let boots = false, serverVersion = null;
  try {
    const out = execFileSync('node', [join(mod, 'index.js')], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } } }) + '\n',
      encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: home },
    });
    const line = out.split('\n').find((l) => l.includes('"serverInfo"'));
    serverVersion = line ? JSON.parse(line).result.serverInfo.version : null;
    boots = !!serverVersion;
  } catch (e) { /* reported below */ }
  check('boots and completes an MCP handshake', boots, serverVersion ? `serverInfo ${serverVersion}` : '');
  check('artifact version matches package version', serverVersion === localVersion,
    `${serverVersion} vs ${localVersion}`);

  // ── 4b. the REAL setup walk, as a person runs it ─────────────────────────
  // Calling testConnection() and findClaudeConfig() is not the same as running
  // setup: it skips the ordering, the printing, and every step in between. This
  // runs the actual entry point in a pty with browser-opening stubbed, and reads
  // what a human would see.
  let walk = '';
  try {
    const walkHome = join(tmp, 'walkhome');
    execFileSync('mkdir', ['-p', walkHome]);
    // Run setup.js — the `vibe-setup` bin, a real documented entry point — rather
    // than cli.js. cli.js branches on process.stdin.isTTY, so exercising it needs a
    // pty, and a pty is exactly the kind of scaffolding that fails quietly and lets a
    // check "pass" on an empty log. This runs the same walk with nothing in between.
    // VIBE_SETUP_NO_AUTORUN was set earlier in this process so the module could be
    // INSPECTED without running. Inheriting it here would suppress the very walk this
    // check exists to observe — and it did, silently, producing an empty log that the
    // first version of the check read as "no output captured". Explicitly cleared.
    const walkEnv = { ...process.env, HOME: walkHome, VIBE_SETUP_STUB_BROWSER: '1' };
    delete walkEnv.VIBE_SETUP_NO_AUTORUN;
    const child = spawn('node', [join(mod, 'setup.js')], {
      env: walkEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { walk += d.toString(); });
    child.stderr.on('data', (d) => { walk += d.toString(); });
    await new Promise((r) => setTimeout(r, 18000));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    walk = walk.replace(/\x1b\[[0-9;]*m/g, '');
  } catch { /* reported below */ }
  check('the real setup walk reaches the sign-in step',
    /Step 4|Waiting for authentication|browser/i.test(walk),
    walk ? '' : '(no output captured)');
  check('the walk does not report a connection failure',
    walk !== '' && !/Could not reach/i.test(walk),
    /Could not reach/i.test(walk) ? 'printed "Could not reach" — this is #115' : '');

  // ── 5. it does not claim hosts it has not found ──────────────────────────
  let claimsAbsentHost = null;
  try {
    const setup = await import(join(mod, 'setup.js'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;                       // HOME has no coding agent in it
    claimsAbsentHost = setup.findClaudeConfig() !== null;
    process.env.HOME = prevHome;
  } catch (e) { /* leave null */ }
  check('does not report a host that is not installed', claimsAbsentHost === false,
    claimsAbsentHost === null ? '(could not evaluate)' : '');
}

// ── 6. release ordering: never advertise what is not downloadable ──────────
let liveVersion = null, npmLatest = null;
try {
  const r = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(10000) });
  liveVersion = (await r.json().catch(() => ({}))).version ?? null;
} catch { /* null */ }
try {
  const r = await fetch('https://registry.npmjs.org/slashvibe-mcp', { signal: AbortSignal.timeout(10000) });
  npmLatest = (await r.json())['dist-tags']?.latest ?? null;
} catch { /* null */ }
// DIRECTION MATTERS, and the first version of this check ignored it.
//
// Dangerous: production advertises a version npm cannot serve — we tell people about
// something they cannot install. That is the ordering bug this check exists for.
// Benign: npm is AHEAD of production, which is just deploy propagation after a publish.
// Users can install and it works; the site catches up in a minute. Blocking on that
// would mean a check that fails every time we do the thing correctly.
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};
const advertisesTooMuch = !!(liveVersion && npmLatest && cmp(liveVersion, npmLatest) > 0);
check('production does not advertise a version npm cannot serve',
  !advertisesTooMuch,
  `live=${liveVersion} npm=${npmLatest}` +
    (liveVersion && npmLatest && cmp(npmLatest, liveVersion) > 0 ? ' — npm ahead, deploy still propagating (benign)' : ''));

rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nDO NOT SHIP — failing:');
  for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
console.log('safe to publish/promote');
