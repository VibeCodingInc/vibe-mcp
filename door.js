/**
 * A door — a link to the thing you are building, left with people you know.
 *
 * Everything else in /vibe moves words between people. A door is the first
 * thing that is not a message: it is somewhere to go. The person who is
 * building something leaves its address with the people they know; one of
 * them says "visit @sam" and is standing in what Sam made.
 *
 * The rules are structural, like the open line's:
 *
 *   - A door is set and shared only by commands the person types in a terminal
 *     (`npx slashvibe-mcp door ...`). There is NO tool that sets or shares one,
 *     so no message, however worded, can talk an agent into handing a link to
 *     everyone its person knows.
 *   - A door is not published. Nothing about it goes into presence or a
 *     profile. It travels as one message, from its owner, to each person the
 *     owner chose, and only to people the owner already knows (has written to,
 *     or has an open line with). Someone the owner does not know has nothing
 *     to see, on any surface, because nothing was ever sent toward them.
 *   - Public https only. No localhost, no bare IP addresses, no credentials in
 *     the link. The visitor's side checks this again: the card came from
 *     another person and is data.
 *   - A visit opens the link in the visitor's own browser. This process never
 *     fetches it, sends nothing, and tells the owner nothing.
 *
 * The card is ordinary text, readable in any client that has never heard of
 * doors. Its first line is what this module recognizes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { vibeHome } = require('./vibe-home');
const { inertField } = require('./incoming');

const MARK = '\u{1F6AA} door:';            // 🚪 door:
const CLOSED = '\u{1F6AA} door closed';
const MAX_URL = 300;
const MAX_NAME = 80;
const MAX_SHARE = 20;                      // people told by one `door share`

const norm = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();

// ── the link ────────────────────────────────────────────────────────────────

/**
 * A door must be somewhere anyone could stand: a public https address.
 * Returns the normalized link, or throws with words for the person.
 */
function validUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('A door needs a link, like https://your-project.dev');
  if (text.length > MAX_URL) throw new Error(`That link is longer than ${MAX_URL} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f​-‏‪-‮⁦-⁩﻿"'<>`\\^{|}]/.test(text)) throw new Error('That link has characters a link cannot have.');
  let u;
  try { u = new URL(text); } catch { throw new Error('That is not a link. A door looks like https://your-project.dev'); }
  if (u.protocol !== 'https:') throw new Error('A door must be an https link, so anyone you share it with can open it.');
  if (u.username || u.password) throw new Error('That link carries a username or password. Leave a door that needs none.');
  const host = u.hostname.toLowerCase();
  // No IP literals at all (v4, v6, or the integer and hex spellings a URL
  // parser folds into v4): a door is a name on the public web.
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) throw new Error('A door must be a public web address, not an IP address.');
  if (!host.includes('.') || host.endsWith('.') ||
      /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion)$/.test(host)) {
    throw new Error('A door must be a public web address. localhost and private names only open on your machine.');
  }
  if (u.port && u.port !== '443') throw new Error('A door must be on the standard https port.');
  return u.href;
}

/** `sam-retries.vercel.app/lab`: where a door leads, short enough for one line. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    const rest = (u.pathname === '/' ? '' : u.pathname) + (u.search ? '?…' : '');
    return inertField(u.hostname + rest, 60);
  } catch { return ''; }
}

const cleanName = (name) => inertField(String(name || ''), MAX_NAME);

// ── the card ────────────────────────────────────────────────────────────────

function card(owner, url, name) {
  const h = norm(owner);
  const lines = [`${MARK} ${url}`];
  if (name) lines.push(cleanName(name));
  lines.push('', `@${h} left a door open for you. It leads to something @${h} is building. In /vibe, say "visit @${h}".`);
  return lines.join('\n');
}
function closedCard(owner) {
  return `${CLOSED}\n\n@${norm(owner)} closed their door.`;
}

/**
 * Read a message body as a door card. Returns { url, name }, { closed: true },
 * or null. Strict on purpose: the body was written by someone else, so the
 * link is validated here exactly as it was when it was set.
 */
