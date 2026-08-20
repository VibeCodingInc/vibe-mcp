#!/usr/bin/env node
/**
 * check-pack-closure — refuse to publish a tarball that can't boot.
 *
 * package.json `files` is a hand-maintained allowlist. index.js does an
 * UNCONDITIONAL top-level `require('./tools/meet')` (the VIBE_MEET_ENABLED gate
 * hides the tools, it does not skip the require), so a file that is present in
 * the repo but missing from `files` does not degrade — it throws
 * MODULE_NOT_FOUND at boot and the server never starts. That is worse than a
 * dormant verb: every `npx slashvibe-mcp` install is dead on arrival.
 *
 * This walks the static require/import closure from the real entrypoints
 * (package.json `main` + every `bin` target) and asserts each reachable file is
 * actually inside what `npm pack` would ship. It is a verifier, not a generator:
 * it never edits `files`, so it cannot silently widen the tarball.
 *
 * Usage:  node scripts/check-pack-closure.js [--json]   (also: npm run pack:check)
 * Wired into `prepack`, so `npm publish` runs it whether you remember to or not.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '..');
const pkg = require(path.join(PKG_DIR, 'package.json'));
const asJson = process.argv.includes('--json');

/** Files npm would actually ship, as paths relative to the package root. */
function packedFiles() {
  // --ignore-scripts is load-bearing: this script runs FROM prepack, and npm pack
  // would otherwise re-trigger prepack and recurse forever.
  const raw = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error('could not read file list from `npm pack --dry-run --json`');
  }
  // npm >=7 gives [{path}], older gives [string].
  return new Set(entry.files.map((f) => (typeof f === 'string' ? f : f.path)));
}

const RESOLVE_EXT = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs'];

/** Resolve a relative specifier the way Node would, or null if nothing exists. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Static relative deps only. Bare specifiers ('fs', 'zod') are Node/node_modules
// and are not our packaging problem.
const REQUIRE_RE = /\brequire\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
const IMPORT_RE = /\bfrom\s*['"](\.[^'"]*)['"]|\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
// require('./tools/' + name) — unresolvable statically; report rather than pretend.
const DYNAMIC_RE = /\brequire\s*\(\s*(?!['"])[^)]*\)|\bimport\s*\(\s*(?!['"])[^)]*\)/g;

function walk(entrypoints) {
  const seen = new Set();
  const missingOnDisk = [];
  const dynamic = [];
  const queue = [...entrypoints];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;

    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const specs = new Set();
    for (const m of src.matchAll(REQUIRE_RE)) specs.add(m[1]);
    for (const m of src.matchAll(IMPORT_RE)) specs.add(m[1] || m[2]);

    for (const spec of specs) {
      const resolved = resolveRelative(file, spec);
      if (resolved) queue.push(resolved);
      else missingOnDisk.push({ from: rel(file), spec });
    }

    const dyn = src.match(DYNAMIC_RE);
    if (dyn) dynamic.push({ file: rel(file), count: dyn.length });
  }

  return { closure: seen, missingOnDisk, dynamic };
}

const rel = (abs) => path.relative(PKG_DIR, abs).split(path.sep).join('/');

function main() {
  const entrySpecs = [pkg.main || 'index.js', ...Object.values(pkg.bin || {})];
  const entrypoints = [];
  const badEntries = [];

  for (const spec of entrySpecs) {
    const abs = path.resolve(PKG_DIR, spec);
    if (fs.existsSync(abs)) entrypoints.push(abs);
    else badEntries.push(spec); // e.g. a `bin` pointing at a file that doesn't exist
  }

  const { closure, missingOnDisk, dynamic } = walk(entrypoints);
  const packed = packedFiles();

  const notShipped = [...closure]
    .map(rel)
    .filter((f) => !packed.has(f))
    .sort();

  const result = {
    ok: notShipped.length === 0 && missingOnDisk.length === 0 && badEntries.length === 0,
    reachable: closure.size,
    packed: packed.size,
    notShipped,
    missingOnDisk,
    badEntries,
    dynamicRequires: dynamic,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (badEntries.length) {
    console.error('\n✗ package.json `bin`/`main` points at files that do not exist:');
    for (const b of badEntries) console.error(`    ${b}`);
  }

  if (missingOnDisk.length) {
    console.error('\n✗ require() targets that do not resolve on disk:');
    for (const m of missingOnDisk) console.error(`    ${m.from} → ${m.spec}`);
  }

  if (notShipped.length) {
    console.error(
      `\n✗ ${notShipped.length} file(s) are reachable at boot but NOT in the tarball.` +
        '\n  Publishing this would throw MODULE_NOT_FOUND on every install:\n'
    );
    for (const f of notShipped) console.error(`    ${f}`);
    console.error('\n  Fix: add them to the `files` array in mcp-server/package.json.');
  }

  if (!result.ok) {
    console.error('\n  (This check is why the publish stopped. It is not advisory.)\n');
    process.exit(1);
  }

  console.log(
    `✓ pack closure OK — ${closure.size} reachable file(s), all present in a ${packed.size}-file tarball.`
  );
  if (dynamic.length) {
    const total = dynamic.reduce((n, d) => n + d.count, 0);
    console.log(
      `  note: ${total} dynamic require/import(s) in ${dynamic.length} file(s) can't be followed statically —` +
        '\n  this check does not cover those. Run `npm run test:pack` for real boot proof.'
    );
    for (const d of dynamic) console.log(`    ${d.file} (${d.count})`);
  }
}

main();
