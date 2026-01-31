/**
 * API Store — Messages and presence via remote API
 *
 * Uses VIBE_API_URL environment variable
 * Uses HMAC-signed tokens for authentication
 * AIRC v0.1: Ed25519 message signing
 */

const https = require('https');
const http = require('http');
const config = require('../config');
const crypto = require('../crypto');
const sqlite = require('./sqlite'); // V2 messaging - local persistence

const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

// Default timeout for API requests (10 seconds)
const REQUEST_TIMEOUT = 10000;

function request(method, path, data = null, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const timeout = options.timeout || REQUEST_TIMEOUT;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'vibe-mcp/1.0'
    };

    // Add auth token if provided or if we have one stored
    const token = options.token || config.getAuthToken();
    if (token && options.auth !== false) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout
    };

    const req = client.request(reqOptions, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        // Handle non-2xx responses
        if (res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(body);
            resolve({ success: false, error: parsed.error || `HTTP ${res.statusCode}`, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: false, error: `HTTP ${res.statusCode}`, statusCode: res.statusCode });
          }
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });

    // Handle timeout
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout', timeout: true });
    });

    req.on('error', e => {
      resolve({ success: false, error: e.message, network: true });
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// ============ PRESENCE ============

// Session ID for this MCP instance
let currentSessionId = null;

function setSessionId(sessionId) {
  currentSessionId = sessionId;
}

function getSessionId() {
  return currentSessionId;
}

async function registerSession(sessionId, handle, building = null, publicKey = null) {
  try {
    // Register session for presence - server generates sessionId and returns signed token
    // AIRC: Include public key for identity verification
    const registrationData = {
      action: 'register',
      username: handle
    };
    if (publicKey) {
      registrationData.publicKey = publicKey;
    }

    const result = await request('POST', '/api/presence', registrationData, { auth: false }); // Don't send token for registration (we don't have one yet)

    if (result.success && result.token) {
      // Use server-issued sessionId and token (not client-generated)
      currentSessionId = result.sessionId;

      // Save token for future authenticated requests (persist to shared config)
      config.savePrivyToken(result.token);

      console.error(`[vibe] Registered @${handle} with session ${result.sessionId}`);
    } else if (result.success) {
      // Fallback for servers that don't yet return tokens
      currentSessionId = sessionId;
      console.error(`[vibe] Registered @${handle} (legacy mode)`);
    }

    // Also register user in users DB (for @vibe welcome tracking)
    // AIRC: Include public key for identity
    try {
      const userData = {
        username: handle,
        building: building || 'something cool'
      };
      if (publicKey) {
        userData.publicKey = publicKey;
      }
      await request('POST', '/api/users', userData, { auth: false }); // User registration doesn't need auth
    } catch (e) {
      // Non-fatal if user registration fails
    }

    return result;
  } catch (e) {
    console.error('Session registration failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function heartbeat(handle, one_liner, context = null, source = null) {
  try {
    // Token-based auth: server extracts handle from token
    // Only need to send workingOn and context
    const payload = { workingOn: one_liner };

    // Fallback: if no token, send username (legacy support)
    if (!config.getAuthToken()) {
      payload.username = handle;
    }

    // Add context (mood, file, etc.) if provided
    if (context) {
      payload.context = context;
    }

    // Phase 1 Presence Bridge: track which surface is reporting
    // See VIBE_CLAWDBOT_INTEGRATION_SPEC.md
    if (source) {
      payload.source = source;
    }

    await request('POST', '/api/presence', payload);
  } catch (e) {
    console.error('Heartbeat failed:', e.message);
  }
}

async function sendTypingIndicator(handle, toHandle) {
  try {
    // Token auth: server extracts sender from token
    const payload = { typingTo: toHandle };

    // Fallback for legacy
    if (!config.getAuthToken()) {
      payload.username = handle;
    }

    await request('POST', '/api/presence', payload);
  } catch (e) {
    console.error('Typing indicator failed:', e.message);
  }
}

async function getTypingUsers(forHandle) {
  try {
    const result = await request('GET', `/api/presence?user=${forHandle}&typing=true`);
    return result.typingUsers || [];
  } catch (e) {
    return [];
  }
}

async function getActiveUsers() {
  try {
    const result = await request('GET', '/api/presence');
    // Combine active and away users
    const users = [...(result.active || []), ...(result.away || [])];
    return users.map(u => ({
      handle: u.username,
      one_liner: u.workingOn,
      lastSeen: new Date(u.lastSeen).getTime(),
      firstSeen: u.firstSeen ? new Date(u.firstSeen).getTime() : null,
      status: u.status,
      // Mood: explicit (context.mood) or inferred (u.mood)
      mood: u.context?.mood || u.mood || null,
      mood_inferred: u.mood_inferred || false,
      mood_reason: u.mood_reason || null,
      builderMode: u.builderMode || null,
      // Context sharing fields
      file: u.context?.file || null,
      branch: u.context?.branch || null,
      repo: u.context?.repo || null,
      error: u.context?.error || null,
      note: u.context?.note || null,
      // Away status
      awayMessage: u.context?.awayMessage || null,
      awayAt: u.context?.awayAt || null
    }));
  } catch (e) {
    console.error('Who failed:', e.message);
    return [];
  }
}

async function setVisibility(handle, visible) {
  // TODO: implement visibility toggle API
}

// ============ MESSAGES ============

async function sendMessage(from, to, body, type = 'dm', payload = null) {
  // V2 MESSAGING: Save to SQLite first (optimistic UI)
  const local_id = require('crypto').randomUUID();
  const created_at = new Date().toISOString();

  try {
    // 1. Save to local SQLite (optimistic - before API call)
    sqlite.saveLocalMessage({
      local_id,
      from_handle: from,
      to_handle: to,
      content: body || '',
      created_at,
      status: 'pending'
    });
  } catch (sqliteError) {
    // Don't fail message send if SQLite fails (just log)
    console.warn('[SQLite] Failed to save message locally:', sqliteError.message);
  }

  try {
    let data;

    // Check if using Privy auth (server-side signing)
    if (config.hasPrivyAuth()) {
      // NEW: Privy auth flow - server handles signing
      // Just send message data, server signs it
      data = { to, body: body || undefined, text: body };
      if (payload) data.payload = payload;

      console.error('[vibe] Sending message via Privy auth (server-side signing)');
    } else {
      // LEGACY: Create signed message if we have a keypair
      const keypair = config.getKeypair();

      if (keypair) {
        // Full AIRC-compliant signed message
        data = crypto.createSignedMessage(
          {
            from,
            to,
            body: body || undefined,
            payload: payload || undefined
          },
          keypair.privateKey
        );

        // Also include 'text' for backward compat with current API
        if (body) data.text = body;
      } else {
        // No auth at all - legacy format (no signing)
        data = { from, to, text: body };
        if (payload) {
          data.payload = payload;
        }
      }
    }

    const result = await request('POST', '/api/messages', data);

    // Handle auth errors
    if (!result.success && result.error?.includes('Authentication')) {
      // Mark as failed in SQLite
      try {
        sqlite.updateMessageStatus(local_id, 'failed');
      } catch (e) {}
      console.error('[vibe] Auth failed for message. Try `vibe init` to re-register.');
      return { error: 'auth_failed', message: 'Authentication failed. Try `vibe init` to re-register.' };
    }

    // Handle expired token
    if (result.statusCode === 401) {
      // Mark as failed in SQLite
      try {
        sqlite.updateMessageStatus(local_id, 'failed');
      } catch (e) {}
      console.error('[vibe] Auth expired. Run browser auth to refresh token.');
      return { error: 'auth_expired', message: 'Auth expired. Run `vibe init` to refresh token.' };
    }

    // Handle storage errors (KV write failed)
    if (!result.success && result.error === 'storage_error') {
      // Mark as failed in SQLite
      try {
        sqlite.updateMessageStatus(local_id, 'failed');
      } catch (e) {}
      console.error('[vibe] Storage error:', result.details || result.message);
      return { error: 'storage_error', message: result.message || 'Failed to save message. Please try again.' };
    }

    // Handle other errors
    if (!result.success && result.error) {
      // Mark as failed in SQLite
      try {
        sqlite.updateMessageStatus(local_id, 'failed');
      } catch (e) {}
      console.error('[vibe] Send error:', result.error, result.message);
      return { error: result.error, message: result.message || 'Failed to send message.' };
    }

    // V2 MESSAGING: Update SQLite with server_id, thread_id and mark as sent
    if (result.success || result.message) {
      try {
        // V2 Postgres: result.message.id, result.message.thread_id
        const message = result.message || {};
        const server_id = message.id || result.messageId || result.id || null;
        const thread_id = message.thread_id || null;
        sqlite.updateMessageStatus(local_id, 'sent', server_id, thread_id);
      } catch (sqliteError) {
        console.warn('[SQLite] Failed to update message status:', sqliteError.message);
      }
    }

    // Emit list_changed notification for successful message send
    // This allows other Claude Code instances to see the new message instantly
    if (result.success || result.message) {
      if (global.vibeNotifier) {
        global.vibeNotifier.emitImmediate(); // Immediate for DMs
      }
    }

    return result.message;
  } catch (e) {
    console.error('Send failed:', e.message);
    // Mark as failed in SQLite
    try {
      sqlite.updateMessageStatus(local_id, 'failed');
    } catch (sqliteErr) {}
    return null;
  }
}

async function getInbox(handle) {
  try {
    // V2 MESSAGING: Hybrid approach - SQLite (fast) + API (sync)

    // 1. Get from local SQLite first
    let localInbox = [];
    try {
      localInbox = sqlite.getInboxThreads(handle);
    } catch (sqliteError) {
      console.warn('[SQLite] Failed to read inbox:', sqliteError.message);
    }

    // 2. Fetch from API (sync with backend)
    const result = await request('GET', `/api/messages?user=${handle}`);

    // V2 Postgres: result.threads[] with thread_id
    const threads = result.threads || [];

    // Merge threads into SQLite for persistence
    if (threads.length > 0) {
      try {
        threads.forEach(thread => {
          const msg = thread.last_message;
          if (msg) {
            sqlite.mergeServerMessages([
              {
                server_id: msg.id,
                thread_id: thread.id, // V2 thread_id
                from_handle: msg.from,
                to_handle: handle === msg.from ? thread.with : handle,
                content: msg.body,
                created_at: msg.created_at,
                status: 'delivered'
              }
            ]);
          }
        });
      } catch (sqliteError) {
        console.warn('[SQLite] Failed to merge inbox threads:', sqliteError.message);
      }
    }

    // Return V2 format
    return threads.map(thread => ({
      handle: thread.with,
      messages: thread.last_message
        ? [
            {
              from: thread.last_message.from,
              body: thread.last_message.body,
              timestamp: new Date(thread.last_message.created_at).getTime(),
              read: thread.unread === 0
            }
          ]
        : [],
      unread: thread.unread,
      lastMessage: thread.last_message?.body,
      lastTimestamp: thread.last_message ? new Date(thread.last_message.created_at).getTime() : 0
    }));
  } catch (e) {
    console.error('Inbox failed:', e.message);

    // Fallback to SQLite if API fails
    try {
      const localInbox = sqlite.getInboxThreads(handle);
      return localInbox.map(thread => ({
        handle: thread.partner,
        messages: [thread.latestMessage].map(m => ({
          from: m.from_handle,
          body: m.content,
          timestamp: new Date(m.created_at).getTime(),
          read: m.status === 'read'
        })),
        unread: thread.unreadCount,
        lastMessage: thread.latestMessage.content,
        lastTimestamp: new Date(thread.latestMessage.created_at).getTime()
      }));
    } catch (sqliteError) {
      return [];
    }
  }
}

async function getUnreadCount(handle) {
  try {
    // Use unified messages endpoint - returns { inbox, unread, bySender }
    const result = await request('GET', `/api/messages?user=${handle}`);
    return result.unread || 0;
  } catch (e) {
    return 0;
  }
}

// Get raw inbox messages (for notification checks)
async function getRawInbox(handle) {
  try {
    // Use unified messages endpoint - returns { inbox, unread, bySender }
    const result = await request('GET', `/api/messages?user=${handle}`);
    return result.inbox || [];
  } catch (e) {
    return [];
  }
}

async function getThread(myHandle, theirHandle) {
  try {
    // V2 MESSAGING: Hybrid approach - SQLite (fast) + API (sync)

    // 1. Get from local SQLite first (instant, works offline)
    let localMessages = [];
    try {
      localMessages = sqlite.getThreadMessages(myHandle, theirHandle);
    } catch (sqliteError) {
      console.warn('[SQLite] Failed to read thread:', sqliteError.message);
    }

    // 2. Fetch from API (sync with backend)
    const result = await request('GET', `/api/messages?user=${myHandle}&with=${theirHandle}`);

    // V2 Postgres: result.messages[] (not result.thread)
    const apiMessages = result.messages || result.thread || [];

    // 3. Merge API messages into SQLite (for future reads)
    if (apiMessages.length > 0) {
      try {
        sqlite.mergeServerMessages(
          apiMessages.map(m => ({
            server_id: m.id || m.messageId,
            thread_id: m.thread_id || null, // V2 thread_id (if present)
            from_handle: m.from,
            to_handle: m.to || (m.from === myHandle ? theirHandle : myHandle),
            content: m.body || m.text || '', // V2 uses 'body'
            created_at: m.created_at || m.createdAt || new Date().toISOString(),
            status: 'delivered',
            sent_at: m.sent_at || m.sentAt || m.created_at || m.createdAt,
            delivered_at: m.delivered_at || m.deliveredAt || m.created_at || m.createdAt
          }))
        );
      } catch (sqliteError) {
        console.warn('[SQLite] Failed to merge messages:', sqliteError.message);
      }
    }

    // 4. Return merged result (prefer API for latest, fallback to local)
    const messages =
      apiMessages.length > 0
        ? apiMessages
        : localMessages.map(m => ({
            id: m.server_id,
            from: m.from_handle,
            to: m.to_handle,
            body: m.content, // V2 uses 'body'
            created_at: m.created_at
          }));

    return messages.map(m => ({
      from: m.from,
      isAgent: m.isAgent || m.is_agent || false,
      body: m.body || m.text || m.content || '', // V2: m.body, fallback to legacy
      payload: m.payload || null,
      timestamp: new Date(m.created_at || m.createdAt).getTime(),
      direction: m.direction
    }));
  } catch (e) {
    console.error('Thread failed:', e.message);

    // Fallback to SQLite if API fails
    try {
      const localMessages = sqlite.getThreadMessages(myHandle, theirHandle);
      return localMessages.map(m => ({
        from: m.from_handle,
        isAgent: false,
        body: m.content,
        payload: null,
        timestamp: new Date(m.created_at).getTime(),
        direction: m.from_handle === myHandle ? 'sent' : 'received'
      }));
    } catch (sqliteError) {
      return [];
    }
  }
}

async function markThreadRead(myHandle, theirHandle) {
  // No-op: Backend automatically marks messages as read when getThread() is called
  // See: api/messages.js thread endpoint (GET /api/messages?user=X&with=Y)
}

// ============ CONSENT ============

async function getConsentStatus(from, to) {
  try {
    const result = await request('GET', `/api/consent?from=${from}&to=${to}`);
    return result;
  } catch (e) {
    console.error('Consent check failed:', e.message);
    return { status: 'none' };
  }
}

async function getPendingConsents(handle) {
  try {
    const result = await request('GET', '/api/consent');
    return result.pending || [];
  } catch (e) {
    console.error('Pending consents failed:', e.message);
    return [];
  }
}

async function acceptConsent(from, to) {
  try {
    const result = await request('POST', '/api/consent', {
      action: 'accept',
      from,
      to
    });
    return result;
  } catch (e) {
    console.error('Accept consent failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function blockUser(from, to) {
  try {
    const result = await request('POST', '/api/consent', {
      action: 'block',
      from,
      to
    });
    return result;
  } catch (e) {
    console.error('Block failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ============ STATS ============

async function getStats() {
  try {
    const result = await request('GET', '/api/stats');
    return result;
  } catch (e) {
    console.error('Stats failed:', e.message);
    return { success: false };
  }
}

// ============ INVITES ============

async function generateInviteCode(handle) {
  try {
    const result = await request('POST', '/api/invites', { handle });
    return result;
  } catch (e) {
    console.error('Generate invite failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function getMyInvites(handle) {
  try {
    const result = await request('GET', `/api/invites/my?handle=${handle}`);
    return result;
  } catch (e) {
    console.error('Get invites failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function submitReport({ reporter, reported, reason, message_id, details }) {
  const result = await request('POST', '/api/report', {
    reporter,
    reported,
    reason,
    message_id,
    details
  });
  return result;
}

async function checkInviteCode(code) {
  try {
    const result = await request('GET', `/api/invites?code=${code}`);
    return result;
  } catch (e) {
    console.error('Check invite failed:', e.message);
    return { valid: false, error: e.message };
  }
}

// ============ AUTH ============

/**
 * Verify a Privy token with the server
 * @param {string} token - Privy JWT token
 * @returns {Promise<{valid: boolean, handle?: string, error?: string}>}
 */
async function verifyPrivyToken(token) {
  try {
    const result = await request('POST', '/api/auth/verify', {}, { token, auth: true });

    if (result.valid) {
      return {
        valid: true,
        handle: result.handle,
        userId: result.userId,
        github: result.github,
        expiresAt: result.expiresAt
      };
    }

    return {
      valid: false,
      error: result.error || 'Token verification failed'
    };
  } catch (e) {
    return {
      valid: false,
      error: e.message
    };
  }
}

// ============ HELPERS ============

function formatTimeAgo(timestamp) {
  if (timestamp === undefined || timestamp === null || isNaN(timestamp)) return 'unknown';

  const now = Date.now();
  const seconds = Math.floor((now - timestamp) / 1000);

  if (seconds < 0 || isNaN(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ============ AWAY STATUS ============

// Local cache for away status (also sent to server via heartbeat)
let awayStatusCache = null;

/**
 * Set away status with optional message
 * @param {string} handle - User handle
 * @param {string} status - 'away' or 'online'
 * @param {string|null} message - Custom away message
 */
async function setAwayStatus(handle, status, message = null) {
  const awayAt = new Date().toISOString();

  // Cache locally
  awayStatusCache = {
    status,
    message,
    awayAt
  };

  // Send via heartbeat to server
  const one_liner = config.getBuildingMessage?.() || 'Building something';
  await heartbeat(handle, one_liner, {
    mood: '☕', // AFK emoji
    awayMessage: message,
    awayAt: awayAt
  });

  return { success: true };
}

/**
 * Get current away status
 * @param {string} handle - User handle
 */
async function getAwayStatus(handle) {
  return awayStatusCache;
}

/**
 * Clear away status (user is back)
 * @param {string} handle - User handle
 */
async function clearAwayStatus(handle) {
  const wasAway = awayStatusCache;
  awayStatusCache = null;

  // Send heartbeat with cleared away status
  const one_liner = config.getBuildingMessage?.() || 'Building something';
  await heartbeat(handle, one_liner, {
    mood: null, // Clear mood
    awayMessage: null,
    awayAt: null
  });

  return wasAway;
}

// ============ ONBOARDING ============

/**
 * Get onboarding checklist status for a user
 * @param {string} handle - User handle
 * @returns {Promise<{success: boolean, tasks: Array, progress: Object}>}
 */
async function getChecklistStatus(handle) {
  try {
    const result = await request('GET', `/api/onboarding/checklist?handle=${encodeURIComponent(handle)}`);
    return result;
  } catch (e) {
    console.error('Get checklist status failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ============ ARTIFACTS ============

/**
 * Create a new artifact
 * @param {Object} artifact - Artifact object with all metadata
 */
async function createArtifact(artifact) {
  try {
    const result = await request('POST', '/api/artifacts', artifact);

    if (result.success === false) {
      return { success: false, error: result.error || 'API request failed' };
    }

    if (!result.artifact_id) {
      return { success: false, error: 'Invalid API response - missing artifact_id' };
    }

    return {
      success: true,
      artifact_id: result.artifact_id,
      slug: result.slug,
      url: result.url
    };
  } catch (e) {
    console.error('Create artifact failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Get an artifact by slug
 * @param {string} slug - Artifact slug
 */
async function getArtifact(slug) {
  try {
    const result = await request('GET', `/api/artifacts/${slug}`);

    if (result.success === false) {
      return { success: false, error: result.error || 'Not found' };
    }

    return {
      success: true,
      artifact: result.artifact
    };
  } catch (e) {
    console.error('Get artifact failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * List artifacts
 * @param {Object} options - { scope: 'mine'|'for-me'|'network', handle, limit }
 */
async function listArtifacts(options) {
  try {
    const { scope, handle, limit = 10 } = options;
    const params = new URLSearchParams({ scope, handle, limit: limit.toString() });
    const result = await request('GET', `/api/artifacts?${params}`);

    if (result.success === false) {
      return { success: false, error: result.error || 'List failed' };
    }

    return {
      success: true,
      artifacts: result.artifacts || [],
      total: result.total || 0
    };
  } catch (e) {
    console.error('List artifacts failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send artifact card via DM
 * @param {string} to - Recipient handle
 * @param {Object} card - Artifact card data
 */
async function sendArtifactCard(to, card) {
  try {
    const from = config.getHandle();

    // Format as a rich message with artifact card embedded
    const body = `📦 ${card.preview.creator} shared an artifact with you:\n\n**${card.preview.title}**\n${card.preview.snippet}\n\n🔗 ${card.url}\n\n_${card.context}_`;

    const result = await sendMessage({ from, to, body });
    return result;
  } catch (e) {
    console.error('Send artifact card failed:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  // Session
  registerSession,
  setSessionId,
  getSessionId,

  // Presence
  heartbeat,
  getActiveUsers,
  setVisibility,
  sendTypingIndicator,
  getTypingUsers,

  // Messages
  sendMessage,
  getInbox,
  getRawInbox,
  getUnreadCount,
  getThread,
  markThreadRead,

  // Consent
  getConsentStatus,
  getPendingConsents,
  acceptConsent,
  blockUser,

  // Stats
  getStats,

  // Invites
  generateInviteCode,
  getMyInvites,
  checkInviteCode,

  // Reports
  submitReport,

  // Helpers
  formatTimeAgo,

  // Away Status
  setAwayStatus,
  getAwayStatus,
  clearAwayStatus,

  // Artifacts
  createArtifact,
  getArtifact,
  listArtifacts,
  sendArtifactCard,

  // Onboarding
  getChecklistStatus,

  // Auth
  verifyPrivyToken
};
