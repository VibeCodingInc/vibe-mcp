'use strict';

/**
 * The Send box — the person confirms a send in a box the server opens.
 *
 * The promise: a message goes out in a person's name only after that person
 * saw the exact text and chose to send it. The turn check (turns.js) can only
 * tell that the person typed something after the draft was shown; any prompt
 * counts, even "no, don't send". Where the host can show a box itself (MCP
 * elicitation, declared by the client at initialize), vibe_send asks the
 * person directly: the box shows the exact text and offers Accept / Decline.
 * The model never sees the box or the answer, only the tool result.
 *
 * This file holds:
 *   - what the client declared at initialize, and whether a box is available;
 *   - the box's wording, wrapping and size limit (constants, in one place);
 *   - the one-box-at-a-time guard and the timeout;
 *   - the scan for hooks that could answer the box without the person
 *     (Claude Code's Elicitation / ElicitationResult hook events).
 *
 * Read-only on the person's settings: nothing here writes a file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── the box, in one place ───────────────────────────────────────────────────

/** Display-only wrapping of the text in the box. 0 turns it off. Never changes what is sent. */
const WRAP_COLUMNS = 72;
/**
 * How many lines of the message the host's box shows before "… (+N more
 * lines)" (Claude Code 2.1.330, tested by hand). The box message is laid out
 * to put as much of the real text as possible in these.
 */
const VISIBLE_LINES = 3;
/** A line break inside the text, as shown in the box: it does not use up a line. Display only. */
const NEWLINE_MARK = ' \u21b5 ';
/** The form asked for: no fields, so the box is Accept / Decline. */
const SCHEMA = Object.freeze({ type: 'object', properties: Object.freeze({}) });
/** How long a box may stay open before the send is given up. */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Protocol versions in which a server may send elicitation/create on stdio. */
const ELICITATION_VERSIONS = new Set(['2025-06-18', '2025-11-25']);
/** The version from which a form request carries `mode: "form"`. */
const MODE_VERSIONS = new Set(['2025-11-25']);

// ── what the client declared ────────────────────────────────────────────────

let client = null;   // { protocolVersion, form }

/**
 * Record the client's initialize: the negotiated protocol version and whether
 * it declared form elicitation. In 2025-06-18 `elicitation: {}` is the form
 * box; from 2025-11-25 `{}` still means form, and `{form: {}}` says so
 * explicitly, while `{url: {}}` alone does not offer one.
 */
function noteClient({ protocolVersion, capabilities } = {}) {
  const e = capabilities && typeof capabilities === 'object' ? capabilities.elicitation : undefined;
  let form = false;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const hasForm = Object.prototype.hasOwnProperty.call(e, 'form');
    const hasUrl = Object.prototype.hasOwnProperty.call(e, 'url');
    form = hasForm ? Boolean(e.form && typeof e.form === 'object') : !hasUrl;
  }
  client = { protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : null, form };
}

/** Is a box available on this connection? Only for an initialized client that declared form elicitation, in a version that has it. */
function available() {
  return Boolean(client && client.form && ELICITATION_VERSIONS.has(client.protocolVersion));
}

function clientState() { return client ? { ...client } : null; }
function _resetForTest() { client = null; openNow = false; }

// ── the words in the box ────────────────────────────────────────────────────

/** Word-wrap one line for display. Words longer than the width are broken. Nothing is dropped but the space a break replaces. */
function wrapLine(line, width) {
  if (!width || line.length <= width) return [line];
  const out = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    } else {
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
  }
  out.push(rest);
  return out;
}

/** Display-only wrapping. The text that is sent is never this string. */
function wrap(text, width = WRAP_COLUMNS) {
  return String(text).split('\n').map((l) => wrapLine(l, width).join('\n')).join('\n');
}

