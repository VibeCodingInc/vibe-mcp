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
    const unsent = row.kind === 'unsent' ? unsentState(dir, row, session) : null;
    try { fs.closeSync(fs.openSync(path.join(dir, `${id}.shown`), 'wx', 0o600)); } catch { continue; }
    if (unsent && !unsent.say) continue;
    if (unsent && unsent.mark) { try { fs.closeSync(fs.openSync(path.join(dir, `${unsent.mark}.shown`), 'wx', 0o600)); } catch {} }
    rows.push(row);
  }
  return rows;
}

// ── a reply drafted and not sent (unsent.js) ────────────────────────────────
// The session mark's name must match unsent.js sessionMark (a test pins it).
function unsentState(dir, row, session) {
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
      Number.isFinite(d.createdAt) && Date.now() - d.createdAt < TTL_MS);
    return { say: open, mark };
  } catch { return { say: false }; }
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) return quiet();
  // The person typed: a draft prepared before now is one they could have seen.
  // Only on a prompt, never after a tool call (the agent's own turn).
  if (event === 'UserPromptSubmit') recordTurn(input);

  const dir = process.env.VIBE_ARRIVALS_DIR || path.join(__dirname, '..', 'arrivals');
  const session = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  // The agent looked for someone near by itself: the server need not show it too.
  if (event === 'PostToolUse' && session && /(^|__)vibe_bump$/.test(String(input.tool_name || ''))) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.closeSync(fs.openSync(path.join(dir, `near-${session}.done`), 'wx', 0o600)); } catch {}
  }
  const rows = take(dir, Date.now(), session);
  const nudge = event === 'UserPromptSubmit' ? stuckNudge(input, dir) : '';
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

try { main(); } catch { quiet(); }
