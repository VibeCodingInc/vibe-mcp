#!/usr/bin/env node
'use strict';
// LAB ONLY. A host that cannot show /vibe's confirmation box, made from one
// that can.
//
//   node lab/no-box-proxy.cjs <server command> [args...]
//
// Starts the real /vibe server as a child, with this process's environment,
// and relays newline-delimited JSON-RPC both ways. Server -> client is passed
// through untouched (stdout and stderr). Client -> server is passed through
// unchanged EXCEPT that the client's elicitation capability is removed:
//   - `params.capabilities.elicitation` on `initialize` (protocol 2025-*);
//   - `params._meta["io.modelcontextprotocol/clientCapabilities"].elicitation`
//     on any request (2026-07-28 declares capabilities per request).
// A line that is not JSON, or carries no elicitation capability, is forwarded
// byte for byte. Ids and order are kept; a message split across chunks is
// reassembled at its newline. The client closing stdin closes the server's;
// the server's exit code is this process's exit code.
//
// The lab's `--no-box` mode (population.mjs) puts this in front of each
// session's server, so real Claude Code (which declares elicitation) is seen
// as a client without the box, and the server uses the turn check alone.

const { spawn } = require('child_process');

const CAPS = 'io.modelcontextprotocol/clientCapabilities';

/** Remove the elicitation capability from one message. Returns true if it changed. */
function strip(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  let changed = false;
  const params = msg.params;
  if (!params || typeof params !== 'object') return false;
  if (msg.method === 'initialize' && params.capabilities && typeof params.capabilities === 'object' && 'elicitation' in params.capabilities) {
    delete params.capabilities.elicitation;
    changed = true;
  }
  const caps = params._meta && typeof params._meta === 'object' ? params._meta[CAPS] : null;
  if (caps && typeof caps === 'object' && 'elicitation' in caps) {
    delete caps.elicitation;
    changed = true;
  }
  return changed;
}

/** One client line, as it goes to the server. */
function rewrite(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return line; }
  let changed = false;
  if (Array.isArray(parsed)) { for (const m of parsed) changed = strip(m) || changed; } else changed = strip(parsed);
  return changed ? JSON.stringify(parsed) : line;
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command) { process.stderr.write('usage: no-box-proxy.cjs <server command> [args...]\n'); process.exit(2); }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('error', (e) => { process.stderr.write(`no-box-proxy: could not start the server: ${e.message}\n`); process.exit(127); });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      // Keep a trailing \r (CRLF framing) where it was.
      const cr = line.endsWith('\r');
      const body = cr ? line.slice(0, -1) : line;
      child.stdin.write((body.trim() ? rewrite(body) : body) + (cr ? '\r' : '') + '\n');
    }
  });
  process.stdin.on('end', () => {
    if (buf) { child.stdin.write(buf.trim() ? rewrite(buf) : buf); buf = ''; }
    child.stdin.end();
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
  child.on('exit', (code, signal) => {
    // Let the last of the server's output drain before leaving.
    const done = () => process.exit(code !== null ? code : (signal ? 1 : 0));
    if (child.stdout.readableEnded) done(); else { child.stdout.once('end', done); setTimeout(done, 2000).unref(); }
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { strip, rewrite };
