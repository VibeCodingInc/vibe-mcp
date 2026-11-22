#!/usr/bin/env node
/**
 * STAGE, WAIT, THEN PROMOTE — `latest` only ever names a tarball npm serves.
 *
 * Why (0.9.22, 0.9.23, 0.9.24): `npm publish` made the new version `latest`
 * at once, but the registry answered 404 for its tarball for roughly 10–25
 * minutes. In that window `npx slashvibe-mcp@latest` could fail to load and
 * the post-publish verify job failed and had to be rerun by hand.
 *
 * So the publish job now publishes under the holding dist-tag `next`, and this
 * script (run in the `promote` job):
 *   1. refuses a prerelease (it stays on `next`, exit 0) and a version lower
 *      than the current `latest` (exit 1); does nothing if `latest` already
 *      names this version (idempotent rerun, exit 0);
 *   2. polls the version's registry metadata and its tarball with backoff, for
 *      up to --timeout-min minutes (default 45); every time the tarball comes
 *      back 200 it is downloaded and checked against the metadata's
 *      dist.integrity and dist.shasum — a mismatch fails without promoting;
 *   3. re-reads `latest` (someone may have promoted something newer meanwhile)
 *      and only then runs `npm dist-tag add <pkg>@<version> latest`.
 * A timeout fails the job and leaves `latest` where it was.
 *
 * Second mode, --check-latest (used by the verify job): exit 0 only when the
 * registry's dist-tags.latest equals --version (retried, the packument is
 * cached at the edge); a prerelease passes when `latest` is NOT it.
 *
 * Usage:
 *   node scripts/promote-when-served.mjs --version 0.9.25
 *     [--package slashvibe-mcp] [--registry https://registry.npmjs.org]
 *     [--timeout-min 45] [--dry-run]
 *   node scripts/promote-when-served.mjs --check-latest --version 0.9.25
 *     [--retries 10] [--interval-ms 15000]
 *
 * Dependency-free on purpose: it runs before `npm install` matters and every
 * side effect (fetch, the npm command, sleep, the clock) is injectable so the
 * tests drive it with fakes.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ── semver, just enough: MAJOR.MINOR.PATCH[-pre][+build] ───────────────────
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

export const isPrerelease = (v) => (parseVersion(v)?.pre.length ?? 0) > 0;

/** <0 if a<b, 0 if equal, >0 if a>b (semver precedence; build metadata ignored). */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a semver version: ${!pa ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length; // release > prerelease
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── integrity ───────────────────────────────────────────────────────────────
/** Check bytes against dist.integrity (SRI, any of its hashes) and dist.shasum (sha1 hex). */
export function checkDigest(bytes, dist = {}) {
  const problems = [];
  let checked = 0;
  if (dist.integrity) {
    const entries = String(dist.integrity).trim().split(/\s+/);
    const ok = entries.some((entry) => {
      const [algo, expected] = entry.split(/-(.*)/s);
      if (!['sha512', 'sha384', 'sha256', 'sha1'].includes(algo)) return false;
      checked++;
      return createHash(algo).update(bytes).digest('base64') === expected;
    });
    if (!ok) problems.push(`integrity mismatch (registry says ${dist.integrity})`);
  }
  if (dist.shasum) {
    checked++;
    const got = createHash('sha1').update(bytes).digest('hex');
    if (got !== String(dist.shasum).toLowerCase()) problems.push(`shasum mismatch (registry ${dist.shasum}, downloaded ${got})`);
  }
  if (!checked) problems.push('registry metadata carries no dist.integrity or dist.shasum to check against');
  return { ok: problems.length === 0, problems };
}

// ── the registry, read without credentials ──────────────────────────────────
const NO_CACHE = { 'cache-control': 'no-cache', accept: 'application/json' };

async function readLatest(fetchImpl, registry, pkg) {
  const r = await fetchImpl(`${registry}/${pkg}`, { headers: NO_CACHE });
  if (!r.ok) throw new Error(`packument HTTP ${r.status}`);
  const body = await r.json();
  return body?.['dist-tags']?.latest ?? null;
}

async function readVersionDoc(fetchImpl, registry, pkg, version) {
  const r = await fetchImpl(`${registry}/${pkg}/${version}`, { headers: NO_CACHE });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`version metadata HTTP ${r.status}`);
  return r.json();
}

const tarballName = (pkg, version) => `${pkg.split('/').pop()}-${version}.tgz`;
export const defaultTarballUrl = (registry, pkg, version) => `${registry}/${pkg}/-/${tarballName(pkg, version)}`;
export const handPromoteCommand = (pkg, version) => `npm dist-tag add ${pkg}@${version} latest`;

