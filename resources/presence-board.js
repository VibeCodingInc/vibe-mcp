/**
 * ui://vibe/presence-board — the /vibe presence board as an MCP App.
 *
 * Declared on vibe_who via _meta.ui.resourceUri. Hosts that support the
 * io.modelcontextprotocol/ui extension (Claude, Claude Desktop, VS Code, …)
 * fetch this resource with resources/read and render it in a sandboxed iframe
 * in place of the markdown output; every other host ignores the _meta and
 * keeps the text. Data arrives as the structuredContent of vibe_who results
 * (ui/notifications/tool-result), and the Refresh button re-calls vibe_who
 * through the host's tools/call proxy.
 *
 * Self-contained by design: no external origins (empty csp), no framework —
 * the postMessage JSON-RPC bridge is ~40 lines. Lives as a required JS module
 * (not a loose .html) so the pack require-closure ships it.
 */

const RESOURCE_URI = 'ui://vibe/presence-board';
const MIME_TYPE = 'text/html;profile=mcp-app';
const roomTone = require('./vibe-tokens.json');

const cssName = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const ROOM_TONE_ROOT = Object.entries(roomTone.color)
  .map(([name, value]) => `    --${cssName(name)}: ${value};`)
  .join('\n');

/* eslint-disable no-useless-concat */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>/vibe — who's around</title>
<style>
  :root {
${ROOM_TONE_ROOT}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: ${roomTone.font.mono};
    font-size: 13px;
    line-height: 1.5;
    padding: 14px;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
  }
  h1 { font-size: 14px; font-weight: 600; color: var(--blue); }
  h1 span { color: var(--dim); font-weight: 400; }
  #refresh {
    background: none;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--dim);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 3px 10px;
  }
  #refresh:hover { border-color: var(--blue); color: var(--blue); }
  #refresh:disabled { opacity: 0.5; cursor: wait; }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 6px;
  }
  .row.away { opacity: 0.55; }
  .dot { flex: none; font-size: 11px; }
  .dot.on { color: var(--green); }
  .dot.off { color: var(--dim); }
  .who { flex: 1 1 auto; min-width: 0; }
  .handle { font-weight: 600; }
  .handle .me { color: var(--dim); font-weight: 400; }
  .label { color: var(--pink); margin-left: 6px; }
  .activity {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ago { flex: none; color: var(--dim); font-size: 11px; }
  #empty, #waiting { color: var(--dim); padding: 18px 4px; text-align: center; }
  footer { color: var(--dim); font-size: 11px; margin-top: 10px; text-align: right; }
</style>
</head>
<body>
<header>
  <h1>/vibe <span>· who's around</span></h1>
  <button id="refresh" type="button">refresh</button>
</header>
<div id="board"><div id="waiting">tuning in&hellip;</div></div>
<footer id="stamp"></footer>
<script>
(function () {
  'use strict';
  var nextId = 1;
  var pending = {};

  function request(method, params, cb) {
    var id = 'presence-board-' + (nextId++);
    pending[id] = cb || function () {};
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
  }

  window.addEventListener('message', function (ev) {
    // Only the host frame may speak to us — a sibling iframe could otherwise
    // spoof responses (request ids are predictable, notifications need none).
    if (ev.source !== window.parent) return;
    var msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      var cb = pending[msg.id];
      if (cb) { delete pending[msg.id]; cb(msg.error || null, msg.result); }
      return;
    }
    if (msg.method === 'ui/notifications/tool-result' && msg.params) {
      render(msg.params.structuredContent);
    }
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render(data) {
    var board = document.getElementById('board');
    var stamp = document.getElementById('stamp');
    if (!data || !Array.isArray(data.users)) {
      board.innerHTML = '<div id="waiting">no presence data yet &mdash; hit refresh</div>';
      return;
    }
    if (data.users.length === 0) {
      board.innerHTML = '<div id="empty">room is quiet &mdash; you\\'re the only one here</div>';
      stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
      return;
    }
    var html = '';
    for (var i = 0; i < data.users.length; i++) {
      var u = data.users[i];
      var on = u.status === 'active';
      html += '<div class="row' + (on ? '' : ' away') + '">'
        + '<span class="dot ' + (on ? 'on' : 'off') + '">&#9679;</span>'
        + '<span class="who">'
        + '<span class="handle">@' + esc(u.handle)
        + (u.isAgent ? ' &#129302;' : '')
        + (u.isMe ? ' <span class="me">(you)</span>' : '')
        + '</span>'
        + (u.heatLabel ? '<span class="label">' + esc(u.heatIcon ? u.heatIcon + ' ' : '') + esc(u.heatLabel) + '</span>' : '')
        + '<div class="activity">' + esc(u.awayMessage || u.activity || '') + '</div>'
        + '</span>'
        + '<span class="ago">' + esc(u.timeAgo || '') + '</span>'
        + '</div>';
    }
    board.innerHTML = html;
    stamp.textContent = data.users.length + ' on the board · updated ' + new Date().toLocaleTimeString();
  }

  function refresh() {
    var btn = document.getElementById('refresh');
    btn.disabled = true;
    request('tools/call', { name: 'vibe_who', arguments: {} }, function (err, result) {
      btn.disabled = false;
      if (!err && result) render(result.structuredContent);
    });
  }
  document.getElementById('refresh').addEventListener('click', refresh);

  // MCP Apps handshake — the Apps schema requires protocolVersion and
  // appCapabilities alongside appInfo. Proceed only on SUCCESSFUL init:
  // announcing initialized after a rejection leaves the board hung on
  // strict hosts. On success, pull a first board in case the host rendered
  // us before (or without) pushing the invoking tool-result.
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'vibe-presence-board', version: '0.1.0' },
    appCapabilities: {}
  }, function (err) {
    if (err) {
      document.getElementById('board').innerHTML =
        '<div id="waiting">host declined initialization</div>';
      return;
    }
    notify('ui/notifications/initialized');
    refresh();
  });
})();
</script>
</body>
</html>
`;

module.exports = {
  RESOURCE_URI,

  // resources/list entry
  definition: {
    uri: RESOURCE_URI,
    name: 'presence_board',
    description: "Live presence board — who's online on /vibe and what they're building",
    mimeType: MIME_TYPE
  },

  // resources/read content
  content: {
    uri: RESOURCE_URI,
    mimeType: MIME_TYPE,
    text: HTML,
    _meta: {
      ui: {
        // Fully self-contained: no external scripts, styles, or fetches.
        csp: {},
        prefersBorder: true
      }
    }
  }
};
