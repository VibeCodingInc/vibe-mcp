'use strict';

/**
 * Turns — has the person had a turn since this exact text was prepared?
 *
 * The promise: nothing is sent unless the person saw the exact text and chose
 * Send. The rev binds Send to bytes, but on its own it cannot tell whether the
 * person ever SAW those bytes: an agent could prepare a new rev and send it in
 * the same model turn ("send it, and add one line…" went out with a line the
 * person never read). The one thing an agent cannot do from inside its turn is
 * end that turn and have the person type. So:
 *
 *   the arrival hook (hooks/arrival-hook.cjs) runs on every UserPromptSubmit
 *   and records "a person prompted at T" for the project, here, under
 *   <VIBE_HOME>/turns/<hash of the project directory>.json = {"at": T};
 *
 *   vibe_send sends a rev only if a turn was recorded for this project
 *   strictly AFTER that rev was prepared.
 *
 * What is stored: a timestamp, in a file named by a hash of the directory.
 * No prompt text, no path in clear, no session id. Mode 0600.
 *
 * The project is Claude Code's CLAUDE_PROJECT_DIR, which both the hook and the
 * MCP server receive (checked in a live session: it stays the project root
 * after the agent cd's into a subdirectory, while the hook's input `cwd`
 * follows the cd). Without it, the hook falls back to its input cwd and the
 * server to its own working directory, which Claude Code sets to the project
 * root (also when the server is launched through npx). Both sides realpath the
 * directory before hashing, so /tmp and /private/tmp are one project.
 *
 * The hook keeps its own copy of key() (it must load nothing); a test pins
 * that the two agree.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { vibeHome } = require('./vibe-home');

function turnsDir(env = process.env) {
  return env.VIBE_TURNS_DIR || path.join(vibeHome(env), 'turns');
}

/** The file name for a project directory: sha256 of its realpath, 32 hex chars. */
function key(dir) {
  let real = String(dir || '');
  if (!real) return null;
  try { real = fs.realpathSync(real); } catch { real = path.resolve(real); }
  return crypto.createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 32);
}

/** This server's project: what Claude Code says it is, else where it was started. */
function projectDir(env = process.env, cwd = process.cwd) {
  const named = typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim();
  if (named) return named;
  try { return cwd(); } catch { return null; }
}

/** Has the hook ever recorded a turn under this VIBE_HOME? */
function anyRecorded(env = process.env) {
  try { return fs.readdirSync(turnsDir(env)).some((n) => /^[0-9a-f]{32}\.json$/.test(n)); } catch { return false; }
}

/** The last recorded person-turn for a project directory, or null. */
function lastTurn(dir, env = process.env) {
  const k = key(dir);
  if (!k) return null;
  try {
    const at = JSON.parse(fs.readFileSync(path.join(turnsDir(env), `${k}.json`), 'utf8')).at;
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

/** Record a person-turn (the hook's job; here for tests and the lab). */
function record(dir, at = Date.now(), env = process.env) {
  const k = key(dir);
  if (!k) return false;
  const d = turnsDir(env);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = path.join(d, `${k}.json`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

// ── a new session is a new screen ───────────────────────────────────────────
// A draft shown in an earlier session was not seen in this one: a reminder
// (unsent.js) can hand its id to a new agent, and that agent must not be able
// to send it without showing it here first. The session-start hook records
// when a session started for the project, under
// <turns dir>/<hash of the project directory>.start.json = {"at": T}, on the
// SessionStart sources startup, resume and clear; never on compact (after a
// compaction the person did see the text in this session).

function startFile(dir, env = process.env) {
  const k = key(dir);
  return k ? path.join(turnsDir(env), `${k}.start.json`) : null;
}

/** Record a session start for a project directory (the session-start hook's job). */
function recordSessionStart(dir, at = Date.now(), env = process.env) {
  const file = startFile(dir, env);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/**
 * The last session start recorded for a project:
 *   null                 none recorded (no session-start hook here yet)
 *   { at }               when
 *   { unreadable: true } a record exists and nothing can be read of it
 * A record whose contents cannot be parsed is dated by its file time.
 */
function lastSessionStart(dir, env = process.env) {
  const file = startFile(dir, env);
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch (e) { return e && e.code === 'ENOENT' ? null : { unreadable: true }; }
  try {
    const at = JSON.parse(fs.readFileSync(file, 'utf8')).at;
    if (Number.isFinite(at)) return { at };
  } catch {}
  return Number.isFinite(st.mtimeMs) ? { at: st.mtimeMs } : { unreadable: true };
}

// ── a Send chosen in the question menu (hooks/arrival-hook.cjs menuApproval) ─
// One draft, one rev: the hook writes <hash>.menu.json = {id, rev, at} only
// when the menu showed that draft's exact text and the person chose Send.

function lastMenuApproval(dir, env = process.env) {
  const k = key(dir);
  if (!k) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(turnsDir(env), `${k}.menu.json`), 'utf8'));
    return m && typeof m.id === 'string' && typeof m.rev === 'string' && Number.isFinite(m.at) ? m : null;
  } catch { return null; }
}

/** Did the person choose Send in a menu that showed THIS id at THIS rev, in this session? */
function menuApproved(id, rev, { env = process.env, cwd = process.cwd } = {}) {
  const dir = projectDir(env, cwd);
  const m = lastMenuApproval(dir, env);
  if (!m || m.id !== id || m.rev !== rev || m.at > Date.now() + 5000) return false;
  const floor = sessionFloor(dir, env);
  return floor !== null && m.at >= floor;
}

/**
 * The earliest a showing may be and still count in this session: the latest
 * recorded session start for the project. null = cannot be told (unreadable).
 */
function sessionFloor(dir, env = process.env) {
  const started = lastSessionStart(dir, env);
  if (started && started.unreadable) return null;
  return started ? started.at : 0;
}

/**
 * May a revision prepared at `revAt` be sent now?
 *   { check: 'passed' }       a turn for this project came strictly after it
 *   { check: 'needs_turn' }   no turn since (or none at all for this project)
 *   { check: 'unavailable' }  the hook has never recorded a turn here, or this
 *                             host is not Claude Code: today's behaviour
 * A turn in the same millisecond as the rev does not count as after it.
 */
function judge(revAt, { env = process.env, cwd = process.cwd, host } = {}) {
  const agent = host || (() => { try { return require('./host').getHost().agent; } catch { return null; } })();
  if (agent !== 'claude-code') return { check: 'unavailable', why: 'host_without_turn_hook' };
  if (!anyRecorded(env)) return { check: 'unavailable', why: 'no_turn_recorded' };
  const dir = projectDir(env, cwd);
  // Shown before this session started: it must be shown again here. Only
  // where the turn check itself applies (above), so a host without the hook
  // is never made unable to send.
  const started = lastSessionStart(dir, env);
  if (started && started.unreadable) return { check: 'needs_turn', why: 'session_start_unreadable' };
  if (started && !(Number.isFinite(revAt) && revAt >= started.at)) return { check: 'needs_turn', why: 'shown_in_earlier_session' };
  const at = lastTurn(dir, env);
  if (at !== null && Number.isFinite(revAt) && at > revAt) return { check: 'passed' };
  return { check: 'needs_turn', why: 'no_turn_since_shown' };
}

module.exports = { turnsDir, key, projectDir, anyRecorded, lastTurn, record, judge, recordSessionStart, lastSessionStart, lastMenuApproval, menuApproved, sessionFloor };
