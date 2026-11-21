/**
 * Unsent replies — a reply the person had drafted and never chose about.
 *
 * Lab 2026-11-21: someone's message arrives, the agent prepares a reply
 * (vibe_prepare: a preview, nothing sent), the person is pulled away and never
 * chooses Send or Cancel. Nothing ever brought it back, and the other person
 * waited for good. This says so, once, at the next natural moment, so the
 * agent can ask: send it, change it, or drop it?
 *
 * An open reply is a draft that is
 *   - still a preview (status 'previewed'; not held, not sending, not one whose
 *     Send did not confirm, not sent or cancelled),
 *   - prepared by the account signed in now,
 *   - addressed to someone who wrote last in their conversation with the person
 *     (read or unread), so the exchange is waiting on the person,
 *   - and younger than a draft lives (DRAFT_TTL_MS in tools/drafts.js, 24h):
 *     an older draft no longer exists and could not be sent anyway.
 *
 * Where it is said (each once):
 *   - at session start, once per session per draft (session-start-hook.cjs);
 *   - mid-session, once per draft on this machine, by the arrival hook, when the
 *     draft has sat unchosen for MID_SESSION_AFTER_MS (the server spools it from
 *     the inbox rows its poll already read: no extra request);
 *   - in vibe_people, beside that conversation, whenever it is asked.
 * A session-start mention also takes the mid-session claim, so one session is
 * never told twice. The arrival hook checks the draft is still open before it
 * shows anything, and records the session it showed it in.
 *
 * Nothing here sends, edits or cancels a draft. The only send is still
 * vibe_send with id + rev after the person's choice (tools/drafts.js). The
 * other person's words are never part of what is said here; the handle is
 * made inert.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { vibeHome } = require('./vibe-home');
const { inertField } = require('./incoming');

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;          // = tools/drafts.js
const MID_SESSION_AFTER_MS = 30 * 60 * 1000;       // left unchosen this long before the mid-session reminder
const MAX = 3;

const lower = (h) => String(h || '').replace(/^@/, '').toLowerCase();

function draftsFile(env = process.env) { return path.join(vibeHome(env), 'drafts.json'); }

/** Read-only: no lock, no write. A draft file that cannot be read is no drafts. */
function readDrafts(env = process.env, now = Date.now()) {
  try {
    const all = JSON.parse(fs.readFileSync(draftsFile(env), 'utf8'));
    return Array.isArray(all) ? all.filter((d) => d && typeof d === 'object' && now - (d.createdAt || 0) < DRAFT_TTL_MS) : [];
  } catch { return []; }
}

/** When the draft's current text was prepared (drafts.js stampRev), else when it was opened. */
function preparedAt(d) {
  return Number.isFinite(d.revAt) ? d.revAt : (Number.isFinite(d.createdAt) ? d.createdAt : null);
}

/** Draft ids become file names: the same set drafts.js mints (w + hex). */
const safeDraftId = (id) => (typeof id === 'string' && /^w[0-9a-f]{4,32}$/.test(id) ? id : null);

/**
 * Pure. Open replies, newest first, at most MAX.
 * @param drafts   drafts.json rows
 * @param threads  store.getInbox() rows: { handle, lastFrom, muted }
 * @param me       the signed-in handle
 */
function openReplies(drafts, threads, me, { now = Date.now(), minAgeMs = 0, isMuted = () => false } = {}) {
  const mine = lower(me);
  if (!mine) return [];
  const waitingOn = new Set((threads || [])
    .filter((t) => t && t.handle && !t.muted && lower(t.lastFrom) === lower(t.handle) && lower(t.handle) !== mine)
    .map((t) => lower(t.handle)));
  const out = [];
  const seen = new Set();
  for (const d of drafts || []) {
    if (!d || d.status !== 'previewed' || d.held || !safeDraftId(d.id)) continue;
    if (lower(d.from) !== mine) continue;
    const to = lower(d.to);
    if (!to || !waitingOn.has(to) || isMuted(to)) continue;
    const at = preparedAt(d);
    if (at === null || now - (d.createdAt || at) >= DRAFT_TTL_MS || now - at < minAgeMs) continue;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ id: d.id, to, at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX);
}

