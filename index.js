#!/usr/bin/env node
/**
 * /vibe MCP Server — Phase 1
 *
 * Communication layer inside Claude Code.
 * Identity, presence, DM. That's it.
 */

// CLI routing is now handled by cli.js (the bin entry point).
// If this file is required directly (e.g., by Claude Code MCP config),
// it runs the MCP server immediately.

const presence = require('./presence');
const config = require('./config');
const store = require('./store');
const prompts = require('./prompts');
const toolPrivacy = require('./tool-privacy');
const NotificationEmitter = require('./notification-emitter');
const authStore = require('./auth-store');
const actorSession = require('./actor-session');
const { apiHeaders } = require('./api-auth');
const presenceBoard = require('./resources/presence-board');
const { resolveFooter } = require('./footer');
const pkg = require('./package.json');

// ─── MCP protocol identity (spec 2026-07-28, dual-era) ──────────────────
// Modern clients (2026-07-28+) declare io.modelcontextprotocol/protocolVersion
// in each request's _meta and get stateless semantics: server/discover,
// resultType on results, serverInfo echoed in result _meta. Legacy clients
// (2025-11-25 and earlier) still open with `initialize`; both eras are served
// from this one process. Known gap: list_changed notifications are pushed
// unsolicited (legacy style) — modern subscriptions/listen is not implemented.
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const SERVER_INFO = {
  name: 'vibe',
  version: pkg.version,
  description: 'Presence + messaging for terminal coding agents'
};
const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: {},
  // MCP Apps: ui:// resources the host renders in-conversation.
  // See resources/presence-board.js (declared on vibe_who).
  extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }
};

// Tools that shouldn't show presence footer (would be redundant/noisy)
// The local-only verbs make NO platform side effects (review P1): the
// ambient footer performs platform requests, so remember/reflect/call and
// the manifest never carry it.
const SKIP_FOOTER_TOOLS = ['vibe_init', 'vibe_doctor', 'vibe_test', 'vibe_update',
  'vibe_capabilities', 'vibe_remember', 'vibe_reflect', 'vibe_call',
  // The people actions each end in ONE obvious next action; the ambient
  // footer would stack a second one AND name a specific recipient to reply
  // to — the choosing is the human's, so the footer stays off here.
  'vibe_people', 'vibe_list_me', 'vibe_unlist_me'];

// Progressive disclosure: only these tools are visible before authentication
// After auth, the full toolset is revealed via tools/list_changed notification
const PRE_AUTH_TOOLS = new Set([
  'vibe_start',   // Entry point (auto-redirects to init)
  'vibe_init',    // GitHub OAuth flow
  'vibe_token',   // Manual token entry
  'vibe_who',     // Peek at who's online (no auth required)
  'vibe_dm',      // Shown so users can try — triggers auth gate
  'vibe_inbox',   // Shown so users can try — triggers auth gate
  'vibe_status',  // Shown so users can try — triggers auth gate
  'vibe_help',    // Always accessible
  // The truthful capability manifest is exactly what a fresh install should
  // be able to ask: it reads no private data and reports message as
  // "available · sign in with vibe start" until a principal exists.
  'vibe_capabilities'
]);

// Tools that genuinely work without authentication
const NO_AUTH_REQUIRED = new Set([
  'vibe_start', 'vibe_init', 'vibe_token', 'vibe_who', 'vibe_help',
  // The manifest is local truth; signed out it must ANSWER (message:
  // available · sign in), never start an auth flow (review P1).
  'vibe_capabilities'
]);

// "Is this session signed in" — the credential answers, not the filesystem.
//
// This used to OR in config.hasOAuth(), which asks a FILE. That made disk a second
// authority: a leftover config could unlock the authenticated tool surface for a
// session holding no usable credential. authStore already consults disk during
// hydration and refuses anything it cannot attribute, so it is the one place that
// should decide.
//
// Deliberately NOT gated on isVerified(): verification needs the network, and a
// person on a plane should still see their tools and get a clear error from the
// server rather than a surface that silently empties. Verification gates the things
// that must never be a guess — the green dot and any claim about who you are.
const isAuthed = () => authStore.isAuthenticated();

