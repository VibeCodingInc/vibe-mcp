#!/usr/bin/env node
/**
 * /vibe arrival hook — someone wrote to you while you were working.
 *
 * Claude Code runs this on every prompt (UserPromptSubmit) and after tool
 * calls (PostToolUse), so it must cost nothing: NO dependencies, NO network,
 * NO credentials. It reads the local spool the /vibe MCP server writes
 * (arrival.js), claims each arrival once per machine with an atomic `wx` file,
 * and prints the already-rendered text for the model. Empty spool = one
 * readdir and exit.
 *
 * It is installed as a COPY at <VIBE_HOME>/hooks/arrival-hook.cjs so the hook
 * command is a plain `node <file>` (an npx launch on every prompt would cost
 * most of a second). The spool is the sibling directory, so the copy always
 * reads the identity it was installed for.
 *
 * Presentation only: writes no receipt and no read state. The one thing it
 * records is that the person prompted, and when (recordTurn, for vibe_send).
 * When Claude Code has not yet written who started the turn, a detached copy
 * of this file finishes that check (confirmTurn) and exits within seconds.
 *
 * One more thing it does on a prompt: when the person says they are stuck, it
 * reminds the agent, once per session, that vibe_bump exists (see stuckNudge).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 3;
const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

function quiet() { process.stdout.write(JSON.stringify({ suppressOutput: true })); }

function take(dir, now, session) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const shown = new Set(names.filter((n) => n.endsWith('.shown')).map((n) => n.slice(0, -6)));
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json') || rows.length >= MAX) continue;
    const id = name.slice(0, -5);
    if (shown.has(id) || !/^[A-Za-z0-9_-]{4,80}$/.test(id)) continue;
    let row;
    try { row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!row || typeof row.context !== 'string' || !(now - row.at <= TTL_MS)) continue;
    // A row made for one session (who is near, after THIS person said they
    // were stuck) is shown there and nowhere else; it is left for that session.
    if (typeof row.session === 'string' && row.session !== session) continue;
    // A reply the person drafted and left unchosen (unsent.js): said only if
    // the draft is still open now, and not to a session already told at start.
    const unsent = row.kind === 'unsent' ? unsentState(dir, row, session, now) : null;
    // Shown again since it was spooled: not this row's to say, and not claimed,
    // so the server can spool a fresh one once that showing is old enough.
    if (unsent && unsent.later) continue;
    try { fs.closeSync(fs.openSync(path.join(dir, `${id}.shown`), 'wx', 0o600)); } catch { continue; }
    if (unsent && !unsent.say) continue;
    if (unsent && unsent.mark) { try { fs.closeSync(fs.openSync(path.join(dir, `${unsent.mark}.shown`), 'wx', 0o600)); } catch {} }
    rows.push(row);
  }
  return rows;
}

// ── a reply drafted and not sent (unsent.js) ────────────────────────────────
// The session mark's name must match unsent.js sessionMark (a test pins it).
const UNSENT_AFTER_MS = 30 * 60 * 1000;   // = unsent.js MID_SESSION_AFTER_MS
function unsentState(dir, row, session, now = Date.now()) {
  try {
    const draft = typeof row.draft === 'string' && /^w[0-9a-f]{4,32}$/.test(row.draft) ? row.draft : null;
    if (!draft) return { say: false };
    const s = String(session || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const mark = s ? `unsent-${draft}-${s}` : null;
    if (mark && fs.existsSync(path.join(dir, `${mark}.shown`))) return { say: false };
    // The draft must belong to the account the row was spooled for (the
    // server's verified handle). This hook reads no credential file; a switch
    // of account is handled by the server, whose every poll removes rows that
    // do not qualify for the account signed in now (unsent.spool).
    const me = String(row.to || '').toLowerCase();
    if (!me) return { say: false };
    const drafts = JSON.parse(fs.readFileSync(path.join(dir, '..', 'drafts.json'), 'utf8'));
    const d = Array.isArray(drafts) ? drafts.find((x) => x && x.id === draft) : null;
    const open = Boolean(d && d.status === 'previewed' && !d.held &&
      String(d.from || '').toLowerCase() === me &&
      Number.isFinite(d.createdAt) && now - d.createdAt < TTL_MS);
    if (!open) return { say: false };
    // When it was last shown, as spooled: a showing since (or a row that does
    // not say) means the person may be looking at it right now.
    const shownAt = Number.isFinite(d.revAt) ? d.revAt : d.createdAt;
    if (!Number.isFinite(row.shownAt) || shownAt !== row.shownAt) return { say: false, later: true };
    if (now - shownAt < UNSENT_AFTER_MS) return { say: false, later: true };
    return { say: true, mark };
  } catch { return { say: false }; }
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) return quiet();
  // The person typed: a draft prepared before now is one they could have seen.
  // Only on a prompt, never after a tool call (the agent's own turn).
  // Claude Code also runs UserPromptSubmit for a background subagent reporting
  // back, a message from another session, a scheduled task (hooks docs); the
  // input has no field saying who wrote it, so personPrompt() decides from the
  // wrapper rules and then the session transcript, erring toward not counting.
  // An answer in Claude Code's question menu (AskUserQuestion) is never a
  // turn: the agent opens a menu, about anything, mid-run, and what it shows
  // can differ from what is sent.
  const submittedAt = Date.now();
  const person = event === 'UserPromptSubmit' ? personPrompt(input) : 'no';
  if (person === 'yes') recordTurn(input, submittedAt);
  if (person === 'pending') startConfirm(input, submittedAt);

  const dir = process.env.VIBE_ARRIVALS_DIR || path.join(__dirname, '..', 'arrivals');
  const session = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  // The agent looked for someone near by itself: the server need not show it too.
  if (event === 'PostToolUse' && session && /(^|__)vibe_bump$/.test(String(input.tool_name || ''))) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.closeSync(fs.openSync(path.join(dir, `near-${session}.done`), 'wx', 0o600)); } catch {}
  }
  const rows = take(dir, Date.now(), session);
  // The nudge only reminds the agent a tool exists, and it cannot wait for
  // the detached check: shown unless the transcript already said no.
  const nudge = person !== 'no' ? stuckNudge(input, dir) : '';
  if (rows.length === 0 && !nudge) return quiet();

  const context = rows.map((r) => r.context);
  if (nudge) context.push(nudge);
  const shown = rows.map((r) => r.line).filter(Boolean).join('\n');
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    ...(shown ? { systemMessage: shown } : {}),
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context.join('\n\n'),
    },
  }));
}

// ── who wrote this prompt ───────────────────────────────────────────────────
// UserPromptSubmit fires for text no person typed: a subagent's hand-back, a
// message from another Claude session, a background task notification. Seen
// live (2026-11-21): a hand-back beginning "Another Claude session sent a
// message:" recorded a turn, which would unlock a send with no human. There
// is no origin field in the hook input, so a prompt that STARTS with one of
// these wrappers, or is nothing but system-reminder blocks, is not the
// person's. Quoting such text later in a prompt they wrote still counts.
const NOT_PERSON = [
  /^Another Claude session sent a message\b/i,
  /^The coordinator sent a message\b/i,
  /^<agent-message\b/i,
  /^<teammate-message\b/i,
  /^<channel\b/i,
  /^<task-notification\b/i,
  /^\[SYSTEM NOTIFICATION\b/i,
  /^<system-reminder\b/i,   // one left after stripping is unclosed: not theirs either
];
// Leading whitespace, zero-width characters and whole system-reminder blocks
// are stripped before the patterns are tried: a wrapper hidden behind them is
// still a wrapper (review 2026-11-21). A stripped block that carries Claude
// Code's "[SYSTEM NOTIFICATION - NOT USER INPUT]" marks the whole prompt as
// not the person's, whatever follows it. Scanned forward once (sticky
// regexes), so a long prompt costs one pass, not one copy per block.
const LEAD_WS = /[\s\u200B-\u200D\u2060\uFEFF]*/y;
const REMINDER = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/iy;
const NOTIFICATION = '[SYSTEM NOTIFICATION - NOT USER INPUT]';
function personWrote(prompt) {
  if (typeof prompt !== 'string') return false;
  let i = 0;
  for (;;) {
    LEAD_WS.lastIndex = i; LEAD_WS.exec(prompt); i = LEAD_WS.lastIndex;
    REMINDER.lastIndex = i;
    const m = REMINDER.exec(prompt);
    if (!m) break;
    if (m[1].includes(NOTIFICATION)) return false;
    i = REMINDER.lastIndex;
  }
  const said = prompt.slice(i);
  if (!said.trim()) return false;
  return !NOT_PERSON.some((re) => re.test(said));
}

