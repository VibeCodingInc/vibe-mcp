/**
 * Agent Gateway Bridge — Event push + local state for external agents
 *
 * The /vibe platform API (slashvibe.dev) already provides:
 * - Messaging: POST/GET /api/messages
 * - Presence: POST/GET /api/presence
 * - Board: POST/GET /api/board (ships, ideas, requests)
 * - Discovery: GET /api/discover
 * - Agents: GET /api/agents
 * - Auth: JWT via /api/auth/*
 *
 * This bridge fills the GAPS for external agent gateways (Clawdbot, @seth):
 *
 * 1. EVENT PUSH — Platform is pull-based. This pushes events to agents.
 * 2. LOCAL STATE — Memory, reservations, and session data are local-only.
 * 3. AIRC IDENTITY — Verifies agent identity via Ed25519 signatures.
 * 4. AGENT REGISTRY — Tracks which agents are connected + their capabilities.
 *
 * External agents should use the platform API directly for:
 *   DMs, presence, board, discovery, profiles
 * And use THIS bridge for:
 *   Event subscriptions, local memory queries, AIRC verification
 */

const crypto = require('../crypto');
const config = require('../config');
const memory = require('../memory');
const debug = require('../debug');

// ============ AGENT REGISTRY ============

/**
 * Known agent gateways
 * @type {Map<string, {handle: string, publicKey: string, endpoint: string, capabilities: string[], registeredAt: number}>}
 */
const agentRegistry = new Map();

/**
 * Event subscriptions — agents subscribe to event types and get HTTP pushes
 * @type {Map<string, {endpoint: string, events: string[], handle: string}>}
 */
const eventSubscriptions = new Map();

/**
 * Register an external agent gateway with AIRC identity
 *
 * @param {object} params
 * @param {string} params.handle Agent handle (e.g. "seth-agent")
 * @param {string} params.publicKey Base64 Ed25519 public key (AIRC)
 * @param {string} [params.endpoint] HTTP callback URL for event pushes
 * @param {string[]} [params.capabilities] What this agent can do
 * @param {string} [params.signature] AIRC signature proving key ownership
 * @returns {{success: boolean, agentId?: string, error?: string}}
 */
function registerAgent({ handle, publicKey, endpoint, capabilities = [], signature }) {
  if (!handle || !publicKey) {
    return { success: false, error: 'handle and publicKey required' };
  }

  // Verify AIRC signature if provided (proves private key ownership)
  if (signature) {
    const valid = crypto.verify(
      { handle, publicKey, endpoint, capabilities },
      publicKey
    );
    if (!valid) {
      return { success: false, error: 'Invalid AIRC signature' };
    }
  }

  const agentId = `agent_${handle}_${Date.now().toString(36)}`;

  agentRegistry.set(handle, {
    agentId,
    handle,
    publicKey,
    endpoint: endpoint || null,
    capabilities,
    registeredAt: Date.now()
  });

  debug(`[agent-gateway] Registered @${handle} (${agentId})`);
  return { success: true, agentId, handle };
}

/**
 * Verify an AIRC-signed message from a registered agent
 *
 * @param {object} message Signed message with `from` and `signature` fields
 * @returns {{valid: boolean, handle?: string, verified?: string, error?: string}}
 */
function verifyAgentMessage(message) {
  if (!message || !message.from) {
    return { valid: false, error: 'Missing from field' };
  }

  const agent = agentRegistry.get(message.from);

  // AIRC-verified: registered agent with valid signature
  if (agent && message.signature) {
    const valid = crypto.verify(message, agent.publicKey);
    if (!valid) {
      return { valid: false, error: 'AIRC signature verification failed' };
    }
    return { valid: true, handle: message.from, verified: 'airc' };
  }

  // Registered but unsigned — allow with lower trust
  if (agent && !message.signature) {
    debug(`[agent-gateway] Unsigned request from registered agent @${message.from}`);
    return { valid: true, handle: message.from, verified: 'registered' };
  }

  return { valid: false, error: `Unknown agent: ${message.from}. Register first via POST /agent/register` };
}

// ============ EVENT PUSH ============

/**
 * Subscribe an agent to /vibe events (push model)
 *
 * Event types:
 * - dm: New direct messages for the subscribed handle
 * - mention: @mentions in feed/board
 * - ship: New ships from connections
 * - presence: People coming online/offline
 * - handoff: Task handoff requests
 *
 * @param {string} handle Agent handle
 * @param {string} endpoint HTTP callback URL to receive events
 * @param {string[]} events Event types to subscribe to
 * @returns {{success: boolean, subscribed: string[]}}
 */
function subscribe(handle, endpoint, events = ['dm', 'mention', 'ship', 'presence']) {
  if (!endpoint) {
    return { success: false, error: 'endpoint required' };
  }

  eventSubscriptions.set(handle, { endpoint, events, handle });
  debug(`[agent-gateway] @${handle} subscribed to [${events.join(', ')}] → ${endpoint}`);
  return { success: true, subscribed: events };
}

/**
 * Unsubscribe an agent from events
 * @param {string} handle Agent handle
 */
function unsubscribe(handle) {
  eventSubscriptions.delete(handle);
  debug(`[agent-gateway] @${handle} unsubscribed`);
  return { success: true };
}

