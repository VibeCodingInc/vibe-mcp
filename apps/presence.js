/**
 * Presence Widget — MCP Apps UI Resource
 *
 * Generates a self-contained HTML document for the presence widget.
 * Renders inline in chat via the ui://vibe/presence resource URI.
 * No build step, no external dependencies.
 */

const { getProtocolScript } = require('./protocol');

/**
 * Generate the full HTML string for the presence widget.
 * This gets returned as the content of a resources/read response.
 */
function generatePresenceHTML() {
  const protocolScript = getProtocolScript();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe — who's around</title>
<style>
  :root {
    --bg: #0a0a0a;
    --surface: #141414;
    --border: #222;
    --text: #e0e0e0;
    --text-dim: #777;
    --accent: #6b8fff;
    --online: #4ade80;
    --away: #facc15;
    --badge-bg: #ef4444;
    --badge-text: #fff;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    line-height: 1.4;
    overflow-x: hidden;
  }

  .widget {
    padding: 12px;
    max-width: 320px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .header h1 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }

  .header .count {
    font-size: 11px;
    color: var(--text-dim);
  }

  .unread-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--badge-bg);
    color: var(--badge-text);
    font-size: 10px;
    font-weight: 700;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    padding: 0 5px;
    margin-left: 6px;
  }

  .unread-badge.hidden { display: none; }

  .user-list { list-style: none; }

  .user {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 4px;
    border-radius: 4px;
    cursor: default;
  }

  .user:hover {
    background: var(--surface);
  }

  .status-icon {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    background: var(--online);
  }

  .status-icon.away { background: var(--away); }
  .status-icon.offline { background: var(--text-dim); }

  .user-info {
    flex: 1;
    min-width: 0;
  }

  .user-handle {
    font-weight: 600;
    font-size: 13px;
    color: var(--text);
  }

  .user-handle .agent-badge {
    font-size: 11px;
    margin-left: 2px;
  }

  .user-handle .mood {
    margin-left: 3px;
  }

  .user-activity {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-time {
    font-size: 10px;
    color: var(--text-dim);
    opacity: 0.7;
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 12px 0 4px;
    cursor: pointer;
    user-select: none;
  }

  .section-label:hover { color: var(--text); }

  .section-label .toggle {
    font-size: 9px;
    margin-right: 4px;
  }

  .away-section.collapsed .user { display: none; }

  .empty {
    color: var(--text-dim);
    font-style: italic;
    padding: 20px 0;
    text-align: center;
    font-size: 12px;
  }

  .refresh-indicator {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 10px;
    color: var(--text-dim);
    opacity: 0;
    transition: opacity 0.3s;
  }

  .refresh-indicator.active { opacity: 1; }

  .error {
    color: #ef4444;
    font-size: 11px;
    padding: 8px 0;
  }
</style>
</head>
<body>
<div class="widget">
  <div class="refresh-indicator" id="refresh">refreshing...</div>
  <div class="header">
    <h1>/vibe <span class="count" id="count"></span></h1>
    <span class="unread-badge hidden" id="unread"></span>
  </div>
  <div id="content">
    <div class="empty">connecting...</div>
  </div>
</div>

<script>
${protocolScript}

// ── Presence Widget Logic ─────────────────────────────────────────
(() => {
  const REFRESH_INTERVAL = 30000; // 30s
  let refreshTimer = null;
  let awaySectionCollapsed = true;

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function renderUsers(data) {
    const el = document.getElementById('content');
    const countEl = document.getElementById('count');
    const unreadEl = document.getElementById('unread');

    if (!data || !data.users) {
      el.innerHTML = '<div class="empty">no presence data</div>';
      return;
    }

    const users = data.users;
    const active = users.filter(u => u.status === 'active');
    const away = users.filter(u => u.status !== 'active');

    // Header count
    countEl.textContent = active.length > 0 ? active.length + ' online' : 'quiet';

    // Unread badge
    if (data.unreadCount > 0) {
      unreadEl.textContent = data.unreadCount;
      unreadEl.classList.remove('hidden');
    } else {
      unreadEl.classList.add('hidden');
    }

    if (users.length === 0) {
      el.innerHTML = '<div class="empty">nobody around right now</div>';
      return;
    }

    let html = '';

    // Active users
    if (active.length > 0) {
      html += '<ul class="user-list">';
      for (const u of active) {
        const isMe = u.handle === data.myHandle;
        const agent = u.isAgent ? '<span class="agent-badge">&#x1F916;</span>' : '';
        const mood = u.mood ? '<span class="mood">' + u.mood + '</span>' : '';
        const meTag = isMe ? ' (you)' : '';
        const activity = u.activity || u.file || '';
        const ago = timeAgo(u.lastSeen);

        html += '<li class="user">';
        html += '  <div class="status-icon"></div>';
        html += '  <div class="user-info">';
        html += '    <div class="user-handle">@' + u.handle + agent + mood + meTag + '</div>';
        if (activity) html += '    <div class="user-activity">' + escapeHtml(activity) + '</div>';
        if (ago) html += '    <div class="user-time">' + ago + '</div>';
        html += '  </div>';
        html += '</li>';
      }
      html += '</ul>';
    }

    // Away users (collapsible)
    if (away.length > 0) {
      const collapsed = awaySectionCollapsed ? ' collapsed' : '';
      const toggle = awaySectionCollapsed ? '\\u25B6' : '\\u25BC';
      html += '<div class="away-section' + collapsed + '" id="away-section">';
      html += '  <div class="section-label" onclick="toggleAway()">';
      html += '    <span class="toggle">' + toggle + '</span> Away (' + away.length + ')';
      html += '  </div>';
      for (const u of away) {
        const agent = u.isAgent ? '<span class="agent-badge">&#x1F916;</span>' : '';
        const awayMsg = u.awayMessage ? ' \\u2014 ' + escapeHtml(u.awayMessage) : '';
        const ago = timeAgo(u.lastSeen);

        html += '<li class="user">';
        html += '  <div class="status-icon away"></div>';
        html += '  <div class="user-info">';
        html += '    <div class="user-handle">@' + u.handle + agent + awayMsg + '</div>';
        if (ago) html += '    <div class="user-time">' + ago + '</div>';
        html += '  </div>';
        html += '</li>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.toggleAway = function() {
    awaySectionCollapsed = !awaySectionCollapsed;
    const section = document.getElementById('away-section');
    if (section) {
      section.classList.toggle('collapsed');
      const toggle = section.querySelector('.toggle');
      if (toggle) toggle.textContent = awaySectionCollapsed ? '\\u25B6' : '\\u25BC';
    }
  };

  async function refresh() {
    const indicator = document.getElementById('refresh');
    try {
      indicator.classList.add('active');
      const result = await McpApps.callTool('vibe_presence_data', {});
      if (result && result.content) {
        // Parse structured content from tool result
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent) {
          const data = JSON.parse(textContent.text);
          renderUsers(data);
        }
      }
    } catch (e) {
      console.warn('[vibe] refresh failed:', e.message);
    } finally {
      indicator.classList.remove('active');
    }
  }

  async function start() {
    try {
      await McpApps.initialize();
      await refresh();
      refreshTimer = setInterval(refresh, REFRESH_INTERVAL);

      McpApps.onThemeChange((theme) => {
        // Adapt to host theme if provided
        if (theme === 'light') {
          document.documentElement.style.setProperty('--bg', '#ffffff');
          document.documentElement.style.setProperty('--surface', '#f5f5f5');
          document.documentElement.style.setProperty('--border', '#e0e0e0');
          document.documentElement.style.setProperty('--text', '#1a1a1a');
          document.documentElement.style.setProperty('--text-dim', '#666');
        }
      });

      McpApps.onTeardown(() => {
        if (refreshTimer) clearInterval(refreshTimer);
        McpApps.destroy();
      });
    } catch (e) {
      document.getElementById('content').innerHTML =
        '<div class="error">Could not connect to /vibe</div>';
    }
  }

  start();
})();
</script>
</body>
</html>`;
}

module.exports = { generatePresenceHTML };
