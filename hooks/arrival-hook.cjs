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
 * Presentation only: writes no receipt and no read state. It records that
 * the person prompted, and when (recordTurn, for vibe_send), and, per session,
 * which replies to the person's own messages were shown there (openLanded),
 * so the agent can be reminded of a note back on the next prompts.
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
  // input has no field saying who wrote it, so personWrote() decides by the
  // wrappers those carry, erring toward not counting. A prompt the agent
  // scheduled for itself carries no wrapper and still counts: a known gap
  // (SECURITY.md). An answer in Claude Code's question menu
  // (AskUserQuestion) is never a turn: the agent opens a menu, about
  // anything, mid-run, and what it shows can differ from what is sent.
  if (event === 'UserPromptSubmit' && personWrote(input.prompt)) recordTurn(input);

  const dir = process.env.VIBE_ARRIVALS_DIR || path.join(__dirname, '..', 'arrivals');
  const session = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  // The agent looked for someone near by itself: the server need not show it too.
  if (event === 'PostToolUse' && session && /(^|__)vibe_bump$/.test(String(input.tool_name || ''))) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.closeSync(fs.openSync(path.join(dir, `near-${session}.done`), 'wx', 0o600)); } catch {}
  }
  // Reminders for replies shown earlier in this session, read BEFORE this
  // pause's own rows are taken: a reply shown now is not reminded of now.
  const person = event === 'UserPromptSubmit' && personWrote(input.prompt);
  // Replies the session-start hook showed: decided and opened on the first
  // prompt of the session, and reminded of on that same prompt.
  if (person) adoptStart(dir, session, input, Date.now());
  const landed = person ? landedReminders(dir, session, Date.now()) : [];
  const rows = take(dir, Date.now(), session);
  for (const r of rows) openLanded(dir, session, r, Date.now());
  const nudge = person ? stuckNudge(input, dir) : '';
  if (rows.length === 0 && !nudge && landed.length === 0) return quiet();

  const context = rows.map((r) => r.context);
  if (nudge) context.push(nudge);
  // For the agent only (additionalContext): never in the person's line.
  context.push(...landed);
  const now = Date.now();
  const shown = rows.map((r) => shownLine(r, now)).filter(Boolean).join('\n');
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    ...(shown ? { systemMessage: shown } : {}),
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context.join('\n\n'),
    },
  }));
}

// ── a note back, kept in reach (notice.js landedReminder) ──────────────────
// The note-back hook rides on the arrival of a reply to the person's own
// message, and by the time that reply has changed the work it is many turns
// back. When such a row is shown in a session, this records it, and the next
// prompts the person writes in that session carry one agent-facing line about
// it: at most LANDED_TIMES times, for LANDED_TTL_MS, and never once a note
// back for that reply has been opened (landed.json, drafts.json). Nothing here
// watches files or the work: whether the reply changed anything is the
// agent's to judge, and the note is a draft the person chooses about. The
// server decides which rows qualify (arrival.js render: a person's reply to
// the person's own message, not an agent, not an open line, not a first
// message); this only keeps the record. One small file per session.
const LANDED_TIMES = 3;
// notice.js LANDED_RECEIPT_SHORT (landedReceipt), copied so this hook needs
// nothing else from the package; a test keeps the two equal. The switch is
// read where the record is opened (arrival.js, session-start-hook.cjs).
const LANDED_RECEIPT_SHORT = 'The note is a one-sentence receipt of what changed on the person\'s side (the file, setting or decision actually updated; say "not deployed yet" or "local only" when it is not live), with only numbers and names from their files or the answer, and no question, request or instruction to them; anything more the person needs from them is a separate ordinary draft. If nothing changed, no note back.';
const LANDED_TTL_MS = 2 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/;
const SAFE_HANDLE = /^[A-Za-z0-9_.-]{1,40}$/;

function landingFile(dir, session) {
  return session ? path.join(dir, '..', 'landing', `${session}.json`) : null;
}

function readLanding(file) {
  try {
    const open = JSON.parse(fs.readFileSync(file, 'utf8')).open;
    return Array.isArray(open) ? open.filter((r) => r && SAFE_ID.test(r.id) && SAFE_HANDLE.test(r.from) && Number.isFinite(r.at)) : [];
  } catch { return []; }
}

