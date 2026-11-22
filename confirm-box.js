'use strict';

/**
 * The Send box — the person confirms a send in a box /vibe opens.
 *
 * The promise: a message goes out in a person's name only after that person
 * saw the exact text and chose to send it. The turn check (turns.js) can only
 * tell that the person typed something after the draft was shown; any prompt
 * counts, even "no, don't send". Where the host can show a box itself (MCP
 * elicitation), vibe_send also asks the person directly, after the turn
 * check: a box with fixed wording naming the recipient and the length, then
 * the opening of the exact text, and Accept / Decline. Both are required. The
 * model never sees the box or the answer, only the tool result.
 *
 * Two ways a box is opened, by protocol era (index.js decides which applies):
 *   2025-06-18 / 2025-11-25   the server sends `elicitation/create` to the
 *                             client during the tool call (ask(), below);
 *   2026-07-28 (stateless)    the tool call returns `resultType:
 *                             "input_required"` with the same request in
 *                             `inputRequests`, and the client retries the call
 *                             with `inputResponses` and the echoed
 *                             `requestState` (multi round-trip requests).
 *
 * This file holds the box's wording and layout (constants, in one place), the
 * client capability record, the in-process one-box guard and timeout, and the
 * scan for hooks that could answer the box without the person. Read-only on
 * the person's settings: nothing here writes a file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── the box, in one place ───────────────────────────────────────────────────

/** Display width of a wrapped line of text in the box, in terminal columns. */
const WRAP_COLUMNS = 72;
/**
 * How many lines of a box message Claude Code shows before "… (+N more
 * lines)" (2.1.330, tested by hand). Line 1 is the fixed question; the text
 * gets the rest.
 */
const VISIBLE_LINES = 3;
/** A line break inside the text, as shown in the box: it does not use up a line. Display only. */
const NEWLINE_MARK = ' ↵ ';
/** The form asked for: no fields, so the box is Accept / Decline. */
const SCHEMA = Object.freeze({ type: 'object', properties: Object.freeze({}) });
/** How long a box may stay open before the send is given up. */
const TIMEOUT_MS = 5 * 60 * 1000;
/** The key of the one input request a stateless (2026-07-28) vibe_send asks for. */
const INPUT_KEY = 'send_confirmation';

/** Protocol versions in which a server may send elicitation/create to the client during a call. */
const ELICITATION_VERSIONS = new Set(['2025-06-18', '2025-11-25']);
/** The versions in which a form request carries `mode: "form"`. */
const MODE_VERSIONS = new Set(['2025-11-25', '2026-07-28']);

// ── what the client declared ────────────────────────────────────────────────

/**
 * Form elicitation, from a client capabilities object. In 2025-06-18
 * `elicitation: {}` is the form box; from 2025-11-25 `{}` still means form,
 * `{form: {}}` says so, and `{url: {}}` alone does not offer one.
 */
function declaresForm(capabilities) {
  const e = capabilities && typeof capabilities === 'object' ? capabilities.elicitation : undefined;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const hasForm = Object.prototype.hasOwnProperty.call(e, 'form');
  const hasUrl = Object.prototype.hasOwnProperty.call(e, 'url');
  return hasForm ? Boolean(e.form && typeof e.form === 'object' && !Array.isArray(e.form)) : !hasUrl;
}

let client = null;    // { protocolVersion, form } from the latest initialize
let pending = null;   // an initialize that arrived while a box was open

/**
 * Record a client's initialize (protocol 2025-*). While a box is open the
 * record does not change: the next initialize applies once it is answered.
 */
function noteClient({ protocolVersion, capabilities } = {}) {
  const next = { protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : null, form: declaresForm(capabilities) };
  if (openNow) { pending = next; return; }
  client = next;
}

/** Is a box available on a connection opened with initialize? */
function available() {
  return Boolean(client && client.form && ELICITATION_VERSIONS.has(client.protocolVersion));
}

function clientState() { return client ? { ...client } : null; }
function _resetForTest() { client = null; pending = null; openNow = false; }

// ── display width and wrapping ──────────────────────────────────────────────

