/**
 * Unsent replies — a reply the person had drafted and never chose about.
 *
 * Lab 2026-11-21: someone's message arrives, the agent prepares a reply
 * (vibe_prepare: a preview, nothing sent), the person is pulled away and never
 * chooses Send or Cancel. Nothing ever brought it back, and the other person
 * waited for good. This says so, once, at the next natural moment, and offers
 * to show it again. It never invites a blind send: the line asks whether they
 * want to SEE it, and a draft shown again can only be sent after the person's
 * next prompt (tools/drafts.js stampRev, turns.js).
 *
 * An open reply is a draft that is
 *   - still a preview (status 'previewed'; not held, not sending, not one whose
 *     Send did not confirm, not sent or cancelled),
 *   - prepared by the account signed in now,
 *   - addressed to someone who wrote last in their conversation with the person
 *     (read or unread), so the exchange is waiting on the person,
 *   - not overtaken by a later sent draft to the same person,
 *   - last shown at least MIN_AGE_MS ago (so a preview someone is looking at in
 *     another open session is not announced, and its id not handed elsewhere),
 *   - and younger than a draft lives (DRAFT_TTL_MS in tools/drafts.js, 24h):
 *     an older draft no longer exists and could not be sent anyway.
 * At most one per person: the newest.
 *
 * Where it is said:
 *   - at session start, once per session per draft, and at most
 *     MAX_STARTS session starts per draft on this machine
 *     (session-start-hook.cjs);
 *   - mid-session, once per draft on this machine, by the arrival hook (the
 *     server spools it from the inbox rows its poll already read: no extra
 *     request; every poll also removes a spooled row whose draft no longer
 *     qualifies, and the hook re-checks the draft before it says anything);
 *   - in vibe_people, beside that conversation, whenever it is asked.
 * A session-start mention also takes the mid-session claim, so one session is
 * never told twice.
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
const MIN_AGE_MS = 30 * 60 * 1000;                 // left unchosen this long before any reminder
const MID_SESSION_AFTER_MS = MIN_AGE_MS;
const MAX_STARTS = 2;                               // session starts that may mention one draft, per machine
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

/** When the draft's current text was last shown (drafts.js stampRev), else when it was opened. */
function preparedAt(d) {
  return Number.isFinite(d.revAt) ? d.revAt : (Number.isFinite(d.createdAt) ? d.createdAt : null);
}

/** Draft ids become file names: the same set drafts.js mints (w + hex). */
const safeDraftId = (id) => (typeof id === 'string' && /^w[0-9a-f]{4,32}$/.test(id) ? id : null);

/**
 * Pure. Open replies, newest first, one per person, at most MAX.
 * @param drafts   drafts.json rows
 * @param threads  store.getInbox() rows: { handle, lastFrom, muted }
 * @param me       the signed-in handle
 */
function openReplies(drafts, threads, me, { now = Date.now(), minAgeMs = MIN_AGE_MS, isMuted = () => false } = {}) {
  const mine = lower(me);
  if (!mine) return [];
  const waitingOn = new Set((threads || [])
    .filter((t) => t && t.handle && !t.muted && lower(t.lastFrom) === lower(t.handle) && lower(t.handle) !== mine)
    .map((t) => lower(t.handle)));
  // A later draft to the same person that went out overtakes this one.
  const lastSent = new Map();
  for (const d of drafts || []) {
    if (!d || d.status !== 'sent' || !Number.isFinite(d.sentAt) || lower(d.from) !== mine) continue;
    const to = lower(d.to);
    if (!lastSent.has(to) || lastSent.get(to) < d.sentAt) lastSent.set(to, d.sentAt);
  }
  const out = [];
  for (const d of drafts || []) {
    if (!d || d.status !== 'previewed' || d.held || !safeDraftId(d.id)) continue;
    if (lower(d.from) !== mine) continue;
    const to = lower(d.to);
    if (!to || !waitingOn.has(to) || isMuted(to)) continue;
    if (lastSent.has(to) && lastSent.get(to) > (d.createdAt || 0)) continue;
    const at = preparedAt(d);
    if (at === null || now - (d.createdAt || at) >= DRAFT_TTL_MS) continue;
    out.push({ id: d.id, to, at });
  }
  // The newest open draft per person FIRST, then the age floor on that one
  // only: an older draft is never announced while a newer one to the same
  // person was shown a moment ago.
  out.sort((a, b) => b.at - a.at);
  const seen = new Set();
  return out.filter((r) => (seen.has(r.to) ? false : (seen.add(r.to), true)))
    .filter((r) => now - r.at >= minAgeMs)
    .slice(0, MAX);
}

