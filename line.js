/**
 * An open line — standing consent between two people.
 *
 * Everything else in /vibe has a person approve each message. An open line is
 * the one exception, and it is the point of the product: with someone you
 * trust, your agent may ask their agent a question from your work, and may
 * answer theirs from yours, WITHOUT stopping either of you. You consult a
 * collaborator's working mind and they keep their focus; afterwards each of
 * you is told exactly what was said.
 *
 * That is a real grant, so the rules are structural, not instructions to a
 * model:
 *
 *   - A line is opened only by a command the person types in a terminal
 *     (`npx slashvibe-mcp trust @handle`). There is NO tool that opens one, so
 *     no message, however worded, can talk an agent into granting itself.
 *   - It is one-directional and local: it says what MY agent may do with THAT
 *     person. Both people must open one for an exchange to complete unattended.
 *   - The code, not the prompt, refuses an unattended send to anyone without a
 *     line; caps how many go out per hour; refuses text that looks like a
 *     credential; and marks every such message as written by the agent and not
 *     yet read by the person.
 *   - Every unattended message leaves a receipt on this machine, shown to the
 *     person the next time they look.
 *
 * Closing a line (`untrust`) takes effect on the next message.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { vibeHome } = require('./vibe-home');

const HOUR = 60 * 60 * 1000;
const MAX_PER_HOUR = 6;          // unattended messages to one person
const MAX_CHARS = 700;           // an answer, not a document
const ANSWER_WINDOW_MS = 30 * 60 * 1000; // an old question is the person's to answer

const file = (env) => path.join(vibeHome(env), 'lines.json');
const receiptsFile = (env) => path.join(vibeHome(env), 'line-receipts.jsonl');
const norm = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();
const validHandle = (h) => /^[a-z0-9][a-z0-9_-]{1,38}$/.test(h);

function read(env = process.env) {
  try {
    const v = JSON.parse(fs.readFileSync(file(env), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function write(lines, env = process.env) {
  const target = file(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lines, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Open a line. Only the CLI calls this. */
function open(handle, env = process.env) {
  const h = norm(handle);
  if (!validHandle(h)) throw new Error(`"${handle}" is not a handle`);
  const lines = read(env);
  if (!lines[h]) { lines[h] = { since: Date.now() }; write(lines, env); }
  return h;
}
function close(handle, env = process.env) {
  const h = norm(handle);
  const lines = read(env);
  const had = Boolean(lines[h]);
  if (had) { delete lines[h]; write(lines, env); }
  return had;
}
const list = (env = process.env) => Object.keys(read(env)).sort();
const isOpen = (handle, env = process.env) => Boolean(read(env)[norm(handle)]);

// ── receipts ────────────────────────────────────────────────────────────────

function record(receipt, env = process.env) {
  const target = receiptsFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, JSON.stringify({ at: Date.now(), ...receipt }) + '\n', { mode: 0o600 });
}
function receipts({ sinceMs = 24 * HOUR, env = process.env, now = Date.now() } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(receiptsFile(env), 'utf8'); } catch { return []; }
  return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && now - r.at <= sinceMs);
}
/** How many unattended messages went to this person in the last hour. */
function sentThisHour(handle, env = process.env) {
  const h = norm(handle);
  return receipts({ sinceMs: HOUR, env }).filter((r) => r.with === h).length;
}

// ── what may cross unattended ───────────────────────────────────────────────

// A person approving a message can see a key in it. Nobody is looking here, so
// anything shaped like a credential is refused outright rather than redacted:
// a redacted answer is a changed answer.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,          // a JWT
  /\b[a-fA-F0-9]{32,}\b/,                                    // long hex
  /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*\S{6,}/i,
];
function looksSecret(text) {
  return SECRET_SHAPES.some((re) => re.test(String(text || '')));
}

// The mark that makes authorship honest on the wire, and that stops two agents
// answering each other forever: an answer never gets an unattended answer.
const ASKED = (me) => `\n\n(asked by @${me}'s agent from their current work, over an open line. @${me} has not read this.)`;
const ANSWERED = (me) => `\n\n(answered by @${me}'s agent from their current work, over an open line. @${me} has not read this.)`;
const isAgentAnswer = (body) => /\(answered by @[a-z0-9_-]+'s agent from their current work, over an open line\./i.test(String(body || ''));
const isAgentAsk = (body) => /\(asked by @[a-z0-9_-]+'s agent from their current work, over an open line\./i.test(String(body || ''));
const stripMark = (body) => String(body || '').replace(/\n\n\((asked|answered) by @[a-z0-9_-]+'s agent from their current work, over an open line\.[^)]*\)\s*$/i, '');

module.exports = {
  open, close, list, isOpen, record, receipts, sentThisHour, looksSecret,
  ASKED, ANSWERED, isAgentAnswer, isAgentAsk, stripMark, norm, validHandle,
  MAX_PER_HOUR, MAX_CHARS, ANSWER_WINDOW_MS,
};
