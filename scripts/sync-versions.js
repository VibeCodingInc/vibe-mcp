#!/usr/bin/env node
/**
 * sync-versions — one version fact, stated once (package.json).
 *
 * server.json (the MCP registry manifest) is pure metadata, so its two version
 * fields are REWRITTEN from package.json — it sat at 0.5.18 for four releases
 * because nobody remembers a second file. version.json carries hand-written
 * release notes (changelog/features read by auto-update, vibe_start, doctor),
 * so it can't be generated: its version is VERIFIED instead, and a mismatch
 * fails the pack with instructions.
 *
 * Runs from `prepack` (manual-publish safety net) AND from the `version`
 * lifecycle script, which stages server.json into the release commit itself —
 * so the sync is durable in the repo, not just in the packed artifact.
 * Release flow: update version.json's notes first, then `npm version <bump>`
 * (the verify below fails the bump until the notes exist).
 *
 * Usage:  node scripts/sync-versions.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(PKG_DIR, f), 'utf8'));

const { version } = read('package.json');

// server.json: rewrite in place, preserving everything but the version fields.
// Dirty-tracking covers every field (top-level AND packages[]) so a stale
// nested version can't skip the write behind a matching top-level one.
const serverJson = read('server.json');
let dirty = false;
const bump = (obj) => {
  if (obj.version !== version) { obj.version = version; dirty = true; }
};
bump(serverJson);
for (const p of serverJson.packages || []) bump(p);
if (dirty) {
  fs.writeFileSync(
    path.join(PKG_DIR, 'server.json'),
    JSON.stringify(serverJson, null, 2) + '\n'
  );
  console.log(`sync-versions: server.json -> ${version}`);
} else {
  console.log(`sync-versions: server.json already at ${version}`);
}

// version.json: verify only — the changelog inside it needs a human.
const versionJson = read('version.json');
if (versionJson.version !== version) {
  console.error(
    `\n✗ version.json says ${versionJson.version} but package.json says ${version}.\n` +
      '  version.json carries the release notes that auto-update and vibe_start\n' +
      '  show users — update its version, changelog, and features for this\n' +
      '  release, then pack again. (This check is why the publish stopped.)\n'
  );
  process.exit(1);
}
console.log(`sync-versions: version.json OK at ${version}`);
