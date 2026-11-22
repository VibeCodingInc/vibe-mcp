'use strict';

/**
 * The Send box — the person confirms a send in a box /vibe opens.
 *
 * The promise: a message goes out in a person's name only after that person
 * saw the exact text and chose to send it. The turn check (turns.js) can only
 * tell that the person typed something after the draft was shown; any prompt
 * counts, even "no, don't send". Where the host can show a box itself (MCP
 * elicitation), vibe_send also asks the person directly: a box whose first
 * line is fixed /vibe wording (recipient, length, whether all of it is
 * shown), then the text, each line quoted with "> ", then one required text
 * field (type the first letters of the recipient) and Accept / Decline.
 * The box shows the start of the text, not the reply target and not exact
 * spacing, so the preview is where the person reads the message:
 *   - wherever person turns are recorded, a send needs the turn check (a
 *     typed message after the preview) AND the recipient's letters typed and
 *     accepted in the box, for every draft;
 *   - where the turn check is unavailable (a host that is not Claude Code, or
 *     Claude Code with no turn ever recorded because the hook is not
 *     installed), the box alone decides.
 * The model never sees the box or the answer, only the tool result.
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
/**
 * The form asked for: one required text field, no default. The person types
 * the first letters of who it is going to: always more letters than any
 * ordinary reply word the handle begins with (rule, below). History:
 *   0.9.23  no fields: Accept was pre-selected, and a stray Enter (one still
 *           queued after the person typed "send") accepted the box before they
 *           saw it.
 * Live key tests on Claude Code 2.1.330 chose this field over the others: a
 * required text field with no default refuses Enter ("This field is
 * required"), typing goes straight into it, and the message area still shows
 * VISIBLE_LINES lines. A choice field was too hard to accept; a tick box and
 * a "type s" field were accepted by the very habit that caused the 0.9.23 bug.
 * A first cut asked for two letters, so "no" sent to @noah and "edit" to
 * @edith: a reply word typed into the box must never be the send key.
 */
const FIELD = 'to';
/**
 * Ordinary replies a person types without reading the box: yes-words,
 * refusals, fillers, a few other languages, and single digits. No word here,
 * typed alone, ever sends (rule). Lower-case.
 */
