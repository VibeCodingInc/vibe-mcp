/**
 * API Store — Messages and presence via remote API
 *
 * Uses VIBE_API_URL environment variable
 * Uses HMAC-signed tokens for authentication
 * AIRC v0.1: Ed25519 message signing
 */

const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const config = require('../config');
const crypto = require('../crypto');
const authStore = require('../auth-store');

const API_URL = process.env.VIBE_API_URL || 'https://www.slashvibe.dev';

// Default timeout for API requests (10 seconds)
const REQUEST_TIMEOUT = 10000;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 500; // 500ms
const MAX_RETRY_DELAY = 5000; // 5 seconds

/**
 * Calculate exponential backoff delay with jitter
 * @param {number} attempt - Current attempt number (0-based)
 * @returns {number} Delay in milliseconds
 */
function getBackoffDelay(attempt) {
  const exponentialDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY);
}

/**
 * Sleep for a given duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Force reload of config module to pick up auth changes
 * This clears the require cache and reloads the config from disk
 */
function reloadConfig() {
  try {
    // Clear the config module from require cache
    const configPath = require.resolve('../config');
    delete require.cache[configPath];
    // Re-require to get fresh module
    return require('../config');
  } catch (e) {
    console.error('[api] Failed to reload config:', e.message);
    return config;
  }
}

/**
 * Internal single request (no retries)
 */
function requestOnce(method, path, data = null, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const timeout = options.timeout || REQUEST_TIMEOUT;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'vibe-mcp/1.0'
    };

    // Add auth token: priority is explicit option > in-memory store > config file
    // authStore is the SOURCE OF TRUTH during runtime (immediate updates from OAuth)
    const token = options.token || authStore.getToken() || config.getAuthToken();
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

    const req = client.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        // Handle non-2xx responses
        if (res.statusCode >= 400) {
          // 401 REFRESH: If unauthorized and haven't retried, try to recover
          if (res.statusCode === 401 && !options._retried && options.auth !== false) {
            console.error('[api] 401 received, attempting token refresh...');

            // First, reload config from disk (in case token was saved but not pushed to store)
            const freshConfig = reloadConfig();
            const diskToken = freshConfig.getAuthToken();

            // If disk has a different token, sync it to the auth store
            if (diskToken && diskToken !== authStore.getToken()) {
              console.error('[api] Found newer token on disk, syncing to auth store...');
              authStore.setToken(diskToken);
            }

            // Now check if we have a fresh token to retry with
            const freshToken = authStore.getToken() || diskToken;

            // Only retry if we got a different/new token
            if (freshToken && freshToken !== token) {
              console.error('[api] Found fresh token, retrying request...');
              try {
                const retryResult = await request(method, path, data, {
                  ...options,
                  token: freshToken,
                  _retried: true
                });
                resolve(retryResult);
                return;
              } catch (retryError) {
                console.error('[api] Retry failed:', retryError.message);
              }
            } else {
              console.error('[api] No fresh token found, not retrying');
            }
          }

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
      resolve({ success: false, error: 'Request timeout', timeout: true, retryable: true });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: e.message, network: true, retryable: true });
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

/**
 * Make HTTP request with exponential backoff retry for transient failures
 */
