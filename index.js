#!/usr/bin/env node
/**
 * /vibe MCP Server — Phase 1
 *
 * Communication layer inside Claude Code.
 * Identity, presence, DM. That's it.
 */

const presence = require('./presence');
const config = require('./config');
const store = require('./store');
const prompts = require('./prompts');
const NotificationEmitter = require('./notification-emitter');

/**
 * MCP Tool Safety Annotations
 *
 * Required by Anthropic's MCP Directory for Plugin/Connectors review.
 * Each tool must declare behavioral hints:
 *   readOnlyHint    — tool only reads data, never modifies state
 *   destructiveHint — tool may delete data or perform irreversible actions
 *   idempotentHint  — repeated calls with same args have no additional effect
 *   openWorldHint   — tool interacts with external services (API, network)
 *
 * Spec: https://modelcontextprotocol.io/docs/concepts/tools
 */
const TOOL_ANNOTATIONS = {
  // ── GTM: 9 tools (8 core + init) ────────────────────────────
  vibe_start:    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  vibe_init:     { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  vibe_who:      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  vibe_dm:       { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  vibe_inbox:    { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  vibe_status:   { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  vibe_ship:     { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  vibe_discover: { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
  vibe_help:     { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
};

// Default annotations for any tool not explicitly mapped
const DEFAULT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

// Tools that shouldn't show presence footer (would be redundant/noisy)
const SKIP_FOOTER_TOOLS = ['vibe_init', 'vibe_help'];

// Infer user prompt from tool arguments (for pattern logging)
function inferPromptFromArgs(toolName, args) {
  const action = toolName.replace('vibe_', '');
  const handle = args.handle ? `@${args.handle.replace('@', '')}` : '';
  const message = args.message ? `"${args.message.slice(0, 50)}..."` : '';
  const note = args.note || '';
  const mood = args.mood || '';
  const reaction = args.reaction || '';

  switch (action) {
    case 'start': return 'start vibing';
    case 'who': return 'who is online';
    case 'ping': return `ping ${handle} ${note}`.trim();
    case 'react': return `react ${reaction} to ${handle}`.trim();
    case 'dm': return `message ${handle} ${message}`.trim();
    case 'inbox': return 'check inbox';
    case 'open': return `open thread with ${handle}`;
    case 'status': return `set status to ${mood}`;
    case 'context': return 'share context';
    case 'summarize': return 'summarize session';
    case 'bye': return 'end session';
    case 'remember': return `remember about ${handle}`;
    case 'recall': return `recall ${handle}`;
    case 'forget': return `forget ${handle}`;
    case 'board': return args.content ? 'post to board' : 'view board';
    case 'observe': return args.content ? 'record observation' : 'view observations';
    case 'invite': return 'generate invite';
    case 'echo': return 'send feedback';
    case 'x_mentions': return 'check x mentions';
    case 'x_reply': return 'reply on x';
    case 'handoff': return `handoff task to ${handle}`;
    case 'reserve': return args.paths ? `reserve ${args.paths.join(', ')}` : 'reserve files';
    case 'release': return `release ${args.reservation_id || 'reservation'}`;
    case 'reservations': return 'list reservations';
    case 'solo_game': return `play ${args.game || 'game'}`;
    case 'tictactoe': return `play tic-tac-toe ${args.difficulty || ''}`.trim();
    case 'wordassociation': return args.word ? `word association: ${args.word}` : 'play word association';
    case 'multiplayer_game': return `multiplayer ${args.game || 'game'}`;
    case 'drawing': return args.action ? `drawing ${args.action}` : 'collaborative drawing';
    case 'crossword': return `crossword ${args.action || 'daily'}`;
    case 'away': return args.message ? `set away: "${args.message}"` : 'go away';
    case 'back': return 'come back';
    case 'discover': return `discover ${args.command || 'suggest'}`;
    case 'suggest_tags': return `suggest tags ${args.command || 'suggest'}`;
    case 'skills_exchange': return `skills exchange ${args.command || 'browse'}`;
    case 'workshop_buddy': return `workshop buddy ${args.command || 'find'}`;
    case 'create_artifact': return `create ${args.template || 'artifact'}: ${args.title || 'untitled'}`;
    case 'view_artifact': return args.slug ? `view artifact ${args.slug}` : `list ${args.list || 'artifacts'}`;
    default: return `${action} ${handle}`.trim() || null;
  }
}

// Generate terminal title escape sequence (OSC 0)
function getTerminalTitle(onlineCount, unreadCount, lastActivity) {
  const parts = [];
  if (onlineCount > 0) parts.push(`${onlineCount} online`);
  if (unreadCount > 0) parts.push(`📩 ${unreadCount}`);
  if (lastActivity) parts.push(lastActivity);
  if (parts.length === 0) parts.push('quiet');

  const title = `vibe: ${parts.join(' · ')}`;
  return `\x1b]0;${title}\x07`;
}

// Generate iTerm2 badge escape sequence (OSC 1337)
function getBadgeSequence(onlineCount, unreadCount) {
  const parts = [];
  if (onlineCount > 0) parts.push(`●${onlineCount}`);
  if (unreadCount > 0) parts.push(`✉${unreadCount}`);
  const badge = parts.join(' ') || '○';
  const encoded = Buffer.from(badge).toString('base64');
  return `\x1b]1337;SetBadgeFormat=${encoded}\x07`;
}

// Generate ambient presence footer - the room leaks into every response
async function getPresenceFooter() {
  try {
    const handle = config.getHandle();
    if (!handle) return '';

    // Fetch presence and unread in parallel
    const [users, unreadCount] = await Promise.all([
      store.getActiveUsers().catch(() => []),
      store.getUnreadCount(handle).catch(() => 0)
    ]);

    // Filter out self
    const others = users.filter(u => u.handle !== handle);
    const onlineCount = others.length;

    // Determine last activity
    let lastActivity = null;
    if (others.length > 0) {
      const recent = others[0];
      const mood = recent.mood ? ` ${recent.mood}` : '';
      lastActivity = `@${recent.handle}${mood}`;
    }

    // Terminal escape sequences (update title + badge)
    let escapes = '';
    escapes += getTerminalTitle(onlineCount, unreadCount, lastActivity);
    escapes += getBadgeSequence(onlineCount, unreadCount);

    // Build the visible footer
    let footer = '\n\n────────────────────────────────────────\n';

    // Line 1: vibe · X online · Y unread
    const parts = ['vibe'];
    if (onlineCount > 0) {
      parts.push(`${onlineCount} online`);
    }
    if (unreadCount > 0) {
      parts.push(`**${unreadCount} unread**`);
    }
    footer += parts.join(' · ');

    // Line 2: Activity hints (if anyone is online)
    if (others.length > 0) {
      footer += '\n';
      const hints = others.slice(0, 3).map(u => {
        const name = `@${u.handle}`;
        // Determine activity from mood/status
        if (u.mood === '🔥' || u.builderMode === 'shipping') {
          return `${name} shipping`;
        } else if (u.mood === '🧠' || u.builderMode === 'deep-focus') {
          return `${name} deep focus`;
        } else if (u.mood === '🐛') {
          return `${name} debugging`;
        } else if (u.note) {
          return `${name}: "${u.note.slice(0, 20)}${u.note.length > 20 ? '...' : ''}"`;
        } else {
          return `${name} here`;
        }
      });
      footer += hints.join(' · ');
    } else if (unreadCount === 0) {
      footer += '\n_room is quiet_';
    }

    footer += '\n────────────────────────────────────────';

    // Prepend escape sequences (invisible to user, interpreted by terminal)
    return escapes + footer;
  } catch (e) {
    // Silently fail - presence is best-effort
    return '';
  }
}

// Load GTM tools (8 core + init)
const tools = {
  vibe_start: require('./tools/start'),
  vibe_init: require('./tools/init'),
  vibe_who: require('./tools/who'),
  vibe_dm: require('./tools/dm'),
  vibe_inbox: require('./tools/inbox'),
  vibe_status: require('./tools/status'),
  vibe_ship: require('./tools/ship'),
  vibe_discover: require('./tools/discover'),
  vibe_help: require('./tools/help'),
};

/**
 * MCP Protocol Handler
 */
class VibeMCPServer {
  constructor() {
    // Initialize notification emitter
    this.notifier = new NotificationEmitter(this);

    // Make notifier globally accessible for tools and store layer
    global.vibeNotifier = this.notifier;

    // Start presence heartbeat
    presence.start();
  }

  /**
   * Send MCP notification
   * Called by NotificationEmitter to push list_changed events
   */
  notification(payload) {
    // Send notification via stdout (MCP protocol)
    const notification = {
      jsonrpc: '2.0',
      method: payload.method,
      params: payload.params || {}
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }

  async handleRequest(request) {
    const { method, params, id } = request;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'vibe',
              version: '1.0.0',
              description: 'Communication layer for Claude Code'
            }
          }
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: Object.values(tools).map(t => ({
              ...t.definition,
              annotations: TOOL_ANNOTATIONS[t.definition.name] || DEFAULT_ANNOTATIONS
            }))
          }
        };

      case 'tools/call':
        const tool = tools[params.name];
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${params.name}` }
          };
        }

        try {
          // Log prompt pattern (if _prompt passed) or infer from args
          const args = params.arguments || {};
          const inferredPrompt = args._prompt || inferPromptFromArgs(params.name, args);
          if (inferredPrompt) {
            prompts.log(inferredPrompt, {
              tool: params.name,
              action: params.name.replace('vibe_', ''),
              target: args.handle || args.to || null,
              transform: args.format || args.category || null
            });
          }

          const result = await tool.handler(args);

          // Emit list_changed notification for state-changing tools
          // This triggers Claude to refresh without reconnection
          const stateChangingTools = [
            'vibe_dm', 'vibe_status', 'vibe_ship'
          ];
          if (stateChangingTools.includes(params.name)) {
            // Debounced notification (prevents spam)
            global.vibeNotifier?.emitChange(params.name);
          }

          // Add ambient presence footer (unless tool is in skip list)
          let footer = '';
          if (!SKIP_FOOTER_TOOLS.includes(params.name)) {
            footer = await getPresenceFooter();
          }

          // Build simplified hint indicator for Claude (human-readable)
          let hintIndicator = '';
          if (result.hint) {
            // Simple format: <!-- vibe: hint_type @handle (count) -->
            const hint = result.hint;
            const handle = result.suggestion?.handle || result.for_handle || '';
            const count = result.unread_count || '';

            // Build minimal hint string
            let hintParts = [hint];
            if (handle) hintParts.push(`@${handle.replace('@', '')}`);
            if (count) hintParts.push(`(${count})`);

            hintIndicator = `\n\n<!-- vibe: ${hintParts.join(' ')} -->`;
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: (result.display || JSON.stringify(result, null, 2)) + hintIndicator + footer
              }]
            }
          };
        } catch (e) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: e.message }
          };
        }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  }

  start() {
    process.stdin.setEncoding('utf8');
    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line);
          const response = await this.handleRequest(request);
          if (response) {
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (e) {
          process.stderr.write(`Error: ${e.message}\n`);
        }
      }
    });

    process.stdin.on('end', () => {
      presence.stop();
      // Close SQLite to flush WAL and prevent corruption
      try { require('./store/sqlite').close(); } catch (e) {}
      process.exit(0);
    });

    // Welcome message
    process.stderr.write('\n/vibe ready.\n');
    process.stderr.write('vibe init → set identity\n');
    process.stderr.write('vibe who  → see who\'s around\n');
    process.stderr.write('vibe dm   → send a message\n\n');

    // Check for updates (non-blocking)
    this.checkForUpdates();
  }

  async checkForUpdates() {
    try {
      const { checkForUpdates, formatUpdateNotification } = await import('./auto-update.js');
      const update = await checkForUpdates();

      if (update) {
        const notification = formatUpdateNotification(update);
        process.stderr.write(notification);
      }
    } catch (error) {
      // Silent fail - don't block startup
    }
  }
}

// Start
const server = new VibeMCPServer();
server.start();