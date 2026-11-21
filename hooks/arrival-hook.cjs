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
  // input has no field saying who wrote it, so personWrote() decides, erring
  // toward not counting. An answer in the question menu (AskUserQuestion) is
  // never a general turn: the agent can ask one about anything, mid-run. It
  // approves one draft only, when the menu itself showed that draft's exact
  // text and the person chose Send (menuApproval).
  if (event === 'UserPromptSubmit' && personWrote(input.prompt)) recordTurn(input);
  if (event === 'PostToolUse') { const ok = menuApproval(input); if (ok) recordMenuApproval(input, ok); }

  const dir = process.env.VIBE_ARRIVALS_DIR || path.join(__dirname, '..', 'arrivals');
  const session = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  // The agent looked for someone near by itself: the server need not show it too.
  if (event === 'PostToolUse' && session && /(^|__)vibe_bump$/.test(String(input.tool_name || ''))) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.closeSync(fs.openSync(path.join(dir, `near-${session}.done`), 'wx', 0o600)); } catch {}
  }
  const rows = take(dir, Date.now(), session);
  const nudge = event === 'UserPromptSubmit' && personWrote(input.prompt) ? stuckNudge(input, dir) : '';
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
// are stripped, repeatedly, before the patterns are tried: a wrapper hidden
// behind them is still a wrapper (review 2026-11-21).
const LEADING = /^(?:[\s\u200B-\u200D\u2060\uFEFF]+|<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>)/i;
function personWrote(prompt) {
  if (typeof prompt !== 'string') return false;
  let said = prompt;
  for (let i = 0; i < 1000; i++) {
    const next = said.replace(LEADING, '');
    if (next === said) break;
    said = next;
  }
  if (!said.trim()) return false;
  return !NOT_PERSON.some((re) => re.test(said));
}

// ── a Send chosen in the question menu ──────────────────────────────────────
// Claude Code's question menu (AskUserQuestion) is a choice the person makes,
// but a menu can be about anything, and the agent opens it mid-run: counted
// as a turn, "Run the tests now?" -> Yes unlocked a send (review 2026-11-21).
// So a menu answer approves ONE draft, and only when:
//   - the menu put that draft in front of the person: the question, or the
//     chosen option's description or preview, holds the draft's exact current
//     text (whitespace normalised) and its recipient's @handle;
//   - the chosen option's label starts with "Send" (not Other free text, not
//     a multi-select, not Edit or Cancel);
//   - exactly one open draft matches.
// It is recorded as {id, rev, at}; vibe_send accepts it for that id and rev
// only (turns.js menuApproved). Result shape from Claude Code transcripts
// (toolUseResult: {questions, answers: {question: label}, annotations}); the
// hooks reference does not document it.
const ws = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
/** = tools/drafts.js compose() and textHash(): what is sent, and the rev that binds it. */
function composeDraft(d) {
  const refs = Array.isArray(d.refs) && d.refs.length ? '\n' + d.refs.map((r) => `${r.title}: ${r.url}`).join('\n') : '';
  return `${d.body || ''}${refs}`;
}
function revOfDraft(d) {
  const h = composeDraft(d) + (d.replyTo ? `\n\u21a9${d.replyTo}` : '') + (d.held ? '\nheld-for-github' : '');
  return require('crypto').createHash('sha1').update(h).digest('hex').slice(0, 8);
}
function menuApproval(input, draftsFile = path.join(process.env.VIBE_ARRIVALS_DIR || path.join(__dirname, '..', 'arrivals'), '..', 'drafts.json')) {
  try {
    if (!input || input.tool_name !== 'AskUserQuestion') return null;
    const r = input.tool_response;
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.is_error === true || r.error) return null;
    const answers = r.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    const questions = Array.isArray(r.questions) ? r.questions : (Array.isArray(input.tool_input && input.tool_input.questions) ? input.tool_input.questions : []);
    const menus = [];
    for (const q of questions) {
      if (!q || typeof q.question !== 'string' || q.multiSelect === true) continue;
      const label = answers[q.question];
      if (typeof label !== 'string' || !/^\s*send\b/i.test(label)) continue;
      const opt = (Array.isArray(q.options) ? q.options : []).find((o) => o && o.label === label);
      if (!opt) continue;   // "Other": the person's own words, not this option
      menus.push(ws([q.question, opt.description, opt.preview].filter((x) => typeof x === 'string').join(' ')));
    }
    if (menus.length === 0) return null;
    const drafts = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
    if (!Array.isArray(drafts)) return null;
    const now = Date.now();
    const hits = drafts.filter((d) => d && d.status === 'previewed' && !d.held && typeof d.id === 'string' &&
      Number.isFinite(d.createdAt) && now - d.createdAt < TTL_MS && ws(composeDraft(d)) &&
      menus.some((m) => m.includes(ws(composeDraft(d))) && m.toLowerCase().includes(`@${String(d.to || '').toLowerCase()}`)));
    if (hits.length !== 1) return null;
    return { id: hits[0].id, rev: revOfDraft(hits[0]) };
  } catch { return null; }
}

function recordMenuApproval(input, ok) {
  try {
    const dir = process.env.VIBE_TURNS_DIR || path.join(__dirname, '..', 'turns');
    const keys = new Set([process.env.CLAUDE_PROJECT_DIR, input.cwd].filter((d) => typeof d === 'string' && d.trim()).map(turnKey).filter(Boolean));
    if (keys.size === 0) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ id: ok.id, rev: ok.rev, at: Date.now() });
    for (const k of keys) {
      const file = path.join(dir, `${k}.menu.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch {}
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

function recordTurn(input) {
  try {
    const dir = process.env.VIBE_TURNS_DIR || path.join(__dirname, '..', 'turns');
    const keys = new Set([process.env.CLAUDE_PROJECT_DIR, input.cwd].filter((d) => typeof d === 'string' && d.trim()).map(turnKey).filter(Boolean));
    if (keys.size === 0) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const at = JSON.stringify({ at: Date.now() });
    for (const k of keys) {
      const file = path.join(dir, `${k}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, at, { mode: 0o600 });
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

if (require.main === module) { try { main(); } catch { quiet(); } }
module.exports = { personWrote, menuApproval, revOfDraft };