const REPLY_WORDS = Object.freeze([
  's', 'send', 'y', 'ye', 'yes', 'yea', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'k', 'kk', 'sure', 'fine', 'good', 'go', 'do',
  'n', 'no', 'nope', 'nah', 'not', 'don', 'dont', 'stop', 'wait', 'hold', 'later', 'cancel', 'edit', 'esc', 'x', 'q', 'nvm',
  'hi', 'hey', 'hm', 'hmm', 'ah', 'oh', 'um', 'uh', 'er', 'lol', 'wow', 'thx', 'ty', 'pls', 'thanks', 'maybe',
  'ja', 'si', 'da', 'oui', 'non', 'nein',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);
/**
 * Longest field title, in characters, that Claude Code shows uncut (2.1.330
 * cut a title at about 47: "Confirm send (Space to toggle Yes, then ↓ Accep…").
 */
const TITLE_MAX = 40;
const FIELD_LIMITS = Object.freeze({ minLength: 1, maxLength: 40 });
const ENTER_NOTE = 'Enter alone will not send; Esc cancels.';

/** Typed text as compared: trimmed, ASCII letters lower-cased (nothing else folded). */
const fold = (v) => String(v).trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * What the person must type to send to `to`: { need, len, at }. The first
 * `len` characters of the handle, where len = max(2, 1 + the longest reply
 * word the handle starts with); when that is longer than the handle, "@" and
 * the whole handle (at: true).
 */
function rule(to) {
  const h = fold(to);
  const longest = REPLY_WORDS.reduce((m, w) => (h.startsWith(w) && w.length > m ? w.length : m), 0);
  const len = Math.max(2, longest + 1);
  if (len > h.length) return { need: `@${h}`, len, at: true };
  return { need: h.slice(0, len), len, at: false };
}

/**
 * Does the typed value confirm a send to `to`? Trimmed, ASCII lower-cased: a
 * prefix of the handle at least `len` long (one optional leading "@"), or, in
 * the "@" case, exactly "@" + handle. Nothing shorter.
 */
function typedOk(to, value) {
  if (typeof value !== 'string') return false;
  const h = fold(to);
  if (!h) return false;
  const r = rule(h);
  const t = fold(value);
  if (r.at) return t === r.need;
  const bare = t.startsWith('@') ? t.slice(1) : t;
  return bare.length >= r.len && h.startsWith(bare);
}

/** The field's title and description for a box to `to` (`held`: a kept-for-later box), within TITLE_MAX. */
function fieldText(to, { held = false, env = process.env } = {}) {
  const h = fold(to);
  const r = rule(h);
  let long;
  let short;
  if (require('./notice').on('confirmTitle', env)) {
    // A person who has just said "send" in chat reads this box as the
    // confirmation of that send, not a second request (BRIEF-20, minute 3-4).
    // Wording only: what counts as a yes is typedOk, unchanged.
    const verb = held ? 'keep' : 'send';
    long = `Type "${r.need}" to confirm: ${verb} ${held ? 'for' : 'to'} @${h}`;
    short = `Type "${r.need}" to confirm ${verb}`;
  } else {
    const verb = held ? 'keep it' : 'send';
    long = `Type "${r.need}" to ${verb} ${held ? 'for' : 'to'} @${h}`;
    short = `Type "${r.need}" to ${verb}`;
  }
  const fits = (t) => t.length <= TITLE_MAX;
  const title = fits(long) ? long : fits(short) ? short : 'Type @ and the whole handle';
  const what = r.at
    ? `"@" and the whole handle of who it is going to${title === long ? '' : ', as on the first line'}.`
    : 'The first letters of who it is going to.';
  return { title, description: `${what} ${ENTER_NOTE}` };
}

/** The requestedSchema for a box to `to`. */
function schemaFor(to, opts = {}) {
  const { title, description } = fieldText(to, opts);
  return {
    type: 'object',
    properties: { [FIELD]: { type: 'string', title, description, ...FIELD_LIMITS } },
    required: [FIELD],
  };
}

/**
 * The person's answer, from an elicitation result for a box to `to`:
 * 'accept' only for action "accept" whose content has its own `to` string
 * that typedOk accepts; 'decline' for an explicit decline; 'wrong' for an
 * accept with any other content; else 'none'. All but 'accept' are a
 * non-accept.
 */
function answerOf(result, to) {
  if (!result || typeof result !== 'object') return 'none';
  if (result.action === 'decline') return 'decline';
  if (result.action !== 'accept') return 'none';
  const c = result.content;
  const ok = c && typeof c === 'object' && !Array.isArray(c) && Object.prototype.hasOwnProperty.call(c, FIELD) && typedOk(to, c[FIELD]);
  return ok ? 'accept' : 'wrong';
}
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

/**
 * Whitespace, for display: every Unicode space (including tab and the
 * no-break and ideographic spaces), and the blanks that render empty (U+2800
 * braille blank, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0).
 */
const DISPLAY_SPACE = /[\s\u2800\u115F\u1160\u3164\uFFA0]+/gu;

/**
 * The text as the box shows it: line breaks as " ↵ ", every run of whitespace
 * as one space (so padding cannot push the text out of the visible lines),
 * wrapped by display columns. Display only.
 */
function textLines(text) {
  const shown = String(text).split('\n').map((l) => l.replace(DISPLAY_SPACE, ' ').trim()).join(NEWLINE_MARK);
  return wrapLine(shown.replace(DISPLAY_SPACE, ' ').trim(), WRAP_COLUMNS - QUOTE.length);
}
/**
 * Each line of the person's text starts with "> ", so the text cannot pose
 * as /vibe's own wording or the host's. Counted in the wrap width.
 */
const QUOTE = '> ';

// ── the words in the box ────────────────────────────────────────────────────

/** Characters as a person would count them: grapheme clusters of the text that is sent (code points without Intl.Segmenter). */
const charCount = (text) => graphemes(text).length;

/**
 * Line 1 is fixed server text, never the agent's: who it goes to, that it goes
 * now, and how long it is. The text follows from line 2.
 */
function question({ to, held = false, retry = false, reply = false, text }) {
  const n = charCount(text);
  const whole = fits(text);
  // Both facts, always: how long it is, and whether all of it is below. Within
  // 72 columns for the longest handle (39) and a 4-digit count: the long form
  // when it fits, else the short one.
  const lead = held ? `Keep for @${to}?` : `${retry ? 'Resend' : reply ? 'Reply' : 'Send'} to @${to}?`;
  const chars = `${n} char${n === 1 ? '' : 's'}`;
  const long = `${lead} (${chars}, ${whole ? 'all shown' : 'start only'})`;
  return long.length <= WRAP_COLUMNS ? long : `${lead} (${chars}, ${whole ? 'all' : 'start'})`;
}

/** The box's whole message: the question, then the whole text, each line quoted, wrapped. */
function message(opts) {
  return [question(opts), ...textLines(opts.text).map((l) => QUOTE + l)].join('\n');
}

/** Does the whole text show in the lines the host displays under the question? */
function fits(text) {
  return textLines(text).length <= VISIBLE_LINES - 1;
}

/** The params of elicitation/create for a protocol version. */
function request(text, protocolVersion, to, { held = false } = {}) {
  const params = { message: text, requestedSchema: schemaFor(to, { held }) };
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
 * cancelled, an accept with the wrong text). Only action "accept" with the
 * recipient's letters typed is yes (answerOf).
 */
async function ask(box, text, { to, held = false, timeoutMs = TIMEOUT_MS, signal = null } = {}) {
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
      result = await Promise.race([Promise.resolve().then(() => box.request(request(text, box.protocolVersion, to, { held }), { signal: ctl.signal })), stop]);
    } catch { return 'none'; }
    if (result && result.stopped) { ctl.abort(); return 'none'; }
    const answer = answerOf(result, to);
    return answer === 'wrong' ? 'none' : answer;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    openNow = false;
    if (pending) { client = pending; pending = null; }
  }
}