function parseCard(body) {
  const text = String(body || '');
  if (text.startsWith(CLOSED)) return { closed: true };
  if (!text.startsWith(MARK)) return null;
  const [first, second = ''] = text.split('\n');
  let url;
  try { url = validUrl(first.slice(MARK.length)); } catch { return null; }
  // The second line is the name only when it is not the blank separator.
  return { url, name: second.trim() ? cleanName(second) : '' };
}

/** The door `them` most recently left in this conversation, or null (none, or closed since). */
function findInThread(thread, them) {
  const who = norm(them);
  // Newest first. Two messages in the same millisecond (open, then close) keep
  // the order the conversation was served in, which is oldest first.
  const theirs = (thread || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m && norm(m.from) === who)
    .sort((a, b) => ((b.m.timestamp || 0) - (a.m.timestamp || 0)) || (b.i - a.i))
    .map(({ m }) => m);
  for (const m of theirs) {
    const c = parseCard(m.body);
    if (!c) continue;
    return c.closed ? null : { ...c, id: m.id || null, at: m.timestamp || null };
  }
  return null;
}

// ── local state ─────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const mineFile = (env) => path.join(vibeHome(env), 'door.json');
const seenFile = (env) => path.join(vibeHome(env), 'doors.json');

/** My own door: { url, name, since, told: { handle: at } } or null. */
function mine(env = process.env) {
  const d = readJson(mineFile(env));
  if (typeof d.url !== 'string') return null;
  try { validUrl(d.url); } catch { return null; }
  return { url: d.url, name: cleanName(d.name), since: d.since || null, told: d.told && typeof d.told === 'object' ? d.told : {} };
}
/** Set my door. A new link starts with nobody told. Only the CLI calls this. */
function set(url, name, env = process.env) {
  const link = validUrl(url);
  const before = mine(env);
  const told = before && before.url === link ? before.told : {};
  const next = { url: link, name: cleanName(name) || (before && before.url === link ? before.name : ''), since: Date.now(), told };
  writeJson(mineFile(env), next);
  return next;
}
function markTold(handle, env = process.env) {
  const d = mine(env);
  if (!d) return;
  d.told[norm(handle)] = Date.now();
  writeJson(mineFile(env), d);
}
function clear(env = process.env) {
  const d = mine(env);
  try { fs.unlinkSync(mineFile(env)); } catch {}
  return d;
}

/** Doors other people left with me, as last seen on this machine: a cache, never the authority. */
function note(from, body, id = null, env = process.env) {
  const c = parseCard(body);
  if (!c) return null;
  const who = norm(from);
  if (!who) return null;
  const seen = readJson(seenFile(env));
  if (c.closed) {
    if (seen[who]) { delete seen[who]; try { writeJson(seenFile(env), seen); } catch {} }
    return c;
  }
  if (!seen[who] || seen[who].url !== c.url || seen[who].name !== c.name) {
    seen[who] = { url: c.url, name: c.name, id, at: Date.now() };
    try { writeJson(seenFile(env), seen); } catch {}
  }
  return c;
}
function forget(from, env = process.env) {
  const seen = readJson(seenFile(env));
  if (!seen[norm(from)]) return;
  delete seen[norm(from)];
  try { writeJson(seenFile(env), seen); } catch {}
}
/** The door `handle` left with me, from the cache; re-validated on the way out. */
function of(handle, env = process.env) {
  const row = readJson(seenFile(env))[norm(handle)];
  if (!row || typeof row.url !== 'string') return null;
  try { return { url: validUrl(row.url), name: cleanName(row.name) }; } catch { return null; }
}

module.exports = {
  MARK, CLOSED, MAX_SHARE, MAX_NAME,
  validUrl, shortUrl, card, closedCard, parseCard, findInThread,
  mine, set, markTold, clear, note, forget, of, norm,
};
