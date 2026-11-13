/**
 * Who may reach you while you work.
 *
 * Arrival (arrival.js) puts a message in front of you mid-task, with your
 * agent offering to answer. That is a privilege, not a default: a stranger who
 * can interrupt a working session, and get an agent drafting replies to them,
 * has a spam channel and a place to try instructions. So:
 *
 *   - only someone you KNOW arrives while you work: a person you have written
 *     to, or one you opened a line with. Anyone else waits, unread, where
 *     vibe_start lists what is waiting;
 *   - `mute @handle` stops one person surfacing at all;
 *   - `quiet` stops everyone until `unquiet`.
 *
 * All of it is local to this machine and changed only by commands the person
 * types (cli.js) or by their own sends (deliver.js records who they wrote to).
 * Nothing here marks anything read: a held message is simply still waiting.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { vibeHome } = require('./vibe-home');

const file = (env) => path.join(vibeHome(env), 'reach.json');
const norm = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();
const validHandle = (h) => /^[a-z0-9][a-z0-9_-]{1,38}$/.test(h);

function read(env = process.env) {
  let v = null;
  try { v = JSON.parse(fs.readFileSync(file(env), 'utf8')); } catch {}
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    quiet: o.quiet === true,
    muted: o.muted && typeof o.muted === 'object' ? o.muted : {},
    known: o.known && typeof o.known === 'object' ? o.known : {},
  };
}
function update(fn, env = process.env) {
  const state = read(env);
  const out = fn(state);
  const target = file(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return out;
}
function handle(h) {
  const n = norm(h);
  if (!validHandle(n)) throw new Error(`"${h}" is not a handle`);
  return n;
}

const isQuiet = (env = process.env) => read(env).quiet;
const setQuiet = (on, env = process.env) => update((s) => { s.quiet = Boolean(on); }, env);

const isMuted = (h, env = process.env) => Boolean(read(env).muted[norm(h)]);
const mute = (h, env = process.env) => { const n = handle(h); update((s) => { s.muted[n] = Date.now(); }, env); return n; };
const unmute = (h, env = process.env) => update((s) => { const n = norm(h); const had = Boolean(s.muted[n]); delete s.muted[n]; return had; }, env);
const muted = (env = process.env) => Object.keys(read(env).muted).sort();

/** You have written to this person from this machine, or it was confirmed from the conversation. */
const isKnown = (h, env = process.env) => Boolean(read(env).known[norm(h)]);
function know(h, env = process.env) {
  const n = norm(h);
  if (!validHandle(n) || isKnown(n, env)) return;
  try { update((s) => { s.known[n] = Date.now(); }, env); } catch {}
}

/** Everyone you have written to from this machine. */
const known = (env = process.env) => Object.keys(read(env).known).filter(validHandle).sort();

module.exports = { isQuiet, setQuiet, isMuted, mute, unmute, muted, isKnown, know, known, norm };