// ── hooks that could answer the box ─────────────────────────────────────────
// A tripwire for the documented settings locations, checked exactly: each
// file is parsed as JSON, and only a key `Elicitation` or `ElicitationResult`
// under `hooks` (as the host reads it, case-sensitive) refuses. A settings
// file that exists but does not parse refuses too, named: it cannot be
// checked. It reads the files on disk now, not what the host loaded. Not
// covered: a file passed with `claude --settings`, plugin hooks, hooks in
// skill, agent or command frontmatter if the host honours them, and anything
// the host adds later.

const HOOK_EVENTS = ['Elicitation', 'ElicitationResult'];

/**
 * One settings text: 'hook' (an Elicitation or ElicitationResult key under
 * hooks), 'json' (it does not parse as JSON, after removing a byte-order
 * mark), or null.
 */
function settingsAnswerBox(raw) {
  let s;
  try { s = JSON.parse(String(raw).replace(/^﻿/, '')); } catch { return 'json'; }
  const hooks = s && typeof s === 'object' && !Array.isArray(s) ? s.hooks : undefined;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  return HOOK_EVENTS.some((e) => Object.prototype.hasOwnProperty.call(hooks, e)) ? 'hook' : null;
}

function shortPath(file) {
  const home = os.homedir();
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

/** The managed (enterprise) settings file for this platform, or null. */
function managedSettingsFile(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'linux') return '/etc/claude-code/managed-settings.json';
  return null;
}

/**
 * The four files the tripwire reads: the project's .claude/settings.json and
 * settings.local.json, the user's settings.json (CLAUDE_CONFIG_DIR, or
 * ~/.claude), and the managed settings file.
 */
function settingsFiles(env = process.env, cwd = process.cwd, { platform = process.platform } = {}) {
  const files = [];
  let project = null;
  try { project = require('./turns').projectDir(env, cwd); } catch {}
  if (project) {
    files.push(path.join(project, '.claude', 'settings.json'));
    files.push(path.join(project, '.claude', 'settings.local.json'));
  }
  const named = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
  const configDir = named || path.join(os.homedir(), '.claude');
  files.push(path.join(configDir, 'settings.json'));
  const managed = managedSettingsFile(platform);
  if (managed) files.push(managed);
  return files;
}

/**
 * The first settings file that trips the wire, as { file, why: 'hook' | 'json' }
 * with a path to show the person, or null. Read through the real path; nothing
 * is written. A missing file is skipped; one that exists but cannot be read
 * is skipped too (the host cannot read it either), named only with VIBE_DEBUG.
 */
function answeringHook(env = process.env, cwd = process.cwd) {
  for (const file of settingsFiles(env, cwd)) {
    let real;
    try { real = fs.realpathSync(file); } catch { continue; }
    let raw;
    try {
      if (!fs.statSync(real).isFile()) continue;
      raw = fs.readFileSync(real, 'utf8');
    } catch {
      if (env.VIBE_DEBUG) { try { process.stderr.write(`/vibe: hook scan could not read ${shortPath(file)}\n`); } catch {} }
      continue;
    }
    const why = settingsAnswerBox(raw);
    if (why) return { file: shortPath(file), why };
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
  WRAP_COLUMNS, VISIBLE_LINES, NEWLINE_MARK, TIMEOUT_MS, INPUT_KEY, ELICITATION_VERSIONS,
  FIELD, REPLY_WORDS, TITLE_MAX, rule, typedOk, fieldText, schemaFor, answerOf,
  declaresForm, noteClient, available, clientState,
  displayWidth, wrapLine, textLines, question, message, fits, request, ask, isOpen,
  settingsAnswerBox, settingsFiles, answeringHook, labAllowsHook, managedSettingsFile,
  _resetForTest,
};
