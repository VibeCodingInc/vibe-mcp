/**
 * Stage, wait, then promote: `latest` only ever names a tarball npm serves.
 *
 * 0.9.22–0.9.24 each became `latest` while the registry still answered 404
 * for the tarball. The publish job now publishes under `next`, and
 * scripts/promote-when-served.mjs moves `latest` only after the exact tarball
 * downloads and matches the registry's digest. Every case here runs against a
 * fake fetch, a fake clock and a recording `npm` — nothing touches the network.
 *
 * Run: node --test test/promote-when-served.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  promoteWhenServed, checkLatest, compareVersions, isPrerelease, checkDigest,
} from '../scripts/promote-when-served.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REG = 'https://registry.example';
const PKG = 'slashvibe-mcp';
const TARBALL = Buffer.from('pretend this is a gzipped tarball');
const dist = (bytes = TARBALL) => ({
  tarball: `${REG}/${PKG}/-/${PKG}-0.9.25.tgz`,
  shasum: createHash('sha1').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
});

/**
 * A registry in miniature. `latest` is the dist-tag; `tarballStatuses` is
 * consumed one per tarball request (last one repeats); `metaDist` is what the
 * version document says the tarball's digest is.
 */
function fakeRegistry({ latest = '0.9.24', tarballStatuses = [200], metaStatus = 200, metaDist = dist(), bytes = TARBALL } = {}) {
  const calls = [];
  const statuses = [...tarballStatuses];
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  });
  const fetch = async (url) => {
    calls.push(url);
    if (url === `${REG}/${PKG}`) return res(200, { 'dist-tags': { latest: typeof latest === 'function' ? latest() : latest } });
    if (url === `${REG}/${PKG}/0.9.25` || url.startsWith(`${REG}/${PKG}/0.`)) {
      return metaStatus === 200 ? res(200, { version: '0.9.25', dist: metaDist }) : res(metaStatus, {});
    }
    if (url.endsWith('.tgz')) {
      const s = statuses.length > 1 ? statuses.shift() : statuses[0];
      return res(s, {});
    }
    return res(500, {});
  };
  return { fetch, calls };
}

function harness(overrides = {}) {
  let t = 0;
  const sleeps = [];
  const execs = [];
  const out = [];
  const opts = {
    pkg: PKG,
    version: '0.9.25',
    registry: REG,
    firstDelayMs: 15_000,
    maxDelayMs: 120_000,
    timeoutMs: 45 * 60_000,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    exec: (cmd, args) => { execs.push([cmd, ...args].join(' ')); },
    log: (s) => out.push(s),
    error: (s) => out.push(s),
    ...overrides,
  };
  return { opts, sleeps, execs, out, text: () => out.join('\n') };
}

test('tarball 404 then 200: waits with backoff, verifies the digest, then promotes', async () => {
  const reg = fakeRegistry({ tarballStatuses: [404, 404, 404, 200] });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'promoted');
  assert.equal(r.code, 0);
  assert.deepEqual(h.execs, ['npm dist-tag add slashvibe-mcp@0.9.25 latest']);
  assert.deepEqual(h.sleeps, [15_000, 22_500, 33_750], 'backoff grows ×1.5');
  assert.equal(reg.calls.filter((u) => u.endsWith('.tgz')).length, 4);
  assert.match(h.text(), /tarball HTTP 404/);
  assert.match(h.text(), /digest matches/);
});

test('version metadata 404 also counts as not served yet', async () => {
  let n = 0;
  const reg = fakeRegistry();
  const fetch = async (url, o) => (url === `${REG}/${PKG}/0.9.25` && n++ < 2
    ? { ok: false, status: 404, json: async () => ({}) }
    : reg.fetch(url, o));
  const h = harness({ fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'promoted');
  assert.equal(h.sleeps.length, 2);
});

test('sha mismatch: fails, does not promote', async () => {
  const reg = fakeRegistry({ metaDist: dist(Buffer.from('a different tarball')) });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'sha-mismatch');
  assert.equal(r.code, 1);
  assert.deepEqual(h.execs, [], 'latest must not move');
  assert.match(h.text(), /integrity mismatch/);
  assert.match(h.text(), /shasum mismatch/);
  assert.match(h.text(), /`latest` was NOT moved/);
});

test('timeout: fails after the deadline without promoting, says how to promote by hand', async () => {
  const reg = fakeRegistry({ tarballStatuses: [404] });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.code, 1);
  assert.deepEqual(h.execs, []);
  const waited = h.sleeps.reduce((a, b) => a + b, 0);
  assert.equal(waited, 45 * 60_000, 'waits exactly the full window, no more');
  assert.ok(Math.max(...h.sleeps) <= 120_000, 'backoff is capped');
  assert.match(h.text(), /published, under the dist-tag `next`/);
  assert.match(h.text(), /`latest` was NOT moved/);
  assert.match(h.text(), /npm dist-tag add slashvibe-mcp@0\.9\.25 latest/);
});