// Infer user prompt from tool arguments (for pattern logging).
// Cases exist only for registered tools whose args improve on the default.
function inferPromptFromArgs(toolName, args) {
  const action = toolName.replace('vibe_', '');
  const handle = args.handle ? `@${args.handle.replace('@', '')}` : '';
  const message = args.message ? `"${args.message.slice(0, 50)}..."` : '';

  switch (action) {
    case 'start': return 'start vibing';
    case 'who': return 'who is online';
    case 'dm': return `message ${handle} ${message}`.trim();
    case 'inbox': return 'check inbox';
    case 'status': return `set status to ${args.mood || ''}`.trim();
    case 'game': return `play ${args.game || 'game'} with ${handle}`.trim();
    case 'poem': return args.line ? `add a line to poem with ${handle}` : `emoji poem with ${handle}`;
    case 'bye': return 'end session';
    default: return `${action} ${handle}`.trim() || null;
  }
}

// TERMINAL ESCAPES ARE OPT-IN, and default to OFF.
//
// An MCP server CANNOT know what renders its output. These OSC sequences assume an
// iTerm-like terminal; every other client shows them as literal junk on the end of every
// tool result:
//
//     ]0;vibe: 2 online · @pastelle]1337;SetBadgeFormat=4peL
//
// The comment that used to sit here claimed they were "invisible in the transcript".
// They are not — they were visible throughout a full working session in Claude Code, on
// every single vibe tool call. That is a claim about a state nobody verified, which is
// the exact defect class this codebase keeps paying for (canon law 2), and it is worse
// than usual here because the claim is what stopped anyone looking.
//
// Client-agnostic payloads are the rule. Someone on iTerm who wants a live title and
// badge can ask for it; nobody else should pay for it.
const TERM_ESCAPES = ['1', 'true'].includes(String(process.env.VIBE_TERM_ESCAPES || '').toLowerCase());

// Terminal title + badge escapes moved to ambient-escapes.js — they make
// "N online" claims, so the module applies the isHereNow gate internally
// and index.js can no longer feed it an ungated count (#9.1).
const { ambientEscapes } = require('./ambient-escapes');

