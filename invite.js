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

const reach = require('./reach');

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

module.exports = { fromArg, accept, line, lookup, resolveRecipient };
