/**
 * The 0.8.17 release deadlock can never come back.
 *
 * The sequence, replayed exactly: merge to main → production auto-deploys and
 * /api/version says 0.8.17 → the tag push runs the publish workflow → the
 * PRE-publish gate compared live(0.8.17) > npm(0.8.16) and exited 1 — the
 * publish was blocked by the exact condition that only publishing could
 * clear. (Shipping 0.8.17 required a manual `vercel promote` rollback around
 * the gate.)
 *
 * Pins, each executable:
 *   1. The extracted parity script, fed the exact 0.8.17 state via local HTTP
 *      stubs, fails LOUDLY (exit 1, named versions) — right answer, wrong
 *      place fixed by WHERE it now runs.
 *   2. npm-ahead (the benign propagation direction) passes.
 *   3. The pre-publish path no longer reads npm at all: release-conformance
 *      has no registry fetch, so the deadlock input cannot reach the gate.
 *   4. The publish workflow runs parity only in a job that `needs: publish` —
 *      ordering proven from the workflow file, not assumed.
 *
 * Run: node --test test/release-deadlock.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

function stubServer({ live, npm }) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/version')) {
      res.end(JSON.stringify({ version: live }));
    } else if (req.url.startsWith('/npm-meta')) {
      res.end(JSON.stringify({ 'dist-tags': { latest: npm } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => server.close() });
    });
  });
}

async function parity({ live, npm }) {
  const { base, close } = await stubServer({ live, npm });
  try {
    return await run('node', [
      join(ROOT, 'scripts/version-parity.mjs'),
      '--base', base,
      '--npm-meta-url', `${base}/npm-meta`,
      '--retries', '1',
    ]).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e) => ({ code: e.code, out: (e.stdout || '') + (e.stderr || '') })
    );
  } finally {
    close();
  }
}

test('the exact 0.8.17 state (live ahead of npm) fails LOUDLY post-publish', async () => {
  const r = await parity({ live: '0.8.17', npm: '0.8.16' });
  assert.equal(r.code, 1, 'a real mismatch must be a red job');
  assert.match(r.out, /VERSION PARITY FAILED/, 'the failure announces itself');
  assert.match(r.out, /0\.8\.17/, 'names the live version');
  assert.match(r.out, /0\.8\.16/, 'names the npm version');
});

test('npm ahead of production (post-publish propagation) is benign', async () => {
  const r = await parity({ live: '0.8.16', npm: '0.8.17' });
  assert.equal(r.code, 0, 'the direction publishing correctly creates must pass');
  assert.match(r.out, /benign/);
});

test('exact parity passes', async () => {
  const r = await parity({ live: '0.8.17', npm: '0.8.17' });
  assert.equal(r.code, 0);
});

test('the PRE-publish gate no longer reads npm — the deadlock input is unreachable', () => {
  const conformance = readFileSync(join(ROOT, 'scripts/release-conformance.mjs'), 'utf8');
  // npm pack --registry mode is fine (it reads a tarball); the deadlock input
  // was the PACKUMENT fetch that compared dist-tags against production.
  assert.ok(
    !conformance.includes('registry.npmjs.org/slashvibe-mcp'),
    'release-conformance fetches the npm packument again — the deadlock is back'
  );
  assert.ok(
    !/advertise/.test(conformance) || /moved/.test(conformance),
    'the ordering check belongs to version-parity.mjs now'
  );
});

test('the publish workflow orders parity strictly AFTER npm publish', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  // The publish job must not invoke the parity script.
  const jobs = wf.split(/\n  (?=[a-z-]+:\n)/); // crude job split, stable for this file
  const publishJob = jobs.find((j) => j.includes('npm publish --provenance'));
  assert.ok(publishJob, 'publish job found');
  assert.ok(
    !publishJob.includes('version-parity'),
    'parity ran inside the publish job — pre-publish deadlock shape'
  );
  // The verify job runs parity and depends on publish. Anchor on the RUN
  // step, not the filename — the workflow's header comment also names the
  // script (that comment tricked the first version of this find()).
  const verifyJob = jobs.find((j) => j.includes('run: node scripts/version-parity.mjs'));
  assert.ok(verifyJob, 'a job runs the parity script');
  assert.match(verifyJob, /needs:\s*publish/, 'parity job must need: publish');
  // And the registry-mode conformance runs there too — post-publish proof.
  assert.match(verifyJob, /release-conformance\.mjs --registry/);
});