// Fetch and acknowledge guest messages from the session API
async function fetchGuestMessages(handle) {
  if (!handle) return [];
  const apiUrl = config.getApiUrl?.() || 'https://www.slashvibe.dev';
  try {
    // Fetch with ack=true to clear after reading (prevents re-injection)
    const resp = await fetch(`${apiUrl}/api/session/guest?handle=${encodeURIComponent(handle)}&ack=true`, {
      headers: apiHeaders(),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data.success && Array.isArray(data.messages) && data.messages.length > 0) {
      return data.messages;
    }
    return [];
  } catch {
    return [];
  }
}

// New unread DMs already surfaced in this session (by last-message id), so each
// message body is injected into context exactly ONCE. Read state is NOT touched
// here — the cursor advances only when the user actually opens/replies to the
// thread (vibe_inbox / vibe_reply), so badges on other devices stay
// honest about what the human has engaged with.
const injectedDmIds = new Set();
const INJECTED_DM_CAP = 500; // session-lifetime backstop

// Pull unread DM threads worth injecting: unread, not muted, latest message is
// from the other side, and not already injected this session.
async function fetchNewUnreadDms(handle) {
  if (!handle) return [];
  try {
    const inbox = await store.getInbox(handle);
    const fresh = (inbox || []).filter(t =>
      t.unread > 0 &&
      !t.muted &&
      t.lastMessageId &&
      t.lastFrom &&
      t.lastFrom.toLowerCase() !== handle.toLowerCase() &&
      !injectedDmIds.has(t.lastMessageId)
    ).slice(0, 3);
    for (const t of fresh) {
      injectedDmIds.add(t.lastMessageId);
      if (injectedDmIds.size > INJECTED_DM_CAP) {
        injectedDmIds.delete(injectedDmIds.values().next().value);
      }
    }
    return fresh;
  } catch {
    return [];
  }
}

// Ambient presence data cache. getPresenceFooter runs after EVERY tool call,
// and presence/unread/live counts don't change sub-10s — so three of its five
// network calls can ride a short TTL. The guest-message and DM injection
// fetches are deliberately NOT cached: each delivers content at most once
// (ack=true / injectedDmIds), so caching would replay or delay injections.
const AMBIENT_CACHE_TTL_MS = 10000;
let ambientCache = { at: 0, handle: null, data: null };
const bustAmbientCache = () => { ambientCache = { at: 0, handle: null, data: null }; };

// Tools whose effects change what the ambient footer shows (unread counts,
// presence, own status, session identity) — they get a fresh fetch instead of
// the cache. vibe_token is here because it can swap the signed-in account.
const AMBIENT_CACHE_BUSTERS = new Set([
  'vibe_start', 'vibe_init', 'vibe_token', 'vibe_dm', 'vibe_reply', 'vibe_inbox',
  'vibe_status', 'vibe_ship', 'vibe_play', 'vibe_game', 'vibe_bye'
]);

async function getAmbientPresence(handle) {
  const now = Date.now();
  // Keyed by handle: an in-process identity switch must never serve the
  // previous account's counts, even if the buster list misses a path.
  if (ambientCache.data && ambientCache.handle === handle &&
      now - ambientCache.at < AMBIENT_CACHE_TTL_MS) {
    return ambientCache.data;
  }
  const [users, unreadCount, liveCount] = await Promise.all([
    store.getActiveUsers().catch(() => []),
    store.getUnreadCount(handle).catch(() => 0),
    store.getLiveBroadcastCount().catch(() => 0)
  ]);
  ambientCache = { at: now, handle, data: { users, unreadCount, liveCount } };
  return ambientCache.data;
}

// Generate ambient presence footer - the room leaks into every response
const { renderIncoming } = require('./incoming');

// The ambient footer, appended to every tool response.
//
// Deliberately quiet: one status line, and nothing else unless something
// actually happened. It used to carry live-room links, three users' inferred
// moods, and two different "nothing is happening" nudges on EVERY call —
// which trained people to skip past the one place we surface real messages.
async function getPresenceFooter() {
  try {
    const handle = config.getHandle();
    if (!handle) return '';

    // Ambient data (cached) + injection channels (always fresh) in parallel
    const [{ users, unreadCount, liveCount }, guestMessages, newDms] = await Promise.all([
      getAmbientPresence(handle),
      fetchGuestMessages(handle).catch(() => []),
      fetchNewUnreadDms(handle).catch(() => [])
    ]);

    const others = users.filter(u => u.handle !== handle);
    // The footer's "N others" deliberately counts the room AROUND you
    // (active+away); the title/badge "online" claims are gated inside
    // ambientEscapes on isHereNow — two different statements, two counts.
    const onlineCount = others.length;

    // Terminal title + badge: ambient by nature, invisible in the transcript.
    const escapes = TERM_ESCAPES ? ambientEscapes(others, unreadCount) : '';

    // The status line. Counts only — no mood inference, no nudges.
    const parts = ['vibe'];
    // "2 online" under a board showing three rows — one of them you — reads as a
    // contradiction, even though both numbers are right. The footer counts the room
    // AROUND you, so it should say so.
    if (onlineCount > 0) parts.push(`${onlineCount} other${onlineCount === 1 ? '' : 's'}`);
    if (unreadCount > 0) parts.push(`**${unreadCount} unread**`);
    if (liveCount > 0) parts.push(`${liveCount} live`);
    let footer = `\n\n────────────────────────\n${parts.join(' · ')}`;

    // Someone going live is an event worth one line — where, so it's joinable.
    const liveRoom = others.find(u => u.isLive && u.broadcastRoom);
    if (liveRoom) {
      const base = (process.env.VIBE_ROOM_URL_BASE || 'https://vibeconferencing.com/room/').replace(/\/$/, '');
      footer += `\n🟢 @${liveRoom.handle} is live → ${base}/${liveRoom.broadcastRoom}`;
    }

    // Messages: the whole reason this footer exists.
    footer += renderIncoming(
      guestMessages.map(m => ({ from: m.from, text: m.message })),
      { replyTo: guestMessages[0]?.from, threadHint: false }
    );
    footer += renderIncoming(
      newDms.map(t => ({
        from: t.handle,
        text: t.lastMessage + (t.unread > 1 ? ` (+${t.unread - 1} more unread)` : ''),
      })),
      { replyTo: newDms[0]?.handle, threadHint: true }
    );

    return escapes + footer;
  } catch (e) {
    // Silently fail - presence is best-effort
    return '';
  }
}

// ─── Core tools ─────────────────────────────────────────────────────────
// Minimal set: auth + presence + messaging + status + ship.
// Less is more. 95 tools → 15. Claude gets confused with too many options.
// Removed tools still exist in ./tools/ and can be re-added if needed.
// ─── Kernel ──────────────────────────────────────────────────────────────
// The minimum viable social surface (0.8 "core mode"): identity + presence +
// messaging, plus auth plumbing, help, and the sign-off. An agent that sees a
// handful of tools uses them correctly; one that sees twenty wanders.
const kernelTools = {
  // Auth & onboarding
  vibe_start: require('./tools/start'),
  vibe_init: require('./tools/init'),
  vibe_token: require('./tools/token'),

  // Presence — who's here, what are they building
  vibe_who: require('./tools/who'),
  vibe_status: require('./tools/status'),

  // Messaging — the core social loop
  vibe_dm: require('./tools/dm'),
  vibe_inbox: require('./tools/inbox'),
  vibe_reply: require('./tools/reply'),

  // Utility
  vibe_help: require('./tools/help'),
  vibe_bye: require('./tools/bye'),

  // ── The four verbs (canon PR #333 / epic #329) ─────────────────────────
  // remember · reflect · message · call. Messaging IS vibe_dm/inbox/reply
  // above; these three complete the verb set, and the manifest tells the
  // truth about every one of them. Install once is not consent once.
  vibe_capabilities: require('./tools/capabilities'),
  vibe_remember: require('./tools/remember'),
  vibe_reflect: require('./tools/reflect'),
  vibe_call: require('./tools/call'),

  // ── People (opt-in discovery, platform#345 / vibe-mcp#28) ──────────────
  // `vibe who` is who is present NOW; `vibe people` is who chose to be
  // findable, online or not. Listing is always the person's own act — no
  // path anywhere may set it for them.
  vibe_people: require('./tools/people'),
  vibe_list_me: require('./tools/list-me'),
  vibe_unlist_me: require('./tools/unlist-me'),
};

// ─── Extras ──────────────────────────────────────────────────────────────
// The culture layer. Real /vibe, but not kernel — opt in with VIBE_EXTRAS=1
// in the MCP server env. Handlers (and their files) ship regardless; only the
// default registration shrinks.
const EXTRAS_ENABLED = ['1', 'true'].includes(String(process.env.VIBE_EXTRAS || '').toLowerCase());
const extraTools = {
  // Received collaboration — land the newcomer mid-conversation with a topical match
  vibe_intro: require('./tools/intro'),

  // The Weave — attach this session's strand so Fable can bring moments INTO the
  // terminal (Spec 1); "Fable holds your half" surfaces via action:'held' + vibe_start.
  vibe_weave: require('./tools/weave'),

  // The Weave, deepest form (Spec 4) — co-author a living shared artifact with
  // another viber; Fable merges edits + flags conflicts with judgment across
  // both terminals. Built on the vibe_play/vibe_corpse shared-state-over-DM lineage.
  vibe_fable: require('./tools/fable'),

  // Return loop — get pinged about DMs you miss while away
  vibe_email: require('./tools/email'),

  // Ship — share what you built
  vibe_ship: require('./tools/ship'),
  vibe_feed: require('./tools/feed'),

  // Play — shared experiences over the DM transport. vibe_play is the open
  // primitive (freeform state courier); game/poem/corpse carry real rule
  // enforcement (chess/tictactoe legality, poem sealing, corpse hidden-state)
  // and read their own legacy payloads — behaviors the primitive does NOT
  // reproduce, so they stay as distinct tools.
  vibe_play: require('./tools/play'),
  vibe_game: require('./tools/game'),
  vibe_poem: require('./tools/poem'),
  vibe_corpse: require('./tools/corpse'),
};

// Admin tools (only loaded when VIBE_ADMIN=true)
const adminTools = process.env.VIBE_ADMIN === 'true' ? {
  vibe_admin_inbox: require('./tools/admin-inbox'),
  vibe_test: require('./tools/test'),
  vibe_doctor: require('./tools/doctor'),
  vibe_update: require('./tools/update'),
  vibe_patterns: require('./tools/patterns'),
} : {};

// The Personal Mind seam now answers through the verb: vibe_remember reports
// the capability state honestly without a grant and consults the private edge
// with one. The vibe_mind name is retired from tools/list; its engine
// (tools/mind.js) is the granted path inside vibe_remember.

// Combine tools — kernel always (the four verbs report their own truthful
// states); extras only when opted in.
const tools = { ...kernelTools, ...(EXTRAS_ENABLED ? extraTools : {}), ...adminTools };

/**
 * MCP Protocol Handler
 */
class VibeMCPServer {
  constructor() {
    // Hydrate auth state from disk FIRST (before any tools need it)
    authStore.hydrate();

    // An access token is memory/cache; only the rotating refresh bundle survives a
    // process. Refresh once at startup so a dead/reused family becomes one truthful
    // reauthentication state before any future delivery transition can use it.
    this.actorAccessReady = actorSession.getAccessToken().catch((error) => {
      if (error?.reauthenticate) {
        process.stderr.write(
          '/vibe: terminal delivery sign-in needs renewal — say "vibe init"; ordinary /vibe sign-in is unchanged\n'
        );
      } else if (error?.code === 'actor_refresh_busy') {
        process.stderr.write('/vibe: terminal delivery sign-in is being refreshed by another session\n');
      }
      return null;
    });

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

    // Modern era: any request carrying a _meta protocol version is served
    // statelessly. The gate applies to server/discover too — an unsupported
    // version gets -32022 whose `supported` list drives the retry; answering
    // with a success the client didn't ask for breaks future negotiation.
    // (Probes WITHOUT _meta still get a DiscoverResult, so the legacy-era
    // backward-compat probe keeps working.)
    const requestedVersion = params?._meta?.[META_PROTOCOL_VERSION];
    const isModern = requestedVersion !== undefined;
    if (isModern && requestedVersion !== MODERN_PROTOCOL_VERSION) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: [MODERN_PROTOCOL_VERSION], requested: requestedVersion }
        }
      };
    }

    const response = await this.dispatch(request);
    if (isModern && response?.result) {
      response.result.resultType = response.result.resultType || 'complete';
      response.result._meta = { [META_SERVER_INFO]: SERVER_INFO, ...(response.result._meta || {}) };
    }
    return response;
  }

  async dispatch(request) {
    const { method, params, id } = request;

    switch (method) {
      case 'server/discover':
        // MUST-implement under 2026-07-28; also answers _meta-less probes
        // (the version gate in handleRequest rejects unsupported versions
        // before dispatch reaches here). Modern clients may name themselves
        // here; env fingerprints (host.js) cover the ones that don't.
        require('./host').setClientInfo(params?.clientInfo);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
            capabilities: SERVER_CAPABILITIES,
            instructions: 'Social layer for terminal coding agents — identity, presence, and DMs between builders, from Claude Code, Codex, or Cursor. Start with vibe_start (sign in) or vibe_who (see who is online).',
            ttlMs: 3600000,
            cacheScope: 'public',
            _meta: { [META_SERVER_INFO]: SERVER_INFO }
          }
        };

      case 'initialize': {
        // Legacy handshake (2025-11-25 and earlier). Echo the client's version
        // when we know it — the previous hardcoded 2024-11-05 forced every
        // client down to the oldest revision; unknown versions get our latest
        // legacy revision per the legacy negotiation rule.
        // The host names itself here (claude-code, codex, cursor, …) —
        // captured so the presence heartbeat can say WHICH agent this
        // session lives in. See host.js.
        require('./host').setClientInfo(params?.clientInfo);
        const requested = params?.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: LEGACY_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : LEGACY_PROTOCOL_VERSIONS[0],
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO
          }
        };
      }

      case 'tools/list':
        // Progressive disclosure: show only core tools until authenticated.
        // Registration-object order is stable across calls and processes, so
        // the deterministic-order SHOULD (2026-07-28) is met without sorting.
        const allToolDefs = Object.values(tools).map(t => t.definition);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: isAuthed()
              ? allToolDefs
              : allToolDefs.filter(t => PRE_AUTH_TOOLS.has(t.name)),
            // CacheableResult: private (varies with auth state). Pre-auth gets
            // ZERO ttl — sign-in swaps the toolset and modern clients have no
            // subscriptions/listen stream to invalidate through; only the
            // legacy unsolicited list_changed exists. Post-auth may cache.
            ttlMs: isAuthed() ? 60000 : 0,
            cacheScope: 'private'
          }
        };

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: [presenceBoard.definition],
            ttlMs: 3600000,
            cacheScope: 'public'
          }
        };

      case 'resources/read': {
        if (params?.uri !== presenceBoard.RESOURCE_URI) {
          // -32602 per 2026-07-28 (was -32002; realigned with JSON-RPC).
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Resource not found: ${params?.uri}` }
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [presenceBoard.content],
            ttlMs: 3600000,
            cacheScope: 'public'
          }
        };
      }

      case 'tools/call':
        const tool = tools[params.name];
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${params.name}` }
          };
        }

        // Auth gate: auto-detect unauthenticated state and trigger auth flow
        if (!isAuthed() && !NO_AUTH_REQUIRED.has(params.name)) {
          // Auto-trigger init flow — user never needs to know about "vibe init"
          const actionName = params.name.replace('vibe_', '');
          const initTool = tools['vibe_init'];
          try {
            // Forward the first command's args into init rather than dropping them.
            // vibe_init reads only {handle, one_liner, auth_method} and ignores any
            // extra keys, so this is safe for every command yet lets relevant
            // context (e.g. a handle the caller already supplied) carry into auth.
            const initResult = await initTool.handler(params.arguments || {});
            const initDisplay = initResult.display || JSON.stringify(initResult, null, 2);

            // After auth, emit tools/list_changed so Claude sees full toolset
            if (isAuthed()) {
              global.vibeNotifier?.emitImmediate();
            }

            // Sign-in is non-blocking now: init returns auth_required and the
            // person finishes in a browser. Only claim "You're in!" when the
            // credential actually exists (review P1) — otherwise relay init's
            // honest state and its structured mirror.
            const signedIn = isAuthed();
            const gateResult = {
              content: [{
                type: 'text',
                text: signedIn
                  ? `> _You tried to **${actionName}** — signing you in first._\n\n${initDisplay}\n\n---\n💡 **You're in!** Try your \`${actionName}\` command again.`
                  : `> _You tried to **${actionName}** — sign in first._\n\n${initDisplay}\n\n---\n_Then say \`${actionName}\` again._`
              }]
            };
            if (initResult.structured) gateResult.structuredContent = initResult.structured;
            return { jsonrpc: '2.0', id, result: gateResult };
          } catch (e) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{
                  type: 'text',
                  text: `🔒 **Sign in required** to use **${actionName}**\n\nSay **"let's vibe"** to sign in with GitHub (30 seconds).\n\n_Error: ${e.message}_`
                }]
              }
            };
          }
        }

        try {
          // Log prompt pattern (if _prompt passed) or infer from args
          const args = params.arguments || {};
          // Personal Mind inputs are unsent thought, not product analytics.
          // Do not retain even a derived prompt or recipient for this tool.
          const inferredPrompt = toolPrivacy.retainedPrompt(
            params.name,
            args,
            inferPromptFromArgs,
          );
          if (inferredPrompt) {
            prompts.log(inferredPrompt, {
              tool: params.name,
              action: params.name.replace('vibe_', ''),
              target: args.handle || args.to || null,
              transform: args.format || args.category || null
            });
          }

          // The HTTP store creates one random key per logical send and preserves it
          // across its internal transport retries. JSON-RPC ids restart every MCP
          // process, so deriving a durable key from `id` would collapse future sends.
          const result = await tool.handler(args);

          // Emit list_changed notification for state-changing tools
          // This triggers Claude to refresh without reconnection
          const stateChangingTools = [
            'vibe_dm', 'vibe_reply', 'vibe_status',
            'vibe_ship', 'vibe_play', 'vibe_game'
          ];
          if (stateChangingTools.includes(params.name)) {
            // Debounced notification (prevents spam)
            global.vibeNotifier?.emitChange(params.name);
          }

          // After init/start completes auth, emit tools/list_changed
          // so Claude sees the full toolset (progressive disclosure unlock)
          if ((params.name === 'vibe_init' || params.name === 'vibe_start') && isAuthed()) {
            global.vibeNotifier?.emitImmediate();
          }

          // Add ambient presence footer (unless tool is in skip list).
          // State-changing tools bust the cache first so the footer reflects
          // what they just did (e.g. inbox read clears the unread badge).
          let footer = '';
          if (toolPrivacy.shouldAppendAmbientFooter(params.name, SKIP_FOOTER_TOOLS)) {
            if (AMBIENT_CACHE_BUSTERS.has(params.name)) bustAmbientCache();
            footer = await resolveFooter(result, getPresenceFooter);
          }

          const callResult = {
            content: [{
              type: 'text',
              text: (result.display || JSON.stringify(result, null, 2)) + footer
            }]
          };
          // Structured mirror for MCP Apps (the presence board reads this) and
          // modern clients; text-only hosts ignore it.
          if (result.structured) {
            callResult.structuredContent = result.structured;
          }
          return { jsonrpc: '2.0', id, result: callResult };
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
    let shuttingDown = false;

    // The host owns this stdio process. When its pipe disappears—or the host asks
    // the process group to terminate—stop every interval and exit explicitly.
    // Relying only on a clean `end` left abrupt host/plugin teardown without a
    // lifecycle boundary and was especially costly when this process also raised
    // native notifications (#23, #173).
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      presence.stop();
      this.notifier.cancelAll();
      process.exit(0);
    };

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

    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    process.once('disconnect', shutdown);
    process.once('SIGHUP', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    // Welcome message
    process.stderr.write('\n/vibe ready.\n');
    process.stderr.write('vibe init → set identity\n');
    process.stderr.write('vibe who  → see who\'s around\n');
    process.stderr.write('vibe dm   → send a message\n\n');

    // Check for updates (non-blocking)
    this.checkForUpdates();

    // Auto-presence: if authenticated, broadcast presence on connect
    this.autoPresence();
  }

  async autoPresence() {
    try {
      // Presence follows the CREDENTIAL, not a handle written in a file. This used to
      // read config.getHandle() and announce "Auto-connected" on the strength of that
      // alone — so an expired or foreign session still printed a confident green line
      // and started a heartbeat that could only 401. That is the client-side version
      // of the bug where an agent holds a green dot and never reads its mail: the dot
      // has to mean someone is actually reachable. (issues #107, #91)
      const handle = authStore.getHandle();
      if (!handle || !authStore.isAuthenticated()) return;

      // ASK THE SERVER BEFORE CLAIMING ANYTHING.
      //
      // I added an explicit verified-vs-saved state and then gated nothing on it, so
      // this still announced on the strength of "a token-shaped string exists on
      // disk". A forged JWT-shaped value in config or Buddy's auth.json produced a
      // confident "🟢 Auto-connected as @victim" and a heartbeat against production.
      // Holding a credential is not the same as having one that works, and the green
      // dot is the one thing in this product that must never be a guess.
      let verified;
      try {
        verified = await store.verifyAuthToken(authStore.getToken());
      } catch (e) {
        verified = null;
      }
      if (!verified || !verified.valid) {
        // Definitive rejection means the session is dead; unreachable means unknown.
        // Neither earns a green dot, and neither is worth shouting about at startup.
        if (verified && verified.definitive) {
          process.stderr.write('/vibe: saved session is no longer valid — say "vibe init" to sign in again\n');
        }
        return;
      }
      authStore.markVerified(verified.handle);

      const one_liner = config.getOneLiner() || '';

      // Start presence heartbeat — now, and only now, is this handle a fact.
      presence.start(authStore.getHandle(), one_liner);

      // Log quietly (only to stderr, not intrusive)
      process.stderr.write(`🟢 Auto-connected as @${authStore.getHandle()}\n`);
    } catch (error) {
      // Silent fail - don't block startup
    }
  }

  async checkForUpdates() {
    try {
      const { checkForUpdates, formatUpdateNotification } = require('./auto-update');
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
