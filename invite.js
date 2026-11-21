/**
 * The inviter is known from the first minute.
 *
 * Since 0.9.1 only people you have written to reach you while you work, so a
 * newcomer's first line was "1 person you have not written to is waiting":
 * the person who invited them, behind a closed door. `setup --from @sam` fixes
 * that one case and no other: the newcomer types (or pastes) who invited them,
 * in their own terminal, and that one handle is marked as known on this
 * machine. It opens no line, sends nothing, tells nobody, and `mute` undoes it.
 *
 * Fails closed: a handle that cannot be confirmed to exist is not marked.
 * Words printed here are built from allow-listed fields, never server text.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const reach = require('./reach');
const { vibeHome } = require('./vibe-home');

const validHandle = (h) => /^[a-z0-9][a-z0-9_-]{1,38}$/.test(h);

/** `--from @sam` / `--from=sam` out of an argv. null when absent or malformed. */
function fromArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const v = a === '--from' ? argv[i + 1] : (a.startsWith('--from=') ? a.slice(7) : null);
    if (v == null) continue;
    return String(v);
  }
  return null;
}

/**
 * The platform folds '-' to '_' when it first gives a GitHub login a handle
 * (api/lib/handles.js), and its identity lookup answers with that spelling:
 * asking for "a-b" finds "a_b". Only that one difference is forgiven when
 * confirming the answer; any other mismatch is still "could not confirm".
 */
const sameAccount = (asked, answered) => asked.replace(/-/g, '_') === answered.replace(/-/g, '_');

/**
 * { found: true, kind, handle } where handle is the platform's own spelling;
 * { found: false } on a definite 404; { found: null } when it could not tell.
 */
async function lookup(h, { apiUrl, fetchImpl = fetch } = {}) {
  const base = String(apiUrl || process.env.VIBE_API_URL || 'https://www.slashvibe.dev').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(`${base}/api/identity/${encodeURIComponent(h)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (response.status === 404) return { found: false };
    const who = response.ok ? await response.json().catch(() => null) : null;
    const handle = who ? String(who.handle || '').toLowerCase() : '';
    if (!handle || !sameAccount(h, handle)) return { found: null };
    return { found: true, kind: who.kind === 'agent' ? 'agent' : (who.kind === 'human' ? 'human' : 'account'), handle };
  } catch {
    return { found: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The handle to address, for a recipient typed with a '-'.
 *
 * GitHub sign-in gives a login like "a-b" the handle "a_b" (the platform folds
 * '-' to '_'), and its inbox is read under that spelling. A message addressed
 * to "a-b" is accepted by the platform but stored under "a-b", where "a_b"
 * never sees it. So the platform's own answer decides: when the identity
 * lookup finds the account under a spelling that differs only by '-' for '_',
 * that spelling is used. Some older accounts really are stored with the dash;
 * then the lookup says so and the dash stays. Nothing is folded blindly.
 *
 * No '-', no request. Any answer other than a found account (absent, unclear,
 * offline, a throw) leaves the handle exactly as typed.
 *
 * @returns {Promise<{ handle: string, who: object|null }>} who is the lookup
 *   result when one was made (callers reuse it rather than asking twice).
 */
async function resolveRecipient(h, opts = {}) {
  const typed = String(h || '');
  if (!typed.includes('-')) return { handle: typed, who: null };
  let who;
  try { who = await lookup(typed, opts); } catch { who = { found: null }; }
  if (!who || typeof who !== 'object') who = { found: null };
  const theirs = who.found === true && typeof who.handle === 'string' ? who.handle : '';
  const handle = theirs && theirs !== typed && sameAccount(typed, theirs) && validHandle(theirs) ? theirs : typed;
  return { handle, who };
}

/**
 * Mark the inviter as known. Returns the lines to print; never throws, because
 * a setup that just succeeded must not end in an error over a courtesy.
 */
async function accept(typed, me, opts = {}) {
  const h = reach.norm(typed);
  if (!validHandle(h)) return { known: false, lines: [`"${String(typed).slice(0, 40)}" is not a handle, so nobody was marked as your inviter.`] };
  if (h === reach.norm(me)) return { known: false, lines: [] };
  const who = await lookup(h, opts);
  if (who.found === false) return { known: false, lines: [`There is no @${h} on /vibe, so nobody was marked as your inviter. Check the spelling with them.`] };
  if (who.found !== true) return { known: false, lines: [`Could not confirm @${h} just now, so they were not marked. Write to them once and they are known.`] };
  // Their messages arrive from the handle as the platform stores it, which
  // can differ from what was typed only by '-' for '_'. That is the one marked.
  const them = who.handle && validHandle(who.handle) ? who.handle : h;
  if (them === reach.norm(me)) return { known: false, lines: [] };
  reach.know(them, opts.env);
  if (!reach.isKnown(them, opts.env)) return { known: false, lines: [] };
  const what = who.kind === 'agent' ? ', an agent,' : '';
  return {
    known: true,
    handle: them,
    lines: [
      `@${them}${what} invited you, so what they write reaches you while you work.`,
      `Nothing was sent and no line was opened. Undo: npx slashvibe-mcp mute @${them}`,
    ],
  };
}

/** What a person sends to whoever they build with. */
function line(me) {
  const h = reach.norm(me);
  if (!validHandle(h)) return null;
  return { command: `npx slashvibe-mcp setup --from @${h}`, link: `https://www.slashvibe.dev/join?from=${h}` };
}

// ── the inviter's side ──────────────────────────────────────────────────────
// `setup --from @sam` marks Sam as known on the NEWCOMER's machine only. The
// platform is told nothing, so Sam's machine cannot know who accepted, and the
// newcomer's first message reaches Sam as one from "a person you have not
// written to" (lab 2026-11-20, p08 and p13). Until the platform can say who
// accepted an invite of yours, the one true thing this machine knows is WHEN
// it gave the person their invite line to pass on. The session-start line uses
// that, and only that: someone you have not written to who first wrote after
// that moment "may be someone you invited". It names nobody and quotes nothing.
const GIVEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const givenFile = (env) => path.join(vibeHome(env), 'invite-given.json');

/** When this machine last started showing the person their invite line, or null. */
function givenAt(env = process.env, now = Date.now()) {
  try {
    const at = Number(JSON.parse(fs.readFileSync(givenFile(env), 'utf8')).at);
    return Number.isFinite(at) && at > 0 && at <= now && now - at <= GIVEN_TTL_MS ? at : null;
  } catch { return null; }
}

/**
 * The person was shown their invite line. Keeps the EARLIEST moment that is
 * still recent, so a line shown again does not hide someone who already came.
 * Local, a timestamp only; never sent anywhere. Never throws.
 */
function noteGiven(env = process.env, now = Date.now()) {
  try {
    if (givenAt(env, now) !== null) return;
    const target = givenFile(env);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: now }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {}
}

module.exports = { fromArg, accept, line, lookup, resolveRecipient, noteGiven, givenAt, GIVEN_TTL_MS };
