const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Load all registered tools from index.js ──

const indexPath = path.join(__dirname, '..', 'index.js');
const indexContent = fs.readFileSync(indexPath, 'utf-8');

// Extract tool name → require path pairs from the TOOLS map
const toolEntries = [];
const toolRegex = /(\w+):\s*require\(['"](.+?)['"]\)/g;
let match;
while ((match = toolRegex.exec(indexContent)) !== null) {
  toolEntries.push({ name: match[1], requirePath: match[2] });
}

describe('tool registry', () => {
  it('has at least 30 registered tools', () => {
    assert.ok(toolEntries.length >= 30, `Expected >= 30 tools, found ${toolEntries.length}`);
  });

  it('all tool names start with vibe_', () => {
    for (const entry of toolEntries) {
      assert.ok(entry.name.startsWith('vibe_'), `Tool ${entry.name} missing vibe_ prefix`);
    }
  });
});

// ── Load and validate each tool module ──

const toolsDir = path.join(__dirname, '..', 'tools');
const toolFiles = fs
  .readdirSync(toolsDir)
  .filter(f => f.endsWith('.js') && !f.startsWith('_'))
  .filter(f => {
    // Skip utility modules that don't export definition/handler
    try {
      const mod = require(path.join(toolsDir, f));
      return mod.definition !== undefined;
    } catch {
      return true; // Let the test catch load errors
    }
  });

describe('tool modules', () => {
  for (const file of toolFiles) {
    const modulePath = path.join(toolsDir, file);

    describe(file, () => {
      let mod;

      it('loads without error', () => {
        mod = require(modulePath);
        assert.ok(mod, `${file} exports nothing`);
      });

      it('exports a definition object', () => {
        if (!mod) return;
        assert.ok(mod.definition, `${file} missing definition`);
        assert.equal(typeof mod.definition, 'object');
      });

      it('definition has name starting with vibe_', () => {
        if (!mod?.definition) return;
        assert.ok(
          mod.definition.name && mod.definition.name.startsWith('vibe_'),
          `${file} definition.name = ${mod.definition.name}`
        );
      });

      it('definition has description string', () => {
        if (!mod?.definition) return;
        assert.equal(typeof mod.definition.description, 'string', `${file} missing description`);
        assert.ok(mod.definition.description.length > 0, `${file} description is empty`);
      });

      it('definition has inputSchema with type=object', () => {
        if (!mod?.definition) return;
        assert.ok(mod.definition.inputSchema, `${file} missing inputSchema`);
        assert.equal(mod.definition.inputSchema.type, 'object', `${file} inputSchema.type != object`);
      });

      it('exports a handler function', () => {
        if (!mod) return;
        assert.equal(typeof mod.handler, 'function', `${file} missing handler function`);
      });
    });
  }
});