test('network errors while waiting are retried, not fatal', async () => {
  let n = 0;
  const reg = fakeRegistry();
  const fetch = async (url, o) => {
    if (url.endsWith('.tgz') && n++ === 0) throw new Error('ECONNRESET');
    return reg.fetch(url, o);
  };
  const h = harness({ fetch });
  assert.equal((await promoteWhenServed(h.opts)).outcome, 'promoted');
});

test('already promoted: no-op on rerun, no wait, no npm call', async () => {
  const reg = fakeRegistry({ latest: '0.9.25', tarballStatuses: [404] });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'already-latest');
  assert.equal(r.code, 0);
  assert.deepEqual(h.execs, []);
  assert.deepEqual(h.sleeps, []);
});

test('lower than current latest: refuses before waiting', async () => {
  const reg = fakeRegistry({ latest: '0.10.0' });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'refused-lower');
  assert.equal(r.code, 1);
  assert.deepEqual(h.execs, []);
  assert.equal(reg.calls.filter((u) => u.endsWith('.tgz')).length, 0);
});

test('a newer latest that lands while waiting is not overwritten', async () => {
  let reads = 0;
  const reg = fakeRegistry({ latest: () => (reads++ === 0 ? '0.9.24' : '0.9.26'), tarballStatuses: [404, 200] });
  const h = harness({ fetch: reg.fetch });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'refused-lower');
  assert.deepEqual(h.execs, []);
});

test('prerelease: stays on next, never promoted', async () => {
  const reg = fakeRegistry();
  const h = harness({ fetch: reg.fetch, version: '0.9.25-rc.1' });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'prerelease-stays-next');
  assert.equal(r.code, 0);
  assert.deepEqual(h.execs, []);
});

test('npm dist-tag refusing (e.g. OIDC without dist-tag permission): fails loudly with the fix', async () => {
  const reg = fakeRegistry();
  const h = harness({ fetch: reg.fetch, exec: () => { throw new Error('E403 Forbidden'); } });
  const r = await promoteWhenServed(h.opts);
  assert.equal(r.outcome, 'promote-failed');
  assert.equal(r.code, 1);
  assert.match(h.text(), /Allow npm dist-tag/);
  assert.match(h.text(), /npm dist-tag add slashvibe-mcp@0\.9\.25 latest/);
});

test('check-latest: passes on equality (after propagation), fails otherwise', async () => {
  let reads = 0;
  const conv = fakeRegistry({ latest: () => (reads++ < 2 ? '0.9.24' : '0.9.25') });
  const sleeps = [];
  const ok = await checkLatest({ pkg: PKG, version: '0.9.25', registry: REG, fetch: conv.fetch, retries: 5, sleep: async (ms) => sleeps.push(ms), log() {}, error() {} });
  assert.equal(ok.code, 0);
  assert.equal(sleeps.length, 2);

  const stale = fakeRegistry({ latest: '0.9.24' });
  const bad = await checkLatest({ pkg: PKG, version: '0.9.25', registry: REG, fetch: stale.fetch, retries: 3, sleep: async () => {}, log() {}, error() {} });
  assert.equal(bad.code, 1);
  assert.equal(bad.latest, '0.9.24');

  const pre = await checkLatest({ pkg: PKG, version: '0.9.25-rc.1', registry: REG, fetch: stale.fetch, retries: 1, sleep: async () => {}, log() {}, error() {} });
  assert.equal(pre.code, 0, 'a prerelease passes when latest is not it');
});

test('semver: precedence including prereleases', () => {
  assert.ok(compareVersions('0.10.0', '0.9.99') > 0);
  assert.ok(compareVersions('0.9.25', '0.9.25-rc.1') > 0);
  assert.ok(compareVersions('0.9.25-rc.2', '0.9.25-rc.10') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
  assert.equal(compareVersions('0.9.25', 'v0.9.25'), 0);
  assert.ok(isPrerelease('0.9.25-next.0'));
  assert.ok(!isPrerelease('0.9.25+build.7'));
});

test('digest check needs something to check against', () => {
  assert.equal(checkDigest(TARBALL, {}).ok, false);
  assert.equal(checkDigest(TARBALL, dist()).ok, true);
});

test('the workflow stages under next, promotes in its own job, and verifies latest after', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  const jobs = wf.split(/\n  (?=[a-z-]+:\n)/);
  const publishJob = jobs.find((j) => /^publish:/.test(j));
  const promoteJob = jobs.find((j) => /^promote:/.test(j));
  const verifyJob = jobs.find((j) => /^verify:/.test(j));
  assert.ok(publishJob && promoteJob && verifyJob, 'publish, promote and verify jobs exist');
  const code = (s) => s.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  assert.match(code(publishJob), /npm publish --provenance --access public --tag next/);
  assert.ok(!/dist-tag add/.test(code(publishJob)), 'publish job never moves latest');
  assert.match(promoteJob, /needs:\s*publish/);
  assert.match(code(promoteJob), /node scripts\/promote-when-served\.mjs/);
  assert.match(code(promoteJob), /id-token:\s*write/);
  assert.match(verifyJob, /needs:\s*\[\s*publish\s*,\s*promote\s*\]/);
  assert.match(code(verifyJob), /promote-when-served\.mjs --check-latest/);
});