function writeLanding(file, open) {
  try {
    if (open.length === 0) { try { fs.unlinkSync(file); } catch {} return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ open }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

/** A row shown in this session that names a reply to the person's own message: open its record. */
function openLanded(dir, session, row, now = Date.now()) {
  try {
    const l = row && row.landed;
    if (!l || !SAFE_ID.test(l.id) || !SAFE_HANDLE.test(l.from)) return;
    const file = landingFile(dir, session);
    if (!file) return;
    const open = readLanding(file).filter((r) => r.id !== l.id);
    open.push({ id: l.id, from: l.from, to: String(row.to || '').toLowerCase(), at: now, told: 0, ...(l.asDraft === true ? { asDraft: true } : {}), ...(l.receipt === true ? { receipt: true } : {}) });
    writeLanding(file, open.slice(-10));
  } catch {}
}

// ── replies shown at session start (session-start-hook.cjs shownForLanding) ──
// The session-start hook writes what it showed; the first prompt the person
// writes in that session takes the file and decides, from this machine's own
// records, which shown messages were replies to the person's own message:
// the same test as arrival.js repliesToOwn (a return binding for that sender,
// made by this account, with a message id, and their message written after
// it), with the same exclusions (an agent, an open line, a first message
// after an invitation, first contact: no binding). The match is by session
// id, which SessionStart and UserPromptSubmit share; without one, by the
// project directory (turns.js key) and a start no older than START_ADOPT_MS.
const START_ADOPT_MS = 15 * 60 * 1000;
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // = tools/drafts.js BINDING_TTL_MS
const normHandle = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();

function takeFile(file) {
  // Claimed by rename: two prompts racing cannot both adopt the same start.
  const mine = `${file}.${process.pid}.taken`;
  try { fs.renameSync(file, mine); } catch { return null; }
  try { return JSON.parse(fs.readFileSync(mine, 'utf8')); } catch { return null; } finally { try { fs.unlinkSync(mine); } catch {} }
}

function adoptStart(dir, session, input, now = Date.now()) {
  try {
    if (!session) return;
    const landing = path.join(dir, '..', 'landing');
    let start = takeFile(path.join(landing, `start-${session}.json`));
    if (!start) {
      const dirs = [...new Set([process.env.CLAUDE_PROJECT_DIR, input && input.cwd].filter((d) => typeof d === 'string' && d.trim()))];
      for (const d of dirs) {
        const k = turnKey(d);
        const got = k ? takeFile(path.join(landing, `start-dir-${k}.json`)) : null;
        if (got && Number.isFinite(got.at) && now - got.at >= 0 && now - got.at <= START_ADOPT_MS) { start = got; break; }
      }
    }
    if (!start || !Array.isArray(start.shown) || !Number.isFinite(start.at) || !(now - start.at <= LANDED_TTL_MS)) return;
    const home = path.join(dir, '..');
    let bindings = {};
    let lines = {};
    try { bindings = JSON.parse(fs.readFileSync(path.join(home, 'return-bindings.json'), 'utf8')) || {}; } catch {}
    try { lines = JSON.parse(fs.readFileSync(path.join(home, 'lines.json'), 'utf8')) || {}; } catch {}
    const file = landingFile(dir, session);
    let open = readLanding(file);
    for (const m of start.shown.slice(0, 10)) {
      if (!m || !SAFE_ID.test(m.id) || !SAFE_HANDLE.test(m.from) || m.kind === 'agent' || m.invited === true) continue;
      const from = normHandle(m.from);
      const to = normHandle(m.to);
      if (!to || Object.prototype.hasOwnProperty.call(lines, from)) continue;
      const b = bindings && typeof bindings === 'object' ? bindings[from] : null;
      if (!b || typeof b !== 'object' || !b.messageId || !Number.isFinite(b.sentAt)) continue;
      if (b.from && normHandle(b.from) !== to) continue;
      if (now - b.sentAt > BINDING_TTL_MS || !Number.isFinite(m.at) || !(m.at > b.sentAt)) continue;
      open = open.filter((r) => r.id !== m.id);
      open.push({ id: m.id, from, to, at: start.at, told: 0, ...(start.asDraft === true ? { asDraft: true } : {}), ...(start.receipt === true ? { receipt: true } : {}) });
    }
    writeLanding(file, open.slice(-10));
  } catch {}
}

/** Was a note back already opened for this reply, on this machine? */
function landedOpened(dir, rec) {
  const home = path.join(dir, '..');
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'landed.json'), 'utf8'));
    const tail = `>${String(rec.from).toLowerCase()}#${rec.id}`;
    if (ledger && typeof ledger === 'object' && Object.keys(ledger).some((k) => k.endsWith(tail))) return true;
  } catch {}
  try {
    const drafts = JSON.parse(fs.readFileSync(path.join(home, 'drafts.json'), 'utf8'));
    if (Array.isArray(drafts) && drafts.some((d) => d && d.kind === 'landed' && d.replyTo === rec.id)) return true;
  } catch {}
  return false;
}

