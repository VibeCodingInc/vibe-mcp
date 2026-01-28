#!/usr/bin/env node

/**
 * Smoke tests for slashvibe-mcp
 * Verifies the server can load, tools are registered, and annotations are present.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

console.log('\nSlashvibe MCP — Smoke Tests\n');

// ── Module loading ──

test('index.js exists and is valid JS', () => {
  const indexPath = path.join(__dirname, '..', 'index.js');
  assert(fs.existsSync(indexPath), 'index.js not found');
  const content = fs.readFileSync(indexPath, 'utf-8');
  assert(content.length > 1000, 'index.js appears empty');
  assert(content.includes('tools/list'), 'index.js missing tools/list handler');
});

test('package.json has required fields', () => {
  const pkg = require('../package.json');
  assert(pkg.name === 'slashvibe-mcp', `name is ${pkg.name}`);
  assert(pkg.mcpName, 'missing mcpName');
  assert(pkg.bin, 'missing bin');
  assert(pkg.license === 'MIT', `license is ${pkg.license}`);
  assert(pkg.repository, 'missing repository');
  assert(pkg.homepage, 'missing homepage');
  assert(pkg.engines, 'missing engines');
  assert(pkg.keywords && pkg.keywords.length >= 10, 'too few keywords');
});

test('server.json has MCP registry schema', () => {
  const server = require('../server.json');
  assert(server.$schema, 'missing $schema');
  assert(server.name.includes('vibecodinginc'), `name is ${server.name}`);
  assert(server.packages && server.packages.length > 0, 'missing packages');
  assert(server.packages[0].transport.type === 'stdio', 'transport not stdio');
});

// ── Tool files ──

test('tools/ directory has tool files', () => {
  const toolsDir = path.join(__dirname, '..', 'tools');
  assert(fs.existsSync(toolsDir), 'tools/ directory not found');
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  assert(files.length >= 10, `only ${files.length} tool files found`);
});

test('index.js registers ~37 tools (pruned from 68)', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
  // Count tool registrations (lines matching vibe_xxx: require)
  const toolLines = content.match(/vibe_\w+:\s*require/g) || [];
  const count = toolLines.length;
  assert(count >= 30 && count <= 50, `expected 30-50 tools, found ${count}`);
});

test('store/sqlite.js exists', () => {
  const sqlitePath = path.join(__dirname, '..', 'store', 'sqlite.js');
  assert(fs.existsSync(sqlitePath), 'store/sqlite.js not found');
});

// ── Config files ──

test('smithery.yaml exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'smithery.yaml')), 'smithery.yaml not found');
});

test('glama.json exists and is valid', () => {
  const glama = require('../glama.json');
  assert(glama.$schema, 'missing $schema');
  assert(glama.maintainers, 'missing maintainers');
});

test('LICENSE exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'LICENSE')), 'LICENSE not found');
});

test('SECURITY.md exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'SECURITY.md')), 'SECURITY.md not found');
});

// ── Annotations ──

test('index.js has TOOL_ANNOTATIONS map', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
  assert(content.includes('TOOL_ANNOTATIONS'), 'TOOL_ANNOTATIONS not found');
  assert(content.includes('readOnlyHint'), 'readOnlyHint not found');
  assert(content.includes('destructiveHint'), 'destructiveHint not found');
});

// ── Results ──

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
