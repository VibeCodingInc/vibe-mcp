const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── apps/protocol.js ──────────────────────────────────────────────

describe('apps/protocol', () => {
  const { getProtocolScript } = require('../apps/protocol');

  it('exports getProtocolScript function', () => {
    assert.equal(typeof getProtocolScript, 'function');
  });

  it('returns a non-empty JS string', () => {
    const script = getProtocolScript();
    assert.equal(typeof script, 'string');
    assert.ok(script.length > 100, 'Script too short');
  });

  it('contains MCP Apps protocol methods', () => {
    const script = getProtocolScript();
    assert.ok(script.includes('ui/initialize'), 'Missing ui/initialize');
    assert.ok(script.includes('tools/call'), 'Missing tools/call');
    assert.ok(script.includes('ui/message'), 'Missing ui/message');
    assert.ok(script.includes('ui/open-link'), 'Missing ui/open-link');
  });

  it('contains postMessage transport', () => {
    const script = getProtocolScript();
    assert.ok(script.includes('postMessage'), 'Missing postMessage');
    assert.ok(script.includes('jsonrpc'), 'Missing JSON-RPC');
  });

  it('handles host-context-changed and resource-teardown', () => {
    const script = getProtocolScript();
    assert.ok(script.includes('host-context-changed'), 'Missing host-context-changed handler');
    assert.ok(script.includes('ui/resource-teardown'), 'Missing resource-teardown handler');
  });
});

// ── apps/presence.js ──────────────────────────────────────────────

describe('apps/presence', () => {
  const { generatePresenceHTML } = require('../apps/presence');

  it('exports generatePresenceHTML function', () => {
    assert.equal(typeof generatePresenceHTML, 'function');
  });

  it('returns a complete HTML document', () => {
    const html = generatePresenceHTML();
    assert.equal(typeof html, 'string');
    assert.ok(html.includes('<!DOCTYPE html>'), 'Missing doctype');
    assert.ok(html.includes('<html'), 'Missing html tag');
    assert.ok(html.includes('</html>'), 'Missing closing html tag');
    assert.ok(html.includes('<head>'), 'Missing head');
    assert.ok(html.includes('<body>'), 'Missing body');
  });

  it('contains the embedded MCP Apps protocol client', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('McpApps'), 'Missing McpApps client');
    assert.ok(html.includes('ui/initialize'), 'Missing protocol handshake');
  });

  it('contains buddy list UI elements', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('user-list'), 'Missing user-list class');
    assert.ok(html.includes('user-handle'), 'Missing user-handle class');
    assert.ok(html.includes('status-icon'), 'Missing status-icon class');
    assert.ok(html.includes('unread-badge'), 'Missing unread-badge class');
  });

  it('contains dark theme CSS variables', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('--bg:'), 'Missing --bg variable');
    assert.ok(html.includes('--surface:'), 'Missing --surface variable');
    assert.ok(html.includes('#0a0a0a'), 'Missing dark background');
  });

  it('calls vibe_presence_data for refresh', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('vibe_presence_data'), 'Missing vibe_presence_data tool call');
  });

  it('has 30s auto-refresh interval', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('30000'), 'Missing 30s refresh interval');
  });

  it('has light theme adaptation for host-context-changed', () => {
    const html = generatePresenceHTML();
    assert.ok(html.includes('onThemeChange'), 'Missing theme change handler');
    assert.ok(html.includes("'light'"), 'Missing light theme adaptation');
  });
});

// Phase 2: presence-data tool stripped for GTM
describe.skip('tools/presence-data', () => {
  it('skipped — tool archived for GTM', () => {});
});

// ── index.js capability detection ─────────────────────────────────

// Phase 2: MCP Apps features stripped for GTM
describe.skip('MCP Apps capability detection in index.js', () => {
  const fs = require('fs');
  const path = require('path');
  const indexContent = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');

  it('declares resources capability', () => {
    assert.ok(indexContent.includes('resources'), 'Missing resources capability');
  });

  it('checks for io.modelcontextprotocol/ui extension', () => {
    assert.ok(indexContent.includes('io.modelcontextprotocol/ui'), 'Missing UI extension check');
  });

  it('has resources/list handler', () => {
    assert.ok(indexContent.includes("case 'resources/list'"), 'Missing resources/list handler');
  });

  it('has resources/read handler', () => {
    assert.ok(indexContent.includes("case 'resources/read'"), 'Missing resources/read handler');
  });

  it('returns ui://vibe/presence resource', () => {
    assert.ok(indexContent.includes('ui://vibe/presence'), 'Missing presence resource URI');
  });

  it('adds _meta.ui to vibe_who when client supports Apps', () => {
    assert.ok(indexContent.includes("t.definition.name === 'vibe_who'"), 'Missing vibe_who _meta.ui injection');
    assert.ok(indexContent.includes('resourceUri'), 'Missing resourceUri in _meta.ui');
  });

  it('registers vibe_presence_data in tool entries', () => {
    assert.ok(indexContent.includes("'vibe_presence_data'"), 'Missing vibe_presence_data registration');
    assert.ok(indexContent.includes("require('./tools/presence-data')"), 'Missing presence-data require');
  });

  it('has annotation for vibe_presence_data', () => {
    assert.ok(indexContent.includes('vibe_presence_data: {'), 'Missing vibe_presence_data annotation');
  });
});

// ── tools/who.js structuredContent ────────────────────────────────

// Phase 2: structuredContent stripped for GTM
describe.skip('who.js structuredContent', () => {
  const fs = require('fs');
  const path = require('path');
  const whoContent = fs.readFileSync(path.join(__dirname, '..', 'tools', 'who.js'), 'utf-8');

  it('includes structuredContent in response', () => {
    assert.ok(whoContent.includes('structuredContent'), 'Missing structuredContent in who.js');
  });

  it('structuredContent has users array', () => {
    assert.ok(whoContent.includes('users: sorted.map'), 'Missing users mapping');
  });

  it('structuredContent has unreadCount', () => {
    assert.ok(whoContent.includes('unreadCount'), 'Missing unreadCount');
  });

  it('structuredContent has myHandle', () => {
    // Check for myHandle in the structuredContent object
    assert.ok(whoContent.includes('myHandle'), 'Missing myHandle');
  });
});
