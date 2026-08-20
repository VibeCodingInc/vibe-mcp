/**
 * Host — which coding agent is this MCP server living inside?
 *
 * /vibe presence should say not just "someone is here via mcp" but WHICH
 * terminal agent their session runs in (Claude Code, Codex, Cursor, …).
 * That's the proof of the heterogeneous claim: distinct agent types on the
 * buddy list, one MCP server serving all of them.
 *
 * Detection, in priority order:
 *   1. MCP `initialize` clientInfo.name — the host names itself; index.js
 *      calls setClientInfo() when the handshake arrives.
 *   2. Environment fingerprints — fallback for hosts whose clientInfo is
 *      missing or generic.
 * The raw name is preserved alongside the normalized slug so unknown hosts
 * still show up honestly instead of as "unknown".
 */

let clientInfo = null; // { name, version } from the MCP initialize handshake

function setClientInfo(info) {
  if (info && typeof info.name === 'string') {
    clientInfo = { name: info.name, version: info.version || null };
  }
}

// Map a client-reported name to a KNOWN host slug, or null if unrecognized.
// Word-boundary matching so e.g. "customized-client" doesn't hit the zed rule.
const KNOWN_HOSTS = [
  [/\bclaude\b/, 'claude-code'],
  [/\bcodex\b/, 'codex'],
  [/\bcursor\b/, 'cursor'],
  [/\bwindsurf\b/, 'windsurf'],
  [/\bcline\b/, 'cline'],
  [/\bzed\b/, 'zed'],
  [/\bgemini\b/, 'gemini-cli'],
];

function knownHost(name) {
  const n = (name || '').toLowerCase();
  if (!n) return null;
  for (const [re, slug] of KNOWN_HOSTS) {
    if (re.test(n)) return slug;
  }
  return null;
}

// Slug an unknown host name so it still shows up honestly in presence.
function slugify(name) {
  const n = (name || '').toLowerCase();
  return n.replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || null;
}

function envFingerprint() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex';
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_CHANNEL) return 'cursor';
  return null;
}

/**
 * The host agent this server is running inside.
 * Precedence: recognized clientInfo name → env fingerprint → slug of whatever
 * the client called itself → 'terminal'. A generic/unknown clientInfo name
 * (e.g. "mcp-client") must NOT defeat a definitive env fingerprint.
 * @returns {{ agent: string, version: string|null }}
 */
function getHost() {
  const agent =
    knownHost(clientInfo?.name) ||
    envFingerprint() ||
    slugify(clientInfo?.name) ||
    'terminal';
  return { agent, version: clientInfo?.version || null };
}

module.exports = { setClientInfo, getHost };
