#!/usr/bin/env node
/**
 * VERSION PARITY — production and npm advertise the same installable truth.
 *
 * Parity means EQUALITY, eventually. Direction still matters for the message,
 * not the verdict:
 *   live > npm — production advertises a version npm cannot serve; people are
 *   told about something they cannot install.
 *   npm > live — normally deploy propagation after a publish, and it must
 *   CONVERGE within the retry window. A permanently stale or failed deploy
 *   (npm 0.8.18, live 0.8.17 forever) is a release problem, and a job named
 *   "parity" that stays green through it would be lying (#14 review).
 *
 * WHY THIS IS ITS OWN SCRIPT (the 0.8.17 deadlock): this check used to run
 * inside release-conformance.mjs, which gates the PRE-publish path. Merging
 * to main auto-deploys production, so by the time the release tag ran the
 * publish workflow, production already said 0.8.17 while npm still served
 * 0.8.16 — and the pre-publish gate failed on the exact condition that only
 * the publish it was blocking could clear. Parity is a POST-publish /
 * post-deploy verification, so it lives here and runs after `npm publish`,
 * where a mismatch is a loud red job instead of a deadlock.
 *
 * Usage:
 *   node scripts/version-parity.mjs
 *     [--base https://www.slashvibe.dev]     production /api/version source
 *     [--npm-meta-url <url>]                 npm packument (test stubbing)
 *     [--retries N] [--interval-ms M]        tolerate propagation, then fail
 *
 * Exit 0 = both sides readable and EQUAL (within the retry window).
 * Exit 1 = any remaining mismatch in either direction, or an unreadable side,
 * after the final retry — report loudly with both versions, page a human.
 */

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', 'https://www.slashvibe.dev');
const NPM_META_URL = arg('--npm-meta-url', 'https://registry.npmjs.org/slashvibe-mcp');
const RETRIES = Number(arg('--retries', '1'));
const INTERVAL_MS = Number(arg('--interval-ms', '30000'));

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};

async function readVersions() {
  let liveVersion = null, npmLatest = null;
  try {
    const r = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(10000) });
    liveVersion = (await r.json().catch(() => ({}))).version ?? null;
  } catch { /* null */ }
  try {
    const r = await fetch(NPM_META_URL, { signal: AbortSignal.timeout(10000) });
    npmLatest = (await r.json())['dist-tags']?.latest ?? null;
  } catch { /* null */ }
  return { liveVersion, npmLatest };
}

let last = { liveVersion: null, npmLatest: null };
const attempts = Math.max(1, RETRIES);
for (let attempt = 1; attempt <= attempts; attempt++) {
  last = await readVersions();
  const { liveVersion, npmLatest } = last;
  if (liveVersion !== null && npmLatest !== null && cmp(liveVersion, npmLatest) === 0) {
    console.log(`✓ version parity  live=${liveVersion} npm=${npmLatest}`);
    process.exit(0);
  }
  if (liveVersion === null || npmLatest === null) {
    console.log(`attempt ${attempt}/${attempts}: could not read both versions (live=${liveVersion} npm=${npmLatest})`);
  } else if (cmp(liveVersion, npmLatest) > 0) {
    console.log(`attempt ${attempt}/${attempts}: live=${liveVersion} npm=${npmLatest} — production ahead of npm`);
  } else {
    console.log(`attempt ${attempt}/${attempts}: live=${liveVersion} npm=${npmLatest} — npm ahead, waiting for the deploy to converge`);
  }
  if (attempt < attempts) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

const direction =
  last.liveVersion === null || last.npmLatest === null
    ? 'A side is unreadable.'
    : cmp(last.liveVersion, last.npmLatest) > 0
      ? 'Production advertises a version npm cannot serve — every "npx slashvibe-mcp" the site suggests installs something older than promised. Complete the publish for the live version, or roll the deploy back to the published one.'
      : 'npm is ahead and production never converged — the deploy failed or is permanently stale. Fix or roll forward the deploy so the site advertises what npm serves.';

console.error(`
✗ VERSION PARITY FAILED after ${attempts} attempt(s)
  live=${last.liveVersion}  npm=${last.npmLatest}

  ${direction}
`);
process.exit(1);
