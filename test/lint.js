#!/usr/bin/env node

/**
 * Basic lint checks for slashvibe-mcp
 * Checks for common issues without requiring eslint as a dependency.
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('\nSlashvibe MCP — Lint Checks\n');

// ── No secrets in source ──

test('no hardcoded API keys in source files', () => {
  const files = ['index.js', 'config.js', 'presence.js', 'memory.js'];
  const patterns = [/sk-[a-zA-Z0-9]{20,}/, /ghp_[a-zA-Z0-9]{20,}/, /AIza[a-zA-Z0-9]{20,}/];
  for (const file of files) {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const pattern of patterns) {
      assert(!pattern.test(content), `possible API key found in ${file}`);
    }
  }
});

// ── Required files ──

test('all files in package.json "files" array exist', () => {
  const pkg = require('../package.json');
  const missing = [];
  for (const f of pkg.files) {
    const fullPath = path.join(__dirname, '..', f);
    if (!fs.existsSync(fullPath)) missing.push(f);
  }
  assert(missing.length === 0, `missing: ${missing.join(', ')}`);
});

// ── JSON validity ──

test('package.json is valid JSON', () => {
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
});

test('server.json is valid JSON', () => {
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server.json'), 'utf-8'));
});

test('glama.json is valid JSON', () => {
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'glama.json'), 'utf-8'));
});

// ── Version consistency ──

test('package.json and server.json versions match', () => {
  const pkg = require('../package.json');
  const server = require('../server.json');
  assert(pkg.version === server.version, `package.json=${pkg.version}, server.json=${server.version}`);
});

// ── Shebang ──

test('index.js has node shebang', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
  assert(content.startsWith('#!/usr/bin/env node'), 'missing shebang');
});

// ── Results ──

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