function defaultExec(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

/**
 * Wait for the tarball, verify it, then move `latest`.
 * Returns { outcome, code } — code is the process exit code.
 */
export async function promoteWhenServed({
  pkg = 'slashvibe-mcp',
  version,
  registry = 'https://registry.npmjs.org',
  timeoutMs = 45 * 60_000,
  firstDelayMs = 15_000,
  maxDelayMs = 120_000,
  dryRun = false,
  fetch: fetchImpl = globalThis.fetch,
  exec = defaultExec,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
  error = console.error,
} = {}) {
  registry = registry.replace(/\/+$/, '');
  if (!parseVersion(version)) {
    error(`✗ --version ${JSON.stringify(version)} is not a semver version`);
    return { outcome: 'bad-version', code: 1 };
  }
  const handCmd = handPromoteCommand(pkg, version);

  if (isPrerelease(version)) {
    log(`${pkg}@${version} is a prerelease: it stays on \`next\` and never becomes \`latest\`. Nothing to promote.`);
    return { outcome: 'prerelease-stays-next', code: 0 };
  }

  // Guard rails before waiting: rerun no-op, and never move `latest` backwards.
  const guard = async (when) => {
    let latest;
    try { latest = await readLatest(fetchImpl, registry, pkg); } catch (e) {
      error(`✗ could not read ${pkg} dist-tags (${when}): ${e.message}`);
      return { outcome: 'registry-unreadable', code: 1 };
    }
    if (latest === version) {
      log(`\`latest\` already names ${pkg}@${version} — nothing to do.`);
      return { outcome: 'already-latest', code: 0 };
    }
    if (latest && parseVersion(latest) && compareVersions(version, latest) < 0) {
      error(`✗ refusing to promote ${pkg}@${version}: it is lower than the current \`latest\` (${latest}).
  The version stays published under \`next\`; \`latest\` was NOT moved.`);
      return { outcome: 'refused-lower', code: 1 };
    }
    log(`current \`latest\` is ${latest ?? '(none)'}; ${version} may replace it (${when}).`);
    return null;
  };
  const early = await guard('before waiting');
  if (early) return early;

  // Wait for the tarball npx will fetch, and prove its bytes.
  const start = now();
  const deadline = start + timeoutMs;
  let delay = firstDelayMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    const elapsed = Math.round((now() - start) / 1000);
    let status = '';
    try {
      const doc = await readVersionDoc(fetchImpl, registry, pkg, version);
      if (!doc) {
        status = 'version metadata not served yet (404)';
      } else {
        const url = doc.dist?.tarball || defaultTarballUrl(registry, pkg, version);
        const r = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
        if (r.ok) {
          const bytes = Buffer.from(await r.arrayBuffer());
          const digest = checkDigest(bytes, doc.dist);
          if (!digest.ok) {
            error(`✗ ${url} downloaded (${bytes.length} bytes) but does not match the registry metadata:
  ${digest.problems.join('\n  ')}
  ${pkg}@${version} stays under \`next\`; \`latest\` was NOT moved. Investigate before promoting by hand:
    ${handCmd}`);
            return { outcome: 'sha-mismatch', code: 1 };
          }
          log(`✓ attempt ${attempt} (+${elapsed}s): ${url} served, ${bytes.length} bytes, digest matches the registry metadata`);
          break;
        }
        status = `tarball HTTP ${r.status} (${url})`;
      }
    } catch (e) {
      status = `request failed: ${e.message}`;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      error(`✗ gave up after ${Math.round(timeoutMs / 60_000)} min (${attempt} attempts): ${status}
  ${pkg}@${version} IS published, under the dist-tag \`next\`.
  \`latest\` was NOT moved — people on @latest still get the previous version.
  When the tarball downloads, promote by hand:
    ${handCmd}
  or rerun this workflow's failed jobs.`);
      return { outcome: 'timeout', code: 1 };
    }
    const wait = Math.min(delay, remaining);
    log(`… attempt ${attempt} (+${elapsed}s): ${status}; next try in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    delay = Math.min(Math.round(delay * 1.5), maxDelayMs);
  }

  // Re-check right before moving the tag: a newer release may have landed.
  const late = await guard('before promoting');
  if (late) return late;

  if (dryRun) {
    log(`dry run: would run \`${handCmd}\``);
    return { outcome: 'dry-run', code: 0 };
  }
  try {
    exec('npm', ['dist-tag', 'add', `${pkg}@${version}`, 'latest']);
  } catch (e) {
    error(`✗ \`${handCmd}\` failed: ${e.message}
  ${pkg}@${version} is published and downloadable under \`next\`; \`latest\` was NOT moved.
  With trusted publishing, dist-tag changes need "Allow npm dist-tag" enabled on this
  package's trusted publisher (npmjs.com → package → Settings → Trusted Publisher) and
  npm 11.21.0+ in the job. Or an owner promotes by hand:
    ${handCmd}`);
    return { outcome: 'promote-failed', code: 1 };
  }
  log(`✓ promoted: \`latest\` → ${pkg}@${version}`);
  return { outcome: 'promoted', code: 0 };
}

/** Verify-job check: dist-tags.latest equals the released version (prerelease: does not). */
export async function checkLatest({
  pkg = 'slashvibe-mcp',
  version,
  registry = 'https://registry.npmjs.org',
  retries = 10,
  intervalMs = 15_000,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
  error = console.error,
} = {}) {
  registry = registry.replace(/\/+$/, '');
  const pre = isPrerelease(version);
  let latest = null;
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
    try { latest = await readLatest(fetchImpl, registry, pkg); } catch (e) { latest = `(unreadable: ${e.message})`; }
    const ok = pre ? latest !== version : latest === version;
    if (ok) {
      log(pre
        ? `✓ ${version} is a prerelease and \`latest\` is ${latest}, not it`
        : `✓ dist-tags.latest = ${latest}`);
      return { ok: true, latest, code: 0 };
    }
    log(`attempt ${attempt}/${retries}: dist-tags.latest = ${latest}, want ${pre ? `anything but ${version}` : version}`);
    if (attempt < retries) await sleep(intervalMs);
  }
  error(`✗ dist-tags.latest is ${latest}, expected ${pre ? `not ${version}` : version}`);
  return { ok: false, latest, code: 1 };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : dflt; };
  const common = {
    pkg: arg('--package', 'slashvibe-mcp'),
    version: arg('--version'),
    registry: arg('--registry', 'https://registry.npmjs.org'),
  };
  const result = argv.includes('--check-latest')
    ? await checkLatest({ ...common, retries: Number(arg('--retries', '10')), intervalMs: Number(arg('--interval-ms', '15000')) })
    : await promoteWhenServed({ ...common, timeoutMs: Number(arg('--timeout-min', '45')) * 60_000, dryRun: argv.includes('--dry-run') });
  process.exit(result.code);
}