/**
 * The box's message. The host shows only its first VISIBLE_LINES lines, so
 * there is no header line and no blank line: line 1 begins with who it is for
 * ("To @handle: ", "Reply to @handle: ", "Keep for @handle: " for someone not
 * on /vibe yet, "To @handle (again): " for a retry of an unconfirmed Send),
 * followed directly by the text. A line break in the text is shown as " ↵ ".
 * The whole text is always in the message; the host decides how much shows.
 */
function message({ to, held = false, retry = false, reply = false, text }) {
  const lead = held ? `Keep for @${to}: ` : `${reply ? 'Reply to' : 'To'} @${to}${retry ? ' (again)' : ''}: `;
  return wrap(lead + String(text).split('\n').join(NEWLINE_MARK));
}

/** Does the whole box message show in the lines the host displays? */
function fits(boxMessage) {
  return String(boxMessage).split('\n').length <= VISIBLE_LINES;
}

/** The params of elicitation/create for this connection. */
function request(text, protocolVersion) {
  const params = { message: text, requestedSchema: SCHEMA };
  if (MODE_VERSIONS.has(protocolVersion)) params.mode = 'form';
  return params;
}

// ── asking ──────────────────────────────────────────────────────────────────

let openNow = false;
function isOpen() { return openNow; }

/**
 * Open the box and wait. `box.request(params, { signal })` sends the request
 * to the client and resolves with its result. Returns 'accept', 'decline' or
 * 'none' (cancel, error, client refusal, timeout, anything else). Only an
 * explicit action "accept" is yes.
 */
async function ask(box, text, { timeoutMs = TIMEOUT_MS } = {}) {
  if (openNow) return 'busy';
  openNow = true;
  const ctl = new AbortController();
  let timer = null;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
    let result;
    try {
      result = await Promise.race([Promise.resolve().then(() => box.request(request(text, box.protocolVersion), { signal: ctl.signal })), timeout]);
    } catch { return 'none'; }
    if (result && result.timedOut) { ctl.abort(); return 'none'; }
    const action = result && typeof result === 'object' ? result.action : undefined;
    if (action === 'accept') return 'accept';
    if (action === 'decline') return 'decline';
    return 'none';
  } finally {
    if (timer) clearTimeout(timer);
    openNow = false;
  }
}

// ── hooks that could answer the box ─────────────────────────────────────────

const HOOK_EVENTS = ['Elicitation', 'ElicitationResult'];
const SERVER_NAMES = ['vibe', 'slashvibe'];

/** Would this matcher catch /vibe's box? Missing, empty, "*", not a string, not a valid pattern, or matching our names: yes. */
function matcherCatches(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== 'string') return true;
  const t = m.trim();
  if (t === '' || t === '*') return true;
  let re;
  try { re = new RegExp(t, 'i'); } catch { return true; }
  return SERVER_NAMES.some((n) => re.test(n));
}

/** Does this settings text hold a hook that could answer the box? */
function settingsAnswerBox(raw) {
  let s;
  try { s = JSON.parse(raw); } catch {
    // Unreadable as JSON: refuse only when it names the events at all.
    return HOOK_EVENTS.some((e) => raw.includes(e));
  }
  const hooks = s && typeof s === 'object' ? s.hooks : undefined;
  if (hooks === undefined || hooks === null) return false;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) return HOOK_EVENTS.some((e) => raw.includes(e));
  for (const event of HOOK_EVENTS) {
    if (!Object.prototype.hasOwnProperty.call(hooks, event)) continue;
    const entries = hooks[event];
    if (!Array.isArray(entries)) return true;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      if (matcherCatches(entry.matcher)) return true;
    }
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
  WRAP_COLUMNS, VISIBLE_LINES, NEWLINE_MARK, SCHEMA, TIMEOUT_MS, ELICITATION_VERSIONS,
  noteClient, available, clientState, wrap, message, fits, request, ask, isOpen,
  matcherCatches, settingsAnswerBox, settingsFiles, answeringHook, labAllowsHook,
  _resetForTest,
};
