/**
 * MCP Apps Protocol Client — Inline JS for presence widget
 *
 * Minimal postMessage transport implementing the MCP Apps spec (SEP-1865).
 * This module exports a string of JavaScript that gets embedded directly
 * into the widget HTML. No external dependencies.
 *
 * Protocol: JSON-RPC 2.0 over postMessage
 * Spec: https://github.com/modelcontextprotocol/ext-apps
 */

/**
 * Returns a self-contained JS string that implements the MCP Apps client protocol.
 * Designed to be injected into an HTML <script> block.
 */
function getProtocolScript() {
  return `
// ── MCP Apps Protocol Client ──────────────────────────────────────
const McpApps = (() => {
  let _requestId = 0;
  let _pending = new Map(); // id → { resolve, reject, timer }
  let _initialized = false;
  let _hostOrigin = '*';
  let _onThemeChange = null;
  let _onTeardown = null;
  const TIMEOUT_MS = 10000;

  // Send JSON-RPC message to host
  function send(msg) {
    window.parent.postMessage(msg, _hostOrigin);
  }

  // Send a JSON-RPC request and return a promise for the result
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++_requestId;
      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error('MCP Apps request timeout: ' + method));
      }, TIMEOUT_MS);

      _pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  // Handle incoming messages from host
  function handleMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

    // Response to our request
    if (msg.id && _pending.has(msg.id)) {
      const { resolve, reject, timer } = _pending.get(msg.id);
      clearTimeout(timer);
      _pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || 'MCP Apps error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Notification from host
    if (msg.method) {
      switch (msg.method) {
        case 'ui/notifications/host-context-changed':
          if (_onThemeChange && msg.params?.context?.theme) {
            _onThemeChange(msg.params.context.theme);
          }
          break;
        case 'ui/resource-teardown':
          if (_onTeardown) _onTeardown();
          break;
      }
    }
  }

  // Initialize the MCP Apps connection
  async function initialize() {
    window.addEventListener('message', handleMessage);

    try {
      const result = await request('ui/initialize', {
        uri: 'ui://vibe/presence',
        capabilities: {}
      });
      _initialized = true;
      return result;
    } catch (e) {
      console.warn('[vibe] MCP Apps initialize failed:', e.message);
      _initialized = false;
      throw e;
    }
  }

  // Call a tool on the MCP server via the host
  async function callTool(name, args) {
    return request('tools/call', { name, arguments: args || {} });
  }

  // Send a chat message (e.g., "message @handle hello")
  function sendMessage(text) {
    return request('ui/message', { message: text });
  }

  // Open a link in the host
  function openLink(url) {
    return request('ui/open-link', { url });
  }

  // Register theme change callback
  function onThemeChange(cb) { _onThemeChange = cb; }

  // Register teardown callback
  function onTeardown(cb) { _onTeardown = cb; }

  // Cleanup
  function destroy() {
    window.removeEventListener('message', handleMessage);
    for (const [id, { timer }] of _pending) {
      clearTimeout(timer);
    }
    _pending.clear();
    _initialized = false;
  }

  return {
    initialize,
    callTool,
    sendMessage,
    openLink,
    onThemeChange,
    onTeardown,
    destroy,
    get initialized() { return _initialized; }
  };
})();
`;
}

module.exports = { getProtocolScript };