// ── who started this turn, as Claude Code's transcript says ─────────────────
// The wrapper rules above cannot catch a wake-up the agent scheduled for
// itself (ScheduleWakeup, /loop, cron): it fires UserPromptSubmit, and its text
// is whatever the agent chose (seen live 2026-11-21: recorded as the person's
// turn). Claude Code's session transcript (hook input transcript_path, JSONL)
// labels the type:"user" entry that starts each turn: turnOrigin "human"
// (promptSource typed, queued or suggestion_accepted), "scheduled", "peer"
// (subagent hand-back, another session), "task_notification". A prompt given
// through `claude -p` or the Agent SDK is labelled "sdk" (promptSource and
// turnOrigin): that says how it came in, not who wrote it, so it is treated as
// no label at all. These fields are undocumented, observed 2026-11-21 (Claude
// Code 2.1.330), and may change.
//
// After the wrapper rules have not said no:
//   1. the newest user entry in the transcript's tail whose text equals this
//      prompt decides. With a turnOrigin, or failing that origin.kind or
//      promptSource: a turn only if human; "sdk" is today's behaviour, a turn.
//   2. this transcript labels origins (some user entry in the tail has a
//      turnOrigin other than "sdk") and the matching entry has no label: no
//      turn.
//   3. no transcript, an unreadable one, or no labels anywhere in the tail (an
//      older Claude Code, another host, `claude -p`): today's behaviour, a turn.
//
// THE ENTRY MAY NOT BE THERE YET. Claude Code 2.1.330 writes a prompt's entry
// only after its UserPromptSubmit hooks finish (seen with `claude -p --resume`:
// absent for 650 ms of waiting, the whole time the hook ran). So the hook reads
// for up to ~100 ms; if labels exist and the entry has not appeared, it hands
// the decision to a detached copy of itself (confirmTurn) and exits. That copy
// waits up to CONFIRM_MS for the entry and records the turn, dated to the
// prompt, only if the entry is labelled human; otherwise, or if it never
// appears, nothing is recorded. It is given a hash of the prompt, never the
// text.
//
// Only the last TAIL_BYTES are read. Nothing from the transcript is written or
// printed anywhere.
const TAIL_BYTES = 256 * 1024;
const ORIGIN_TRIES = 3;
const ORIGIN_WAIT_MS = 50;          // 2 waits: about 100 ms in the hook itself
const CONFIRM_MS = 5000;
const CONFIRM_POLL_MS = 100;
const HUMAN_SOURCES = new Set(['typed', 'queued', 'suggestion_accepted']);

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