function ago(at, now = Date.now()) {
  const mins = Math.max(1, Math.floor((now - at) / 60000));
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/** What the person sees (one line) and what the model is told. Pure. */
function render(item, now = Date.now()) {
  const to = inertField(item.to, 40);
  const id = safeDraftId(item.id);
  const when = ago(item.at, now);
  return {
    line: `/vibe · your reply to @${to} is drafted but not sent (prepared ${when}) · send it, change it, or drop it?`,
    context: [
      `/vibe: the person has a reply to @${to} drafted but not sent (draft ${id}, prepared ${when}), and @${to} wrote last in that conversation, so @${to} may still be waiting.`,
      'The person has been shown this one line.',
      `If they want to send or change it, open it with vibe_prepare {id: "${id}"} so they see the exact text again, and call vibe_send only after they choose Send. If they want to drop it, call vibe_discard {id: "${id}"}.`,
      'Do not send, change or drop it on your own, and do not bring it up again.',
    ].join('\n'),
  };
}

// ── once ────────────────────────────────────────────────────────────────────
// Markers live in the arrival spool directory beside the `.shown` claims, and
// are pruned with them (arrival.prune). The arrival hook keeps its own copy of
// these names (it loads nothing); a test pins that they agree.

/** Session ids are hook input: only a safe, bounded part names a file. */
const safeSession = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
/** Once per machine for the mid-session reminder; also the spool row's id. */
const rowId = (draftId) => `unsent-${draftId}`;
/** Once per session per draft. */
const sessionMark = (draftId, session) => `unsent-${draftId}-${safeSession(session)}`;

function spoolDir(env) { return path.join(vibeHome(env), 'arrivals'); }

function told(draftId, session, env = process.env) {
  const s = safeSession(session);
  if (!s || !safeDraftId(draftId)) return false;
  return fs.existsSync(path.join(spoolDir(env), `${sessionMark(draftId, s)}.shown`));
}

/** Record that this session was told about this draft, and that no mid-session reminder is needed. */
function markTold(draftId, session, env = process.env) {
  if (!safeDraftId(draftId)) return;
  const dir = spoolDir(env);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const names = [rowId(draftId)];
  if (safeSession(session)) names.push(sessionMark(draftId, session));
  for (const n of names) { try { fs.closeSync(fs.openSync(path.join(dir, `${n}.shown`), 'wx', 0o600)); } catch {} }
}

/**
 * The server's poll: spool the mid-session reminder for a reply left unchosen
 * for MID_SESSION_AFTER_MS, once per draft on this machine. `threads` are the
 * inbox rows the poll already read. Never pushed through a channel: it is not
 * an arrival. Returns the rows written.
 */
function spool(threads, me, { env = process.env, now = Date.now(), isMuted = () => false } = {}) {
  const items = openReplies(readDrafts(env, now), threads, me, { now, minAgeMs: MID_SESSION_AFTER_MS, isMuted });
  if (items.length === 0) return [];
  const dir = spoolDir(env);
  const out = [];
  for (const item of items) {
    const id = rowId(item.id);
    if (fs.existsSync(path.join(dir, `${id}.shown`)) || fs.existsSync(path.join(dir, `${id}.json`))) continue;
    const r = render(item, now);
    const row = { id, kind: 'unsent', draft: item.id, to: lower(me), from: lower(me), at: now, context: r.context, line: r.line };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${id}.json`);
      const tmp = `${file}.${process.pid}.${now}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(row), { mode: 0o600 });
      fs.renameSync(tmp, file);
      out.push(row);
    } catch {}
  }
  return out;
}

module.exports = {
  DRAFT_TTL_MS, MID_SESSION_AFTER_MS,
  readDrafts, openReplies, render, ago, spool, told, markTold, rowId, sessionMark, safeSession, safeDraftId,
};
