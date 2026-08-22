#!/usr/bin/env node
/**
 * VERSION PARITY — production and npm advertise the same installable truth.
 *
 * Direction-aware, exactly like the check it was extracted from:
 *   Dangerous: production advertises a version npm cannot serve — people are
 *   told about something they cannot install.
 *   Benign: npm is ahead of production — deploy propagation after a publish;
 *   installs work, the site catches up.
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
 * Exit 0 = parity (or benign npm-ahead). Exit 1 = production advertises a
 * version npm cannot serve — report loudly, page a human.
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
for (let attempt = 1; attempt <= Math.max(1, RETRIES); attempt++) {
  last = await readVersions();
  const { liveVersion, npmLatest } = last;
  if (liveVersion === null || npmLatest === null) {
    console.log(`attempt ${attempt}: could not read both versions (live=${liveVersion} npm=${npmLatest})`);
  } else if (cmp(liveVersion, npmLatest) > 0) {
    console.log(`attempt ${attempt}: live=${liveVersion} npm=${npmLatest} — production is ahead of npm`);
  } else {
    const benign = cmp(npmLatest, liveVersion) > 0
      ? ' — npm ahead, deploy still propagating (benign)' : '';
    console.log(`✓ version parity  live=${liveVersion} npm=${npmLatest}${benign}`);
    process.exit(0);
  }
  if (attempt < RETRIES) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

console.error(`
✗ VERSION PARITY FAILED after ${Math.max(1, RETRIES)} attempt(s)
  live=${last.liveVersion}  npm=${last.npmLatest}

  Production advertises a version npm cannot serve (or a side is unreadable).
  Every "npx slashvibe-mcp" the site suggests will install something older
  than what it promises. Fix by completing the npm publish for the live
  version, or rolling the deploy back to the published one.
`);
process.exit(1);