const promptHash = (text) => require('crypto').createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');

/** The complete lines in the last TAIL_BYTES of a file (a line cut by the start is dropped). */
function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // One byte before the window says whether the window starts on a line.
    const from = Math.max(0, size - TAIL_BYTES - 1);
    const buf = Buffer.alloc(size - from);
    const got = fs.readSync(fd, buf, 0, buf.length, from);
    let text = buf.subarray(0, got);
    let cut = false;
    if (from > 0) {
      if (text[0] === 0x0a) text = text.subarray(1);
      else cut = true;
    }
    // '\n' never occurs inside a UTF-8 sequence, so a character split by the
    // window's start can only damage the first line, which is dropped.
    const lines = text.toString('utf8').split('\n');
    if (cut) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

function entryTexts(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  const parts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length ? [parts.join('\n'), parts.join('')] : [];
}

/** 'human' | 'sdk' | 'other' | null (the entry carries no origin field). */
function entryOrigin(e) {
  const label = (v) => (v === 'human' ? 'human' : v === 'sdk' ? 'sdk' : 'other');
  if (typeof e.turnOrigin === 'string') return label(e.turnOrigin);
  if (e.origin && typeof e.origin.kind === 'string') return label(e.origin.kind);
  if (typeof e.promptSource === 'string') return HUMAN_SOURCES.has(e.promptSource) ? 'human' : label(e.promptSource);
  return null;
}