const segmenter = typeof Intl === 'object' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** User-perceived characters: never split inside a surrogate pair or a grapheme. */
function graphemes(s) {
  const t = String(s);
  return segmenter ? Array.from(segmenter.segment(t), (x) => x.segment) : Array.from(t);
}
function wideCodePoint(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF)
    || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF)
    || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F)
    || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1F64F)
    || (cp >= 0x1F680 && cp <= 0x1F6FF) || (cp >= 0x1F900 && cp <= 0x1F9FF) || (cp >= 0x1FA70 && cp <= 0x1FAFF)
    || (cp >= 0x20000 && cp <= 0x3FFFD);
}
/** Terminal columns of one grapheme: 2 for wide (CJK) and emoji, else 1. */
function graphemeWidth(g) {
  if (/\p{Emoji_Presentation}/u.test(g) || g.includes('️')) return 2;
  for (const c of g) if (wideCodePoint(c.codePointAt(0))) return 2;
  return 1;
}
function displayWidth(s) { return graphemes(s).reduce((a, g) => a + graphemeWidth(g), 0); }

/**
 * Word-wrap one line by display columns. A token wider than a line is broken
 * between graphemes. Nothing is dropped but the single spaces a break
 * replaces; no line is left empty.
 */
function wrapLine(line, width = WRAP_COLUMNS) {
  if (!width) return [line];
  const out = [];
  let cur = ''; let curW = 0; let has = false;
  const push = () => { out.push(cur); cur = ''; curW = 0; has = false; };
  for (const word of String(line).split(' ')) {
    const w = displayWidth(word);
    if (curW + (has ? 1 : 0) + w <= width) {
      cur = has ? `${cur} ${word}` : word; curW += (has ? 1 : 0) + w; has = true;
      continue;
    }
    if (has && cur !== '') push();
    if (w <= width) { cur = word; curW = w; has = true; continue; }
    // A token wider than a line: break it between graphemes.
    for (const g of graphemes(word)) {
      const gw = graphemeWidth(g);
      if (curW + gw > width && cur !== '') push();
      cur += g; curW += gw; has = true;
    }
  }
  if (has || out.length === 0) out.push(cur);
  return out;
}

/** The text as the box shows it: line breaks as " ↵ ", wrapped by display columns. */
function textLines(text) {
  return wrapLine(String(text).split('\n').join(NEWLINE_MARK));
}

// ── the words in the box ────────────────────────────────────────────────────

/** Characters as the person would count them: code points of the text that is sent. */
const charCount = (text) => Array.from(String(text)).length;

/**
 * Line 1 is fixed server text, never the agent's: who it goes to, that it goes
 * now, and how long it is. The text follows from line 2.
 */
function question({ to, held = false, retry = false, reply = false, text }) {
  const n = charCount(text);
  const len = `(${n} character${n === 1 ? '' : 's'})`;
  if (held) return `Keep this for @${to} until they join /vibe? ${len}`;
  return `Send ${reply ? 'this reply ' : ''}to @${to}${retry ? ' again' : ''} now? ${len}`;
}

/** The box's whole message: the question, then the whole text, wrapped. */
function message(opts) {
  return [question(opts), ...textLines(opts.text)].join('\n');
}

/** Does the whole text show in the lines the host displays under the question? */
function fits(text) {
  return textLines(text).length <= VISIBLE_LINES - 1;
}

/** The params of elicitation/create for a protocol version. */
function request(text, protocolVersion) {
  const params = { message: text, requestedSchema: SCHEMA };
  if (MODE_VERSIONS.has(protocolVersion)) params.mode = 'form';
  return params;
}

// ── asking (2025-* connections) ─────────────────────────────────────────────

let openNow = false;
function isOpen() { return openNow; }

/**
 * Open the box and wait. `box.request(params, { signal })` sends the request
 * to the client and resolves with its result. Returns 'accept', 'decline',
 * 'busy', or 'none' (cancel, error, client refusal, timeout, the call itself
 * cancelled). Only an explicit action "accept" is yes.
 */