async function request(method, path, data = null, options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const skipRetry = options._skipRetry || false;

  // Don't retry if explicitly disabled or already in a retry chain
  if (skipRetry || maxRetries === 0) {
    return requestOnce(method, path, data, options);
  }

  let lastResult;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await requestOnce(method, path, data, { ...options, _skipRetry: true });

    // Success or non-retryable error - return immediately
    if (!lastResult.retryable) {
      return lastResult;
    }

    // Don't retry on last attempt
    if (attempt < maxRetries) {
      const delay = getBackoffDelay(attempt);
      console.error(`[api] Retrying ${method} ${path} in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay);
    }
  }

  // All retries exhausted
  console.error(`[api] All ${maxRetries} retries failed for ${method} ${path}`);
  return lastResult;
}

// ============ PRESENCE ============

// Use v2 API by default (Postgres-backed)
const USE_V2_PRESENCE = process.env.VIBE_PRESENCE_V1 !== 'true';

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

    const result = await request('POST', '/api/presence', registrationData, { auth: false });  // Don't send token for registration (we don't have one yet)

    if (result.success && result.token) {
      // Use server-issued sessionId and token (not client-generated)
      currentSessionId = result.sessionId;

      // Save token for future authenticated requests (persist to shared config)
      config.saveAuthToken(result.token);

      console.error(`[vibe] Registered @${handle} with session ${result.sessionId}`);
    } else if (result.success) {
      // Fallback for servers that don't yet return tokens
      currentSessionId = sessionId;
      console.error(`[vibe] Registered @${handle} (legacy mode)`);
    }

    // Also register user in users DB (for @seth welcome tracking)
    // AIRC: Include public key for identity
    try {
      const userData = {
        username: handle,
        building: building || 'something cool'
      };
      if (publicKey) {
        userData.publicKey = publicKey;
      }
      await request('POST', '/api/users', userData, { auth: false });  // User registration doesn't need auth
    } catch (e) {
      // Non-fatal if user registration fails
    }

    return result;
  } catch (e) {
    console.error('Session registration failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function heartbeat(handle, one_liner, context = null) {
  try {
    const endpoint = USE_V2_PRESENCE ? '/api/v2/presence' : '/api/presence';

    // Always include cwd + sessionId so the server can record a per-session beacon
    // for the "My Sessions" feature.  path.basename is CJS-safe here.
    const cwd = process.cwd();
    const project = require('path').basename(cwd);
    const sessionId = config.getSessionId();

    // Which coding agent hosts this session (claude-code / codex / cursor / …)
    // — from the MCP initialize handshake, env fingerprint fallback. Persisted
    // server-side as client_name, so presence can show and count distinct
    // agent types (the heterogeneous-sessions proof).
    const host = require('../host').getHost();

    // Build payload
    const payload = {
      workingOn: one_liner,
      source: 'mcp',
      clientName: host.agent,
      ...(host.version ? { clientVersion: host.version } : {}),
      ttl_seconds: 120,
      // Session beacon fields — always sent so server can track live sessions
      cwd,
      project,
      sessionId,
    };

    // Fallback: if no token, send username (legacy support)
    if (!config.getAuthToken()) {
      payload.username = handle;
    }

    // Add context fields (v2 flattens these)
    if (context) {
      if (USE_V2_PRESENCE) {
        // v2: flat structure
        if (context.mood) payload.mood = context.mood;
        if (context.file) payload.file = context.file;
        if (context.project) payload.project = context.project || project;
        if (context.awayMessage) payload.awayMessage = context.awayMessage;
        if (context.sessionId) payload.sessionId = context.sessionId || sessionId;
        if (context.availableFor !== undefined) payload.availableFor = context.availableFor;
        if (context.model) payload.model = context.model;
      } else {
        // v1: nested context
        payload.context = context;
      }
    }

    await request('POST', endpoint, payload);
  } catch (e) {
    console.error('Heartbeat failed:', e.message);
  }
}

async function sendTypingIndicator(handle, toHandle) {
  try {
    // Use dedicated typing API with 5s TTL
    await request('POST', '/api/typing', {
      from: handle,
      to: toHandle,
    });
  } catch (e) {
    // Silent fail - typing is best-effort
  }
}

async function getTypingUsers(forHandle) {
  try {
    // Use dedicated typing API to get all users typing to forHandle
    const result = await request('GET', `/api/typing?to=${forHandle}`);
    return result.typing || [];
  } catch (e) {
    return [];
  }
}

async function getActiveUsers() {
  try {
    const endpoint = USE_V2_PRESENCE ? '/api/v2/presence' : '/api/presence';
    const result = await request('GET', endpoint);

    // Combine active + away, plus any AGENTS currently live in a room (e.g.
    // @coltrane hosting the cantina). Agents live in their own array; without
    // this a live agent host never reached the footer's live-room line.
    const liveAgents = (result.agents || []).filter(a => a.isLive && a.broadcastRoom);
    const users = [...(result.active || []), ...(result.away || []), ...liveAgents];

    // SIGNED OUT IS NOT AN EMPTY ROOM.
    //
    // When the caller has no valid credential the server answers `anonymous: true` with
    // empty lists and PUBLIC COUNTS — "2 people are here, sign in to see who". This
    // function used to return only the mapped array, so every caller saw `[]` and could
    // not tell the two apart. `vibe_who` rendered it as "Quiet right now — you're the
    // only one here", which is the most damaging sentence this product can say: the
    // entire promise is that other people are there, and a signed-out user was told the
    // room was dead. Observed on the Mac Studio 2026-08-01 with a token that had expired
    // 23 days earlier, while four people were actually online.
    //
    // Attached to the array rather than changing the return type because sixteen call
    // sites read this as a list. Callers that do not care are unaffected; callers that
    // render a claim about the room now have what they need to be honest.
    // Two shapes mean the same thing. v1 answers 200 with `anonymous: true` and public
    // COUNTS; v2 answers a hard 401 and no counts at all. Both are "we cannot see who is
    // here", and neither is "nobody is here" — so both must reach the caller as the same
    // fact, with counts present only when the server actually supplied them. Claiming
    // "0 people are here" because we lack a number would swap one false statement for
    // another.
    const unauthenticated = result?.anonymous === true || result?.statusCode === 401;

    // Map to normalized format (v2 uses 'handle', v1 uses 'username')
    const mappedUsers = users.map(u => ({
      handle: u.handle || u.username,
      one_liner: u.workingOn,
      lastSeen: new Date(u.lastSeen).getTime(),
      firstSeen: u.firstSeen ? new Date(u.firstSeen).getTime() : null,
      status: u.status,
      // Mood: v2 is flat, v1 is nested
      mood: u.mood || u.context?.mood || null,
      mood_inferred: u.mood_inferred || false,
      mood_reason: u.mood_reason || null,
      builderMode: u.builderMode || null,
      // Context sharing fields
      file: u.file || u.context?.file || null,
      branch: u.branch || u.context?.branch || null,
      repo: u.repo || u.context?.repo || null,
      error: u.error || u.context?.error || null,
      note: u.note || u.context?.note || null,
      // Away status
      awayMessage: u.awayMessage || u.context?.awayMessage || null,
      awayAt: u.awayAt || u.context?.awayAt || null,
      // v2 additions
      isLive: u.isLive || false,
      broadcastRoom: u.broadcastRoom || u.r || null, // room slug when live
      isAgent: u.isAgent || u.is_agent || false,
      // Who runs the agent — rendered as "(op: @handle)" so an agent is never
      // mistaken for its operator. Only meaningful alongside isAgent.
      operator: u.operator || null,
      // Presence texture (server-enriched): most-recent ship
      lastShip: u.lastShip || null
    }));

    // Sync presence data to local profiles (non-blocking)
    // This enables discovery to find users by what they're building
    try {
      const profiles = require('./profiles');
      profiles.syncFromPresence(mappedUsers).then(synced => {
        if (synced > 0) {
          // Auto-infer interests for new/updated profiles
          profiles.inferMissingInterests().catch(e =>
            console.error('[presence] interest inference failed:', e.message)
          );
        }
      }).catch(e => console.error('[presence] sync failed:', e.message));
    } catch (e) {
      // Non-fatal: profiles module may not be available in some contexts
    }

    // On the RETURNED array, not the intermediate `users` — they are different objects
    // and attaching to the wrong one is a silent no-op that reads as "the signal is not
    // there" rather than as a bug.
    Object.defineProperties(mappedUsers, {
      anonymous: { value: unauthenticated, enumerable: false },
      counts: { value: result?.counts || null, enumerable: false },
    });

    return mappedUsers;
  } catch (e) {
    console.error('Who failed:', e.message);
    return [];
  }
}

async function setVisibility(handle, visible) {
  try {
    const endpoint = USE_V2_PRESENCE ? '/api/v2/presence' : '/api/presence';
    const result = await request('POST', endpoint, {
      action: 'visibility',
      visible: visible
    });

    if (result.success === false) {
      console.error('[setVisibility] API error:', result.error);
      return { success: false, error: result.error };
    }

    return { success: true, visible };
  } catch (e) {
    console.error('[setVisibility] Error:', e.message);
    return { success: false, error: e.message };
  }
}

// ============ MESSAGES ============

// Use v2 API by default (Postgres-backed, cross-client sync)
const USE_V2_MESSAGES = process.env.VIBE_MESSAGES_V1 !== 'true';

async function sendMessage(from, to, body, type = 'dm', payload = null, options = {}) {
  try {
    let data;
    let endpoint = '/api/messages';
    // Generated once per logical store call, outside request()'s retry loop. Every
    // transport retry therefore carries the same key and cannot insert a second DM.
    const idempotencyKey = options.idempotencyKey || randomUUID();

    // V2 API: Uses Postgres, simpler payload
    const hasAuth = config.hasOAuth();
    console.error('[vibe] sendMessage check: USE_V2_MESSAGES=' + USE_V2_MESSAGES + ', hasOAuth=' + hasAuth);
    if (USE_V2_MESSAGES && hasAuth) {
      endpoint = '/api/v2/messages';
      data = {
        to,
        body: body || '',
        payload: payload || undefined,
        idempotency_key: idempotencyKey,
        reply_to: options.replyTo || undefined,  // Threaded reply support
        origin: options.origin || undefined,     // work-object lifecycle state
      };
      console.error('[vibe] Sending message via v2 API (Postgres-backed) to:', to, 'body length:', (body || '').length);
    }
    // V1 with OAuth (server-side signing)
    else if (config.hasOAuth()) {
      // OAuth flow - server handles signing
      // Just send message data, server signs it
      data = { to, body: body || undefined, text: body };
      if (payload) data.payload = payload;

      console.error('[vibe] Sending message via OAuth (server-side signing)');
    } else {
      // LEGACY: Create signed message if we have a keypair
      const keypair = config.getKeypair();

      if (keypair) {
        // Full AIRC-compliant signed message
        data = crypto.createSignedMessage({
          from,
          to,
          body: body || undefined,
          payload: payload || undefined
        }, keypair.privateKey);

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

    console.error('[vibe] Sending request to endpoint:', endpoint, 'with data:', JSON.stringify(data).substring(0, 200));
    const result = await request('POST', endpoint, data);
    console.error('[vibe] Got result:', JSON.stringify(result).substring(0, 300));

    // Handle auth errors
    if (!result.success && result.error?.includes('Authentication')) {
      console.error('[vibe] Auth failed for message. Try `vibe init` to re-register.');
      return { error: 'auth_failed', message: 'Authentication failed. Try `vibe init` to re-register.' };
    }

    // Handle 401 — distinguish "never signed in" from "session expired".
    // Sending a DM requires GitHub OAuth; reads (presence/inbox) are open.
    // A misleading "expired" message here is a first-session papercut for the pilot.
    if (result.statusCode === 401) {
      if (!config.hasOAuth()) {
        console.error('[vibe] DM requires sign-in. Run `vibe init` (GitHub OAuth).');
        return {
          error: 'not_signed_in',
          message: "You're not signed in yet — sending a DM needs a /vibe identity. Run `vibe init` to sign in with GitHub (opens a browser, no input needed), then try again.",
        };
      }
      console.error('[vibe] Auth expired. Run `vibe init` to reconnect.');
      return { error: 'auth_expired', message: 'Your /vibe session expired. Run `vibe init` to reconnect.' };
    }

    // Handle storage errors (KV write failed)
    if (!result.success && result.error === 'storage_error') {
      console.error('[vibe] Storage error:', result.details || result.message);
      return { error: 'storage_error', message: result.message || 'Failed to save message. Please try again.' };
    }

    // Handle other errors
    if (!result.success && result.error) {
      console.error('[vibe] Send error:', result.error, result.message);
      return { error: result.error, message: result.message || 'Failed to send message.' };
    }

    // Emit list_changed notification for successful message send
    // This allows other Claude Code instances to see the new message instantly
    if (result.success || result.message) {
      if (global.vibeNotifier) {
        global.vibeNotifier.emitImmediate(); // Immediate for DMs
      }
    }

    // A success with no message body must still come back truthy — callers read
    // a falsy return as "nothing was delivered".
    // The server's explicit receipt fields (storedLength, serverTimestamp) ride
    // along so the tool can show what was actually stored — the Stage-0 brief
    // truncation went unnoticed for a day because success carried no receipt.
    if (result.message && typeof result.message === 'object') {
      return {
        ...result.message,
        storedLength: result.storedLength ?? result.message.storedLength ?? null,
        serverTimestamp: result.serverTimestamp ?? result.message.created_at ?? null,
      };
    }
    return result.message || { success: true };
  } catch (e) {
    // This returned null, which dm/reply could not tell apart from success — a
    // dead network produced "Sent to @x". Failure is a first-class shape: an
    // error code and a message that names the one useful next action.
    console.error('Send failed:', e.message);
    return {
      error: 'transport_failed',
      message: "That didn't send — the connection dropped mid-request. Nothing was delivered. Worth one retry; if it keeps failing, say `vibe help troubleshooting`.",
    };
  }
}

async function getInbox(handle) {
  try {
    // V2: Use threads endpoint (Postgres-backed, cross-client sync)
    if (USE_V2_MESSAGES) {
      const result = await request('GET', '/api/v2/threads');

      if (result.success === false) {
        console.error('[getInbox] V2 API error:', result.error);
        // Fall back to v1
        return getInboxV1(handle);
      }

      // Map v2 response to expected format
      return (result.threads || []).map(t => ({
        handle: t.with,
        thread_id: t.id,
        messages: [],  // Not loaded until thread is opened
        unread: t.unread || 0,
        lastMessage: t.last_message?.body,
        lastMessageId: t.last_message?.id || null,
        lastFrom: t.last_message?.from || null,
        muted: t.preferences?.muted || false,
        lastTimestamp: t.last_message?.created_at ? new Date(t.last_message.created_at).getTime() : null
      }));
    }

    // V1 fallback
    return getInboxV1(handle);
  } catch (e) {
    console.error('Inbox failed:', e.message);
    return [];
  }
}

// V1 inbox implementation (now handles V2 format since /api/messages returns V2)
async function getInboxV1(handle) {
  try {
    // /api/messages now returns V2 format: { threads, total_unread }
    const result = await request('GET', `/api/messages?user=${handle}`);

    // Check for API errors (auth failures, etc.)
    if (result.success === false) {
      console.error('[getInbox] API error:', result.error, result.message);
      return [];
    }

    // V2 format: map threads to expected format
    if (result.threads) {
      return result.threads.map(t => ({
        handle: t.with,
        thread_id: t.id,
        messages: [],
        unread: t.unread || 0,
        lastMessage: t.last_message?.body,
        lastTimestamp: t.last_message?.created_at ? new Date(t.last_message.created_at).getTime() : null
      }));
    }

    // Legacy V1 format (bySender) - kept for backwards compatibility
    const bySender = result.bySender || {};
    return Object.entries(bySender).map(([sender, messages]) => ({
      handle: sender,
      messages: messages.map(m => ({
        from: m.from,
        body: m.text,
        timestamp: new Date(m.createdAt).getTime(),
        read: m.read
      })),
      unread: messages.filter(m => !m.read).length,
      lastMessage: messages[0]?.text,
      lastTimestamp: new Date(messages[0]?.createdAt).getTime()
    }));
  } catch (e) {
    console.error('Inbox v1 failed:', e.message);
    return [];
  }
}

async function getUnreadCount(handle) {
  try {
    // V2: Get from threads endpoint
    if (USE_V2_MESSAGES) {
      const result = await request('GET', '/api/v2/threads');
      if (result.success !== false) {
        return result.total_unread || 0;
      }
    }

    // V1 fallback
    const result = await request('GET', `/api/messages?user=${handle}`);
    return result.unread || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Get count of active live broadcasts
 * Used in presence footer to show "X live now"
 */
async function getLiveBroadcastCount() {
  try {
    const result = await request('GET', '/api/watch', null, { auth: false });
    if (result.broadcasts) {
      return Object.keys(result.broadcasts).length;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// Get raw inbox messages (for notification checks)
// V2: Fetches threads and constructs message objects from unread threads
// Read state is synced via Postgres cursors, so if you read on iOS it's reflected here
async function getRawInbox(handle) {
  try {
    // V2: Get threads with unread counts (read state synced via Postgres)
    const result = await request('GET', `/api/messages?user=${handle}`);

    // V2 format: { threads, total_unread }
    const threads = result.threads || [];

    // Transform threads with unread messages into message-like objects
    // for compatibility with notification system
    const unreadMessages = [];

    for (const thread of threads) {
      if (thread.unread > 0 && thread.last_message) {
        // Create message object from thread's last message
        unreadMessages.push({
          id: thread.last_message.id,
          from: thread.last_message.from,
          to: handle,
          text: thread.last_message.body,
          body: thread.last_message.body,
          createdAt: thread.last_message.created_at,
          read: false, // If it's in unread threads, it's unread
          thread_id: thread.id,
          unread_count: thread.unread,
        });
      }
    }

    return unreadMessages;
  } catch (e) {
    console.error('[getRawInbox] Error:', e.message);
    return [];
  }
}

async function getThreadWithRequest(makeRequest, myHandle, theirHandle) {
  const result = await makeRequest(
    'GET',
    `/api/messages?user=${encodeURIComponent(myHandle)}&with=${encodeURIComponent(theirHandle)}&limit=200`,
    null
  );

  if (result.success === false) {
    throw new Error(result.message || result.error || 'Thread request failed');
  }

  // The proxy accepts both its current snake_case response and the legacy row
  // names used by older deployments. Keep the array contract for callers while
  // carrying response metadata alongside it for a lookup-free read PATCH.
  const rows = result.messages || result.thread || [];
  const messages = rows.map(m => ({
    id: m.id || null,
    from: m.from,
    isAgent: m.isAgent || m.is_agent || false,
    body: m.body ?? m.text,
    // Reply linkage — served by the API since the v2 thread read; this mapper
    // silently dropped it, which is why no surface could render "in reply to".
    // Shape: { id, from, text≤200 } or null. A deleted/hard-missing parent
    // arrives as null fields on the server side; render honestly, never guess.
    reply_to: m.reply_to || null,
    payload: m.payload || null,
    source_client: m.source_client || null,
    timestamp: new Date(m.created_at || m.createdAt).getTime(),
    direction: m.direction || (m.from === myHandle ? 'sent' : 'received'),
    readByThem: m.read_by_them || false,
  }));
  messages._threadId = result.thread_id || null;
  messages._lastMessageId = result.last_message_id || rows.at(-1)?.id || null;
  messages._theirReadCursor = result.their_read_cursor || null;
  return messages;
}

async function getThread(myHandle, theirHandle) {
  try {
    return await getThreadWithRequest(request, myHandle, theirHandle);
  } catch (e) {
    console.error('Thread failed:', e.message);
    return [];
  }
}

async function markThreadReadWithRequest(
  makeRequest,
  myHandle,
  theirHandle,
  lastMessageId = null,
  threadId = null
) {
  // V2: Explicit mark read via PATCH. The server requires last_read_id, so when
  // a caller lacks direct-response metadata, preserve the existing thread-list
  // fallback. Callers that already know the IDs must never pay for that lookup.
  if (USE_V2_MESSAGES) {
    try {
      let resolvedThreadId = threadId;
      let resolvedReadId = lastMessageId;

      if (!resolvedThreadId) {
        const threadsResult = await makeRequest('GET', '/api/v2/threads', null);
        if (threadsResult.success !== false) {
          const thread = (threadsResult.threads || []).find(t =>
            t.with?.toLowerCase() === theirHandle.toLowerCase()
          );
          resolvedThreadId = thread?.id || null;
          resolvedReadId = resolvedReadId || thread?.last_message?.id || null;
        }
      }

      if (resolvedThreadId && resolvedReadId) {
        await makeRequest('PATCH', `/api/v2/threads/${resolvedThreadId}/read`, {
          last_read_id: resolvedReadId,
          client: 'terminal'
        });
      }
    } catch (e) {
      console.error('[markThreadRead] V2 error:', e.message);
    }
  }

  // V1: No-op - Backend automatically marks messages as read when getThread() is called
  // See: api/messages.js thread endpoint (GET /api/messages?user=X&with=Y)
}

async function markThreadRead(myHandle, theirHandle, lastMessageId = null, threadId = null) {
  return markThreadReadWithRequest(
    request,
    myHandle,
    theirHandle,
    lastMessageId,
    threadId
  );
}

/**
 * Mark messages as delivered
 * Called when messages are received via SSE or poll
 * @param {string[]} messageIds - Array of message IDs to mark as delivered
 */
async function markMessagesDelivered(messageIds) {
  if (!messageIds || messageIds.length === 0) return { marked: 0 };

  try {
    const result = await request('POST', '/api/v2/messages/delivered', {
      message_ids: messageIds
    });

    return result;
  } catch (e) {
    console.error('[markMessagesDelivered] Error:', e.message);
    return { marked: 0, error: e.message };
  }
}

/**
 * Search messages
 * @param {string} query - Search term
 * @param {object} options - Search options
 * @param {string} [options.with] - Filter to conversation with specific user
 * @param {number} [options.limit] - Max results (default 50)
 */
async function searchMessages(query, options = {}) {
  try {
    let url = `/api/v2/messages/search?q=${encodeURIComponent(query)}`;

    if (options.with) {
      url += `&with=${encodeURIComponent(options.with)}`;
    }
    if (options.limit) {
      url += `&limit=${options.limit}`;
    }
    if (options.offset) {
      url += `&offset=${options.offset}`;
    }

    const result = await request('GET', url);

    if (result.success === false) {
      throw new Error(result.error || 'Search failed');
    }

    return result;
  } catch (e) {
    console.error('[searchMessages] Error:', e.message);
    throw e;
  }
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
 * Verify an auth token with the server
 * @param {string} token - JWT token from GitHub OAuth
 * @returns {Promise<{valid: boolean, definitive: boolean, handle?: string, error?: string}>}
 *   `definitive` is true only when the server actually answered. Callers deciding
 *   whether to DISCARD a session must check it: unreachable is not invalid.
 */
async function verifyAuthToken(token) {
  try {
    const result = await request('POST', '/api/auth/verify', {}, { token, auth: true });

    if (result.valid) {
      return {
        valid: true,
        definitive: true,
        handle: result.handle,
        userId: result.userId,
        github: result.github,
        expiresAt: result.expiresAt
      };
    }

    // The server answered and said no — a fact about the token.
    return {
      valid: false,
      definitive: true,
      error: result.error || 'Token verification failed'
    };
  } catch (e) {
    // No verdict was reached.
    return {
      valid: false,
      definitive: false,
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

/**
 * Track completion of an onboarding task
 * @param {string} handle - User handle
 * @param {string} taskId - Task ID (e.g., 'read_welcome', 'reply_seth')
 * @param {Object} metadata - Optional metadata about the completion
 * @returns {Promise<{success: boolean, taskId: string, completedAt: string}>}
 */
async function trackChecklistCompletion(handle, taskId, metadata = {}) {
  try {
    const result = await request('POST', '/api/onboarding/checklist', {
      handle,
      taskId,
      metadata
    });
    return result;
  } catch (e) {
    console.error('Track checklist completion failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Get onboarding data for a user (includes recommended builders)
 * @param {string} handle - User handle
 * @returns {Promise<{success: boolean, recommendedUsers: Array, ...}>}
 */
async function getOnboardingData(handle) {
  try {
    const result = await request('GET', `/api/onboarding/data?handle=${encodeURIComponent(handle)}`);
    return result;
  } catch (e) {
    console.error('Get onboarding data failed:', e.message);
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
 * Update an artifact by ID or slug
 * @param {string} idOrSlug - Artifact ID or slug
 * @param {Object} artifact - Updated artifact data
 */
async function updateArtifact(idOrSlug, artifact) {
  try {
    const result = await request('PUT', `/api/artifacts/${idOrSlug}`, artifact);

    if (result.success === false) {
      return { success: false, error: result.error || 'Update failed' };
    }

    return {
      success: true,
      artifact: result.artifact
    };
  } catch (e) {
    console.error('Update artifact failed:', e.message);
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

// The "slower" primitive — set your one notification pace (normal|slower|quiet).
async function setNotificationPace(pace) {
  try {
    return await request('POST', '/api/settings/notifications', { action: 'set_pace', pace });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  setNotificationPace,
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
  markMessagesDelivered,
  searchMessages,

  // Watch Me Code
  getLiveBroadcastCount,

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
  updateArtifact,
  listArtifacts,
  sendArtifactCard,

  // Onboarding
  getChecklistStatus,
  trackChecklistCompletion,
  getOnboardingData,

  // Hermetic request-count tests for the named-thread fast path.
  _testing: {
    getThreadWithRequest,
    markThreadReadWithRequest,
  },

  // Auth
  verifyAuthToken,
  verifyPrivyToken: verifyAuthToken  // Backwards compat alias
};