/**
 * One read of the tail, for the prompt whose trimmed text hashes to `want`:
 * { labelled, match: 'human' | 'sdk' | 'other' | 'unlabelled' | null }.
 * Throws if the file cannot be read.
 */
function scanTail(file, want) {
  const lines = tailLines(file);
  let labelled = false;
  let match = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"user"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'user') continue;
    if (typeof e.turnOrigin === 'string' && e.turnOrigin !== 'sdk') labelled = true;
    if (match === null && entryTexts(e).some((t) => promptHash(t) === want)) match = entryOrigin(e) || 'unlabelled';
    if (match !== null && labelled) break;
  }
  return { labelled, match };
}

/** What one read decides: 'human' | 'other' | 'unknown' | null (labels exist, entry not there yet). */
function decide(r) {
  if (r.match === 'human') return 'human';
  if (r.match === 'sdk') return 'unknown';
  if (r.match === 'other') return 'other';
  if (r.match === 'unlabelled') return r.labelled ? 'other' : 'unknown';
  return r.labelled ? null : 'unknown';
}

/**
 * Did the transcript say a person started this turn?
 *   'human'    the matching entry is labelled human
 *   'other'    labelled otherwise, or unlabelled in a transcript that labels
 *   'unknown'  no usable transcript, or no labels: today's rule
 *   'pending'  the transcript labels origins and this prompt's entry is not
 *              written yet (decided later by confirmTurn)
 */
function transcriptOrigin(prompt, file, { tries = ORIGIN_TRIES, waitMs = ORIGIN_WAIT_MS } = {}) {
  if (typeof file !== 'string' || !file || typeof prompt !== 'string') return 'unknown';
  const want = promptHash(prompt);
  for (let t = 0; t < tries; t++) {
    if (t > 0) sleepMs(waitMs);
    let r;
    try { r = scanTail(file, want); } catch { return 'unknown'; }
    const d = decide(r);
    if (d) return d;
  }
  return 'pending';
}

/**
 * The detached copy's job: wait for the entry, record the turn only if it is
 * labelled human (or carries no label in a transcript without labels).
 * Arguments: the prompt's hash, the transcript, when the prompt was submitted,
 * and the input cwd.
 */
function confirmTurn([want, file, at, cwd], { budgetMs = CONFIRM_MS, pollMs = CONFIRM_POLL_MS } = {}) {
  const until = Date.now() + budgetMs;
  for (;;) {
    let d = null;
    try { d = decide(scanTail(file, want)); } catch { return false; }
    if (d === 'human' || d === 'unknown') { recordTurn({ cwd }, Number(at)); return true; }
    if (d === 'other') return false;
    if (Date.now() >= until) return false;
    sleepMs(pollMs);
  }
}

function startConfirm(input, at) {
  try {
    const args = [__filename, '--confirm-turn', promptHash(input.prompt), String(input.transcript_path), String(at), typeof input.cwd === 'string' ? input.cwd : ''];
    const child = require('child_process').spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return true;
  } catch { return false; }
}

/**
 * The person wrote this prompt: 'yes' | 'no' | 'pending' (a detached check
 * decides). The wrapper rules, then the transcript's own label.
 */