/**
 * Push an event to all subscribed agents
 * AIRC-signed if we have a keypair (proves event came from /vibe)
 *
 * Called by notify.js and tool handlers when events occur.
 *
 * @param {string} eventType Event type (dm, mention, ship, presence, handoff)
 * @param {object} eventData Event payload
 */
async function pushEvent(eventType, eventData) {
  const keypair = config.getKeypair();
  const myHandle = config.getHandle();

  for (const [handle, sub] of eventSubscriptions) {
    if (!sub.events.includes(eventType)) continue;
    if (!sub.endpoint) continue;

    const event = {
      v: '0.1',
      type: 'vibe_event',
      event: eventType,
      data: eventData,
      from: myHandle || 'vibe-mcp',
      timestamp: Math.floor(Date.now() / 1000)
    };

    // AIRC sign so receiver can verify this came from /vibe
    if (keypair) {
      event.signature = crypto.sign(event, keypair.privateKey);
      event.publicKey = keypair.publicKey;
    }

    try {
      const response = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vibe-Event': eventType,
          'X-Vibe-Source': 'vibe-mcp'
        },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        debug(`[agent-gateway] Push to @${handle} failed: HTTP ${response.status}`);
      }
    } catch (e) {
      debug(`[agent-gateway] Push to @${handle} failed: ${e.message}`);
    }
  }
}

// ============ LOCAL STATE QUERIES ============
// These expose data that lives only in the MCP process, not on the platform API

/**
 * Query local memory (thread-scoped JSONL files)
 * Platform API doesn't have memory — it's local-first by design
 */
function queryMemory(handle, limit = 10, search = null) {
  const memories = memory.recall(handle, limit);

  if (search && memories.length > 0) {
    return memories.filter(m =>
      m.observation.toLowerCase().includes(search.toLowerCase())
    );
  }

  return memories;
}

/**
 * Store a memory observation (local-first)
 */
function storeMemory(handle, observation) {
  memory.remember(handle, observation);
  return { success: true, handle, observation };
}

/**
 * List all memory threads
 */
function listMemoryThreads() {
  return memory.listThreads();
}

// ============ HTTP HANDLER ============

/**
 * HTTP handler for the agent gateway
 *
 * Routes:
 *   POST /agent/register     — Register agent with AIRC public key
 *   POST /agent/subscribe    — Subscribe to event pushes
 *   POST /agent/unsubscribe  — Unsubscribe from events
 *   POST /agent/memory       — Query/store local memory
 *   GET  /agent/status       — Gateway health + registered agents
 *
 * For everything else, agents hit the platform API directly:
 *   POST https://slashvibe.dev/api/messages  — Send DMs
 *   GET  https://slashvibe.dev/api/presence   — Who's online
 *   POST https://slashvibe.dev/api/board      — Ship/idea/request
 *   GET  https://slashvibe.dev/api/discover   — Find people
 *   GET  https://slashvibe.dev/api/agents     — Agent directory
 */
async function handleRequest(req) {
  const { path, method, body } = req;

  // Health / status
  if (path === '/agent/status' && method === 'GET') {
    const agents = [];
    for (const [, agent] of agentRegistry) {
      agents.push({
        handle: agent.handle,
        capabilities: agent.capabilities,
        registeredAt: agent.registeredAt,
        hasEndpoint: !!agent.endpoint
      });
    }

    return {
      status: 'ok',
      agents,
      subscriptions: eventSubscriptions.size,
      version: '0.1.0',
      platform_api: config.getApiUrl(),
      note: 'For DMs, presence, board, discovery — use the platform API directly'
    };
  }

  if (method !== 'POST') {
    return { error: 'Method not allowed', status: 405 };
  }

  const data = typeof body === 'string' ? JSON.parse(body) : body;

  switch (path) {
    case '/agent/register':
      return registerAgent(data);

    case '/agent/subscribe': {
      const v = verifyAgentMessage(data);
      if (!v.valid) return { success: false, error: v.error, status: 401 };
      return subscribe(v.handle, data.endpoint, data.events);
    }

    case '/agent/unsubscribe': {
      const v = verifyAgentMessage(data);
      if (!v.valid) return { success: false, error: v.error, status: 401 };
      return unsubscribe(v.handle);
    }

    case '/agent/memory': {
      const v = verifyAgentMessage(data);
      if (!v.valid) return { success: false, error: v.error, status: 401 };

      if (data.action === 'recall') {
        const memories = queryMemory(data.handle, data.limit, data.search);
        return { success: true, memories };
      }
      if (data.action === 'remember') {
        return storeMemory(data.handle, data.observation);
      }
      if (data.action === 'threads') {
        return { success: true, threads: listMemoryThreads() };
      }
      return { success: false, error: 'action must be: recall, remember, or threads' };
    }

    default:
      return { error: 'Not found', status: 404 };
  }
}

// ============ EXPORTS ============

module.exports = {
  // Registration
  registerAgent,
  verifyAgentMessage,

  // Event push (the main value-add over platform API)
  subscribe,
  unsubscribe,
  pushEvent,

  // Local state (not on platform)
  queryMemory,
  storeMemory,
  listMemoryThreads,

  // HTTP handler
  handleRequest,

  // Registry access
  getAgentRegistry: () => agentRegistry,
  getSubscriptions: () => eventSubscriptions
};
