#!/usr/bin/env node
/**
 * sync-room-tone-tokens — package the repo-owned ROOM TONE tokens.
 *
 * MCP Apps must be self-contained, while an installed npm package cannot read
 * the platform repository's root files. Copy the canonical JSON twin into the
 * package before packing; tests require byte-for-byte equality so this generated
 * adapter cannot become a second hand-maintained palette.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '..');
// Resolve the canonical tokens from whichever layout this tree is in:
//   - standalone public repo: the source-of-record lives at the repo root;
//   - generated monorepo mirror: it lives one level up, at the platform root.
// The file is byte-identical in both, so this script (and its byte-identity
// with the mirror) holds in either context.
const source = [
  path.resolve(PKG_DIR, 'vibe-tokens.json'),
  path.resolve(PKG_DIR, '..', 'vibe-tokens.json'),
].find((p) => fs.existsSync(p));
if (!source) {
  console.error('sync-room-tone-tokens: no canonical vibe-tokens.json found');
  process.exit(1);
}
const target = path.join(PKG_DIR, 'resources', 'vibe-tokens.json');
const canonical = fs.readFileSync(source);
const current = fs.existsSync(target) ? fs.readFileSync(target) : null;

if (!current || !current.equals(canonical)) {
  fs.writeFileSync(target, canonical);
  console.log('sync-room-tone-tokens: resources/vibe-tokens.json updated');
} else {
  console.log('sync-room-tone-tokens: resources/vibe-tokens.json current');
}
