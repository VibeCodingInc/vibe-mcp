/**
 * Rapport: trust, noticed once, turned into an offer of speed.
 *
 * When a person has sent one teammate several drafts without changing a word,
 * and that teammate has answered, their agent already speaks for them there.
 * The product says so ONCE and points at the command that opens a line
 * (`npx slashvibe-mcp trust @handle`). It never opens one: a line opens only
 * when both people type that command in their own terminals (line.js).
 *
 * What is remembered, in ~/.vibe/rapport.json, per teammate: COUNTS AND DATES
 * ONLY. Drafts sent unchanged, drafts sent after an edit, replies received,
 * when the last exchange happened, and whether the offer was shown or
 * declined. No message text, no subjects, no thread or message ids, no paths.
 * This module makes no network call and nothing in the file leaves the
 * machine. `npx slashvibe-mcp rapport` shows it; `rapport forget` erases it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { vibeHome } = require('./vibe-home');
const { inertField } = require('./incoming');

/** The one place the offer's thresholds live. A guess; tune it against real pairs. */
const OFFER_THRESHOLDS = Object.freeze({
  unchangedSends: 5,     // drafts sent exactly as first previewed
  replies: 3,            // messages from them after I first wrote
  withinDays: 14,        // the last exchange must be this recent
});
const DAY = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5000;

const file = (env) => path.join(vibeHome(env), 'rapport.json');
const norm = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();
const validHandle = (h) => /^[a-z0-9][a-z0-9_-]{1,38}$/.test(h);
const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
const time = (t) => (Number.isFinite(t) && t > 0 ? t : null);

/** One teammate's entry, keeping only the fields this file is allowed to hold. */
function clean(e) {
  const o = e && typeof e === 'object' ? e : {};
  const offer = o.offer && typeof o.offer === 'object' && ['offered', 'declined'].includes(o.offer.state) && time(o.offer.at)
    ? { state: o.offer.state, at: o.offer.at } : null;
  return { unchanged: count(o.unchanged), edited: count(o.edited), replies: count(o.replies), lastAt: time(o.lastAt), offer };
}

/** Everything remembered. A missing or corrupt file is an empty memory, never an error. */
function read(env = process.env) {
  let v = null;
  try { v = JSON.parse(fs.readFileSync(file(env), 'utf8')); } catch {}
  const people = v && typeof v === 'object' && v.people && typeof v.people === 'object' ? v.people : {};
  const out = {};
  for (const [h, e] of Object.entries(people)) if (validHandle(h)) out[h] = clean(e);
  return out;
}

/**
 * Read-modify-write under a small lock, atomic replace, mode 0600. Two
 * sessions finishing sends at once keep both counts. If the lock cannot be
 * had, nothing is written and fn is not run: a missed count costs nothing, a
 * doubled offer would.
 */
function update(fn, env = process.env) {
  const target = file(env);
  const lockDir = `${target}.lock`;
  try { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); } catch { return undefined; }
  const deadline = Date.now() + 1000;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (e) {
      if (!e || e.code !== 'EEXIST') return undefined;
      try { if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) return undefined;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch {}
    }
  }
  try {
    const people = read(env);
    const out = fn(people);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ people }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return out;
  } catch { return undefined; } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  }
}

/** A send the platform confirmed stored. `unchanged`: the rev sent was the rev first previewed. */
function noteSent(handle, { unchanged }, { env = process.env, now = Date.now() } = {}) {
  const h = norm(handle);
  if (!validHandle(h)) return;
  update((p) => {
    const e = p[h] || clean(null);
    if (unchanged) e.unchanged += 1; else e.edited += 1;
    e.lastAt = now;
    p[h] = e;
  }, env);
}

/**
 * A message from them arrived. Counted only after I have written to them at
 * least once; the caller guarantees once per message id.
 */
function noteReply(handle, { env = process.env, now = Date.now() } = {}) {
  const h = norm(handle);
  if (!validHandle(h)) return false;
  return Boolean(update((p) => {
    const e = p[h];
    if (!e || e.unchanged + e.edited === 0) return false;
    e.replies += 1;
    e.lastAt = now;
    return true;
  }, env));
}

/** Does this entry meet the thresholds, as of now? (The line and the offer state are checked by takeOffer.) */
function earned(e, now = Date.now()) {
  return Boolean(e) && e.unchanged >= OFFER_THRESHOLDS.unchangedSends && e.replies >= OFFER_THRESHOLDS.replies
    && e.lastAt !== null && now - e.lastAt <= OFFER_THRESHOLDS.withinDays * DAY;
}

/**
 * The offer for this teammate, if it is due: thresholds met, no line open,
 * never shown or declined. It is marked shown in the same locked write that
 * decides it, before anything is displayed, so it can never appear twice,
 * even if the session dies right after.
 */
function takeOffer(handle, { lineOpen = false, env = process.env, now = Date.now() } = {}) {
  const h = norm(handle);
  if (!validHandle(h) || lineOpen) return null;
  const due = update((p) => {
    const e = p[h];
    if (!e || e.offer || !earned(e, now)) return null;
    e.offer = { state: 'offered', at: now };
    return { handle: h, unchanged: e.unchanged };
  }, env);
  return due || null;
}

const command = (h) => `npx slashvibe-mcp trust @${h}`;

/** The words of the offer. The handle is the only peer-supplied string, and it goes through inertField. */
function offerText({ handle, unchanged }) {
  const h = inertField(norm(handle), 40);
  return [
    `You've sent @${h} ${unchanged} messages without changing a word, and they answered. Want your agents to handle questions like these directly? In your own terminal:`,
    `  ${command(h)}`,
    'It opens only when you both run it. I won\'t suggest this again.',
  ].join('\n');
}

/** Never offer for this person. */
function decline(handle, { env = process.env, now = Date.now() } = {}) {
  const h = norm(handle);
  if (!validHandle(h)) throw new Error(`"${handle}" is not a handle`);
  update((p) => { const e = p[h] || clean(null); e.offer = { state: 'declined', at: now }; p[h] = e; }, env);
  return h;
}

/** Forget one teammate, or everyone. Returns what was forgotten. */
function forget(handle, { env = process.env } = {}) {
  if (handle === undefined || handle === null || handle === '') {
    return update((p) => { const all = Object.keys(p); for (const k of all) delete p[k]; return all; }, env) || [];
  }
  const h = norm(handle);
  return update((p) => { const had = Boolean(p[h]); delete p[h]; return had ? [h] : []; }, env) || [];
}

module.exports = { OFFER_THRESHOLDS, read, noteSent, noteReply, earned, takeOffer, offerText, decline, forget, command, norm, validHandle };