/** The agent-facing lines for this prompt; counts each one. */
function landedReminders(dir, session, now = Date.now()) {
  try {
    const file = landingFile(dir, session);
    if (!file) return [];
    const open = readLanding(file);
    if (open.length === 0) return [];
    try { if (JSON.parse(fs.readFileSync(path.join(dir, '..', 'reach.json'), 'utf8')).quiet === true) return []; } catch {}
    const keep = [];
    const say = [];
    for (const r of open) {
      if (!(now - r.at <= LANDED_TTL_MS) || !(Number(r.told) < LANDED_TIMES) || landedOpened(dir, r)) continue;
      const receipt = r.receipt === true ? ` ${LANDED_RECEIPT_SHORT}` : '';
      say.push(r.asDraft === true
        ? `/vibe: @${r.from}'s answer ${r.id} reached the person earlier in this session. If it has changed what you do here, then once that change is made (in this reply or a later one), end that reply by opening one note back as a draft: vibe_prepare, kind landed, reply_to ${r.id}, asked: false. One line, in the person's own terms.${receipt} The draft is the offer and sends nothing; do not ask in prose whether they want one. Otherwise ignore this.`
        : `/vibe: @${r.from}'s answer ${r.id} arrived earlier in this session. If it has changed what you do here, then once that change is made, offer one note back: vibe_prepare, kind landed, reply_to ${r.id}, asked: false. One line, in the person's own terms, sent only if they choose.${receipt} Otherwise ignore this.`);
      const told = Number(r.told) + 1;
      if (told < LANDED_TIMES) keep.push({ ...r, told });
    }
    writeLanding(file, keep);
    return say;
  } catch { return []; }
}

// ── the line the person sees ────────────────────────────────────────────────
// A row may carry a header (arrival.js, notice.js arrivalHeader): the person's
// own words, said as a note that waited for this pause, with its age worked
// out now, when it is printed. This hook runs only at a pause (a prompt, or
// after a tool step), so "waiting at your pause" is what happened. Anything
// malformed falls back to the row's plain line. ago() and headerLine() must
// match arrival.js (a test pins them).
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function ago(ms) {
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function headerLine(h, now = Date.now()) {
  const bits = [Number.isFinite(h.at) ? ago(now + (Number.isFinite(h.shift) ? h.shift : 0) - h.at) : '', h.invited ? 'you invited them' : ''].filter(Boolean).join('; ');
  return `/vibe · Note from @${h.from}${bits ? ` (${bits})` : ''}, waiting at your pause: "${h.said}"`;
}
function shownLine(row, now = Date.now()) {
  const h = row && row.header;
  const ok = h && typeof h === 'object' && typeof h.from === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(h.from) &&
    typeof h.said === 'string' && h.said.length <= 160 && !CTRL.test(h.said);
  // The fallback is the server's own line; C1 controls are stripped all the same.
  return ok ? headerLine(h, now) : (row && typeof row.line === 'string' ? row.line.replace(/[\u0080-\u009f]/g, ' ') : row && row.line);
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
module.exports = { personWrote, shownLine, headerLine, ago, landedReminders, openLanded, adoptStart, LANDED_TIMES, LANDED_TTL_MS, START_ADOPT_MS, LANDED_RECEIPT_SHORT };
