'use strict';
// Preload for `npm test` (review SF-4): the suite talks only to loopback.
// Any attempt to open a connection to another host is refused, and the
// process that tried exits non-zero at the end, naming each attempt, so the
// test file fails even when the code under test swallowed the refusal (a
// bounded read returns "nothing" on any error). Loaded into every test
// process and every child it spawns with NODE_OPTIONS.
const net = require('net');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '']);
const isLoopback = (h) => LOOPBACK.has(String(h == null ? '' : h).replace(/^\[|\]$/g, '').toLowerCase());
const attempts = [];

function refuse(host) {
  attempts.push(String(host));
  process.exitCode = 1;
  throw new Error(`loopback-only: refused a connection to ${host} in a test`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === 'object') {
    if (!o.path && !isLoopback(o.host)) refuse(o.host);
  } else if (typeof o === 'number' || /^\d+$/.test(String(o))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!isLoopback(host)) refuse(host);
  }
  return connect.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (u, ...rest) => {
    let host = '';
    try { host = new URL(String((u && u.url) || u)).hostname; } catch {}
    if (!isLoopback(host)) refuse(host);
    return fetch(u, ...rest);
  };
}

process.on('exit', () => {
  if (attempts.length === 0) return;
  process.exitCode = 1;
  try { process.stderr.write(`\nloopback-only: ${attempts.length} connection attempt(s) to a non-loopback host from ${process.argv.slice(1).join(' ')}: ${[...new Set(attempts)].join(', ')}\n`); } catch {}
});

module.exports = { attempts, isLoopback };
