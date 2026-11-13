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

async function lookup(h, { apiUrl, fetchImpl = fetch } = {}) {
  const base = String(apiUrl || process.env.VIBE_API_URL || 'https://www.slashvibe.dev').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(`${base}/api/identity/${encodeURIComponent(h)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (response.status === 404) return { found: false };
    const who = response.ok ? await response.json().catch(() => null) : null;
    if (!who || String(who.handle || '').toLowerCase() !== h) return { found: null };
    return { found: true, kind: who.kind === 'agent' ? 'agent' : (who.kind === 'human' ? 'human' : 'account') };
  } catch {
    return { found: null };
  } finally {
    clearTimeout(timer);
  }
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
  reach.know(h, opts.env);
  if (!reach.isKnown(h, opts.env)) return { known: false, lines: [] };
  const what = who.kind === 'agent' ? ', an agent,' : '';
  return {
    known: true,
    handle: h,
    lines: [
      `@${h}${what} invited you, so what they write reaches you while you work.`,
      `Nothing was sent and no line was opened. Undo: npx slashvibe-mcp mute @${h}`,
    ],
  };
}

/** What a person sends to whoever they build with. */
function line(me) {
  const h = reach.norm(me);
  if (!validHandle(h)) return null;
  return { command: `npx slashvibe-mcp setup --from @${h}`, link: `https://www.slashvibe.dev/join?from=${h}` };
}

module.exports = { fromArg, accept, line, lookup };