function ago(at, now = Date.now()) {
  // Display only: a lab run may make its days real (labclock.js, loopback only).
  const labclock = require('./labclock');
  const mins = Math.max(1, Math.floor((labclock.now(now) - labclock.at(at)) / 60000));
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/**
 * What the person sees (one line) and what the model is told. Pure.
 * withAge: false for a row spooled now and shown later (the age would be frozen).
 */
function render(item, now = Date.now(), { withAge = true } = {}) {
  const to = inertField(item.to, 40);
  const id = safeDraftId(item.id);
  const when = withAge && Number.isFinite(item.at) ? ` (last shown ${ago(item.at, now)})` : '';
  return {
    line: `/vibe · your reply to @${to} is drafted but not sent${when} · want to see it again?`,
    context: [
      `/vibe: the person has a reply to @${to} drafted but not sent (draft ${id}${when ? `, ${when.slice(2, -1)}` : ''}), and @${to} wrote last in that conversation, so @${to} may still be waiting.`,
      'The person has been shown this one line, not the draft.',
      `If they want to see it, show it with vibe_prepare {id: "${id}"} and ask in words: Send, Edit or Cancel. A draft shown again can be sent only after their next typed message; a pick in a question menu does not count. If they want to drop it, call vibe_discard {id: "${id}"}.`,
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
/** The n-th session start that mentioned this draft on this machine (1..MAX_STARTS). */
const startMark = (draftId, n) => `unsent-${draftId}-start${n}`;

function spoolDir(env) { return path.join(vibeHome(env), 'arrivals'); }
const exists = (dir, name) => fs.existsSync(path.join(dir, `${name}.shown`));

/** May a session start mention this draft? Not if this session was told, nor past MAX_STARTS starts. */
function mayMentionAtStart(draftId, session, env = process.env) {
  if (!safeDraftId(draftId)) return false;
  const dir = spoolDir(env);
  if (safeSession(session) && exists(dir, sessionMark(draftId, session))) return false;
  for (let n = 1; n <= MAX_STARTS; n++) if (!exists(dir, startMark(draftId, n))) return true;
  return false;
}

/** Back-compat for callers and tests: was this session told? */
function told(draftId, session, env = process.env) {
  const s = safeSession(session);
  if (!s || !safeDraftId(draftId)) return false;
  return exists(spoolDir(env), sessionMark(draftId, s));
}

/** A session start said it: mark the session, take one start slot, and the mid-session claim. */
function markTold(draftId, session, env = process.env) {
  if (!safeDraftId(draftId)) return;
  const dir = spoolDir(env);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const claim = (n) => { try { fs.closeSync(fs.openSync(path.join(dir, `${n}.shown`), 'wx', 0o600)); return true; } catch { return false; } };
  claim(rowId(draftId));
  if (safeSession(session)) claim(sessionMark(draftId, session));
  for (let n = 1; n <= MAX_STARTS; n++) if (claim(startMark(draftId, n))) break;
}

/**
 * The server's poll. First removes spooled reminder rows whose draft no
 * longer qualifies (sent, dropped, answered another way, overtaken, expired),
 * then spools the mid-session reminder for a reply left unchosen for
 * MID_SESSION_AFTER_MS, once per draft on this machine. `threads` are the
 * inbox rows the poll already read. Never pushed through a channel: it is not
 * an arrival. Returns the rows written.
 */
function spool(threads, me, { env = process.env, now = Date.now(), isMuted = () => false } = {}) {
  const drafts = readDrafts(env, now);
  const dir = spoolDir(env);
  // rowId -> when that draft was last shown; a queued row for a draft no
  // longer open, or shown again since it was queued, is removed.
  const stillOpen = new Map(openReplies(drafts, threads, me, { now, minAgeMs: 0, isMuted }).map((r) => [rowId(r.id), r.at]));
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = /^(unsent-w[0-9a-f]{4,32})\.json$/.exec(name);
      if (!m) continue;
      let shownAt = null;
      try { shownAt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).shownAt; } catch {}
      if (!stillOpen.has(m[1]) || stillOpen.get(m[1]) !== shownAt) { try { fs.unlinkSync(path.join(dir, name)); } catch {} }
    }
  } catch {}
  const items = openReplies(drafts, threads, me, { now, minAgeMs: MID_SESSION_AFTER_MS, isMuted });
  const out = [];
  for (const item of items) {
    const id = rowId(item.id);
    if (fs.existsSync(path.join(dir, `${id}.shown`)) || fs.existsSync(path.join(dir, `${id}.json`))) continue;
    const r = render(item, now, { withAge: false });
    const row = { id, kind: 'unsent', draft: item.id, shownAt: item.at, to: lower(me), from: lower(me), at: now, context: r.context, line: r.line };
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
  DRAFT_TTL_MS, MIN_AGE_MS, MID_SESSION_AFTER_MS, MAX_STARTS,
  readDrafts, openReplies, render, ago, spool, told, markTold, mayMentionAtStart,
  rowId, sessionMark, startMark, safeSession, safeDraftId,
};