function personPrompt(input) {
  if (!input || !personWrote(input.prompt)) return 'no';
  let origin;
  try { origin = transcriptOrigin(input.prompt, input.transcript_path); } catch { origin = 'unknown'; }
  if (origin === 'other') return 'no';
  if (origin === 'pending') return 'pending';
  return 'yes';
}

// ── a person's turn (turns.js) ──────────────────────────────────────────────
// vibe_send sends a draft revision only if the person has prompted since that
// revision was prepared. This records the prompt: a timestamp in a file named
// by a hash of the project directory. No prompt text, no path in clear.
// Keyed by CLAUDE_PROJECT_DIR (the project root, unmoved by a cd) and by the
// input cwd as well when it differs, so a server started in either place
// finds it. key() must match turns.js (a test pins it).
function turnKey(dir) {
  let real = String(dir || '');
  if (!real) return null;
  try { real = fs.realpathSync(real); } catch { real = path.resolve(real); }
  return require('crypto').createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 32);
}

function recordTurn(input, when = Date.now()) {
  try {
    const dir = process.env.VIBE_TURNS_DIR || path.join(__dirname, '..', 'turns');
    const keys = new Set([process.env.CLAUDE_PROJECT_DIR, input.cwd].filter((d) => typeof d === 'string' && d.trim()).map(turnKey).filter(Boolean));
    if (keys.size === 0 || !Number.isFinite(when)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const k of keys) {
      const file = path.join(dir, `${k}.json`);
      // A confirmed turn can land after a later prompt's: never move back.
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).at; } catch {}
      if (Number.isFinite(prev) && prev >= when) continue;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: when }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch {}
}

// ── the bump, made dependable ───────────────────────────────────────────────
// vibe_bump exists for the moment a person is stuck, but whether the agent
// thinks of it was left to the agent, and measured it mostly did not: one
// session in four, and not at all on production. The person saying so in plain
// words is something this hook can see. When they do, the agent is reminded,
// once per session, that the tool exists. Nothing is shown to the person, no
// name is given here (the tool names only people they know), nothing leaves the
// machine, and quiet turns it off with everything else.
// First-person, plain wording only: "the stuck-detection code" must not count.
const STUCK = new RegExp([
  "\\b(i'?m|i am|i'?ve been|i have been|we'?re|we are|we'?ve been|still|totally|completely|really|so|got|getting|been) stuck\\b",
  "\\bstuck (on|with|for|all|here|again)\\b",
  "\\b(keep )?going (a?round )?in circles\\b",
  "\\b(i'?m|i am|we'?re|we are) blocked on\\b",
  "\\bcan(no|')?t figure (this|it|that) out\\b",
  "\\bbanging my head\\b",
  "\\bat my wits'? end\\b",
].join('|'), 'i');

function stuckNudge(input, dir) {
  try {
    const said = typeof input.prompt === 'string' ? input.prompt : '';
    if (!said || said.length > 4000 || !STUCK.test(said)) return '';
    try { if (JSON.parse(fs.readFileSync(path.join(dir, '..', 'reach.json'), 'utf8')).quiet === true) return ''; } catch {}
    const session = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    if (!session) return '';
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Once per session: the first prompt that says it claims the marker.
    try { fs.closeSync(fs.openSync(path.join(dir, `stuck-${session}.shown`), 'wx', 0o600)); } catch { return ''; }
    return [
      '/vibe: the person has just said, in their own words, that they are stuck.',
      'Help with the problem first. Then call vibe_bump once, with one line on what they are stuck on: it says whether someone they already know is in a session right now working on the same thing. If it names nobody who fits, say nothing about it.',
    ].join('\n');
  } catch { return ''; }
}

if (require.main === module) {
  if (process.argv[2] === '--confirm-turn') { try { confirmTurn(process.argv.slice(3)); } catch {} }
  else { try { main(); } catch { quiet(); } }
}
module.exports = { personWrote, personPrompt, transcriptOrigin, confirmTurn, TAIL_BYTES, CONFIRM_MS };