async function ask(box, text, { timeoutMs = TIMEOUT_MS, signal = null } = {}) {
  if (openNow) return 'busy';
  if (signal && signal.aborted) return 'none';
  openNow = true;
  const ctl = new AbortController();
  let timer = null;
  let onAbort = null;
  try {
    const stop = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ stopped: 'timeout' }), timeoutMs);
      if (signal) { onAbort = () => resolve({ stopped: 'cancelled' }); signal.addEventListener('abort', onAbort); }
    });
    let result;
    try {
      result = await Promise.race([Promise.resolve().then(() => box.request(request(text, box.protocolVersion), { signal: ctl.signal })), stop]);
    } catch { return 'none'; }
    if (result && result.stopped) { ctl.abort(); return 'none'; }
    const action = result && typeof result === 'object' ? result.action : undefined;
    if (action === 'accept') return 'accept';
    if (action === 'decline') return 'decline';
    return 'none';
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    openNow = false;
    if (pending) { client = pending; pending = null; }
  }
}

// ── hooks that could answer the box ─────────────────────────────────────────

const HOOK_EVENT = /^elicitation(result)?$/i;

/**
 * Does this settings text hold a hook that could answer the box? Any
 * Elicitation or ElicitationResult entry counts, whatever its matcher: the
 * name this server is registered under is the person's choice, not known
 * here. A file that does not parse (after removing a byte-order mark) counts
 * when its text, with \uXXXX escapes decoded, mentions "elicitation".
 */
function settingsAnswerBox(raw) {
  const text = String(raw).replace(/^﻿/, '');
  let s;
  try { s = JSON.parse(text); } catch {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return /elicitation/i.test(decoded);
  }
  const hooks = s && typeof s === 'object' ? s.hooks : undefined;
  if (hooks === undefined || hooks === null) return false;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) return /elicitation/i.test(JSON.stringify(hooks));
  for (const [event, entries] of Object.entries(hooks)) {
    if (!HOOK_EVENT.test(event)) continue;
    if (!Array.isArray(entries) || entries.length > 0) return true;
  }
  return false;
}

function shortPath(file) {
  const home = os.homedir();
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

/** The settings files Claude Code reads hooks from, for this project and this person. */
function settingsFiles(env = process.env, cwd = process.cwd) {
  const files = [];
  let project = null;
  try { project = require('./turns').projectDir(env, cwd); } catch {}
  if (project) {
    files.push(path.join(project, '.claude', 'settings.json'));
    files.push(path.join(project, '.claude', 'settings.local.json'));
  }
  const named = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
  files.push(path.join(named || path.join(os.homedir(), '.claude'), 'settings.json'));
  return files;
}

/**
 * The first settings file with a hook that could answer /vibe's box, as a
 * path to show the person, or null. Files are read through their real path;
 * nothing is written. A file that is missing or cannot be read is skipped:
 * the host cannot read it either.
 */
function answeringHook(env = process.env, cwd = process.cwd) {
  for (const file of settingsFiles(env, cwd)) {
    let real;
    try { real = fs.realpathSync(file); } catch { continue; }
    let raw;
    try {
      if (!fs.statSync(real).isFile()) continue;
      raw = fs.readFileSync(real, 'utf8');
    } catch { continue; }
    if (settingsAnswerBox(raw)) return shortPath(file);
  }
  return null;
}

/**
 * The lab (lab/population.mjs) answers the box with a hook on purpose, so the
 * simulated person's choice goes through the real path. Allowed only when BOTH
 * the lab says so AND /vibe is a server on this machine: a real account is
 * never reached with the box answered by a hook.
 */
function labAllowsHook(env = process.env) {
  if (env.VIBE_LAB_BOX_HOOK !== '1') return false;
  let url = env.VIBE_API_URL;
  if (!url) { try { url = require('./config').getApiUrl(); } catch { return false; } }
  let host;
  try { host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

module.exports = {
  WRAP_COLUMNS, VISIBLE_LINES, NEWLINE_MARK, SCHEMA, TIMEOUT_MS, INPUT_KEY, ELICITATION_VERSIONS,
  declaresForm, noteClient, available, clientState,
  displayWidth, wrapLine, textLines, question, message, fits, request, ask, isOpen,
  settingsAnswerBox, settingsFiles, answeringHook, labAllowsHook,
  _resetForTest,
};
