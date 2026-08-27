/**
 * Private Personal Mind transport for terminal hosts.
 *
 * This module is deliberately unable to call Platform. It accepts only the
 * unsent active draft and up to eight recent visible messages, calls one fixed
 * Tailnet origin, and writes nothing. The bearer stays in a regular 0600 file
 * under the current identity directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const { vibeHome } = require('./vibe-home');

const MIND_ORIGIN = 'http://100.121.205.111:7788';
const MAX_HANDLE_BYTES = 64;
const MAX_DRAFT_BYTES = 4_000;
const MAX_CONTEXT_BYTES = 2_000;
const MAX_RECENT_MESSAGES = 8;
const MAX_RESPONSE_BYTES = 256 * 1_024;

function tokenPath() {
  return path.join(vibeHome(), 'mind', 'runtime-token');
}

function readPrivateToken(file = tokenPath()) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const token = fs.readFileSync(file, 'utf8').trim();
    const size = Buffer.byteLength(token, 'utf8');
    if (size < 24 || size > 512 || /\s/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

function isAvailable() {
  return readPrivateToken() !== null;
}

function validHandle(handle) {
  return typeof handle === 'string'
    && Buffer.byteLength(handle, 'utf8') > 0
    && Buffer.byteLength(handle, 'utf8') <= MAX_HANDLE_BYTES
    && /^@?[a-zA-Z0-9_-]+$/.test(handle);
}

function utf8Prefix(value, limit) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > limit) break;
    out += char;
  }
  return out;
}

function recentContext(messages) {
  if (!Array.isArray(messages)) return '';
  const visible = messages.slice(-MAX_RECENT_MESSAGES).map((message) => {
    const from = String(message?.from || '').replace(/[\r\n]/g, ' ').slice(0, 64);
    const text = String(message?.text || '').replace(/\r\n?/g, '\n');
    return `${from || 'unknown'}: ${text}`;
  }).join('\n');
  return utf8Prefix(visible, MAX_CONTEXT_BYTES);
}

async function boundedJSON(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) return null;
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) return null;
    return JSON.parse(bytes.toString('utf8'));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function post(route, payload, token, timeoutMs, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${MIND_ORIGIN}${route}`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return await boundedJSON(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ask({ handle, draft, recentMessages = [] }, fetchImpl = global.fetch) {
  const normalizedHandle = String(handle || '').replace(/^@/, '').trim();
  const activeDraft = String(draft || '');
  if (!validHandle(normalizedHandle) || !activeDraft.trim()) return { error: 'invalid_input' };
  if (Buffer.byteLength(activeDraft, 'utf8') > MAX_DRAFT_BYTES) {
    return { error: 'draft_too_large' };
  }
  const token = readPrivateToken();
  if (!token) return { error: 'unavailable' };

  const context = recentContext(recentMessages);
  if (context) {
    // Priming is an optimization. A miss or timeout falls through to the same
    // slow-path facet request; composing and sending never depend on it.
    await post('/prime', { handle: normalizedHandle, context }, token, 180_000, fetchImpl);
  }
  const facet = await post(
    '/facet',
    { handle: normalizedHandle, draft: activeDraft },
    token,
    90_000,
    fetchImpl,
  );
  if (!facet || facet.silence) return { silence: true };
  return { facet };
}

module.exports = {
  MIND_ORIGIN,
  MAX_DRAFT_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_RECENT_MESSAGES,
  tokenPath,
  readPrivateToken,
  isAvailable,
  recentContext,
  ask,
};
