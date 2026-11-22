#!/usr/bin/env node
'use strict';
// The lab's answer to /vibe's Send box. LAB ONLY.
//
// When the /vibe server under test opens a confirmation box (MCP
// elicitation), Claude Code runs this as an Elicitation hook instead of
// showing it. It asks the same person-player the population runner uses
// (lab/player.mjs: `claude -p`, or --human-cmd) what this simulated person
// does with the box as the host draws it (one empty text field, its title and
// description): type something and Accept, or Decline. It decides from the
// context the runner wrote before the turn (persona, what they last typed,
// what was on their screen earlier), and prints the hook's answer:
//   typed + Accept  {action: "accept", content: {to: "<what they typed>"}}
//   Decline         {action: "decline", content: {}}
// The server decides whether what they typed sends. Any error, unreadable
// answer or timeout is a Decline. Each box and its answer is appended to the
// person's box log (`typed`, the `action` sent, the `field` shown, and
// `decision`: "accept" only when the server's own rule, confirm-box.js
// typedOk, would send to the recipient on line 1), which the runner folds
// into the transcript and summary.
//
// The /vibe server refuses to open a box while a hook like this is configured,
// unless VIBE_LAB_BOX_HOOK=1 AND its API is on this machine (confirm-box.js).
//
//   env VIBE_LAB_BOX_CONTEXT  the context file (JSON) the runner rewrites per turn
//   env VIBE_LAB_BOX_LOG      the per-person log (JSON lines) this appends to
//   stdin                     Claude Code's hook input (its `message` is the box text)
//   stdout                    {"hookSpecificOutput":{"hookEventName":"Elicitation","action":...,"content":{...}}}

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEADLINE_MS = Number(process.env.VIBE_LAB_BOX_DEADLINE_MS) || 220000;

/** The field key the box asks for (the schema's first property), default "to". */
function fieldKey(schema) {
  const props = schema && typeof schema === 'object' ? schema.properties : null;
  const k = props && typeof props === 'object' ? Object.keys(props)[0] : null;
  return k || 'to';
}

/**
 * The hook's answer: what the person typed, with Accept, or a Decline.
 * Defined here, not in player.mjs, so the hook still answers when that
 * import fails.
 */
function answerFor(typed, key = 'to') {
  if (typeof typed === 'string' && typed.trim() !== '') return { action: 'accept', content: { [key]: typed } };
  return { action: 'decline', content: {} };
}

/** Who the box is for, from its fixed first line ("Send to @x? …", "Reply to", "Resend to", "Keep for"). */
function recipientOf(message) {
  const m = String(message || '').match(/^(?:Send to|Reply to|Resend to|Keep for) @([a-z0-9_-]+)\?/);
  return m ? m[1] : null;
}

/** The schema the server sends for the box on line 1 (confirm-box.js schemaFor), or null. */
function serverSchema(message) {
  const to = recipientOf(message);
  if (!to) return null;
  try { return require('../confirm-box').schemaFor(to, { held: /^Keep for /.test(String(message)) }); } catch { return null; }
}

/** Would the server send on this answer? Its own rule, on the recipient named on line 1. */
function wouldSend(message, answer, key = 'to') {
  if (!answer || answer.action !== 'accept') return false;
  const to = recipientOf(message);
  if (!to) return false;
  try { return require('../confirm-box').typedOk(to, answer.content[key]); } catch { return false; }
}

let finished = false;
function finish({ message = null, schema = null, typed = null, why = null, error = null }) {
  if (finished) return;
  finished = true;
  const key = fieldKey(schema);
  const answer = error ? answerFor(null) : answerFor(typed, key);
  const log = process.env.VIBE_LAB_BOX_LOG;
  if (log) {
    let field = null;
    try { const p = schema && schema.properties && schema.properties[key]; if (p) field = { title: p.title || key, description: p.description || '' }; } catch {}
    const entry = { at: Date.now(), message, field, action: answer.action, ...(answer.action === 'accept' ? { typed: answer.content[key] } : {}), decision: wouldSend(message, answer, key) ? 'accept' : 'decline', why, ...(error ? { error } : {}) };
    try { fs.appendFileSync(log, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch {}
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', ...answer } }) + '\n');
  process.exit(0);
}

/** The box text from the hook input. Claude Code's field is `message`; the others are tolerated. */
function boxMessage(input) {
  if (!input || typeof input !== 'object') return null;
  for (const v of [input.message, input.elicitation && input.elicitation.message, input.params && input.params.message]) {
    if (typeof v === 'string') return v;
  }
  return null;
}

/** The requested schema from the hook input (Claude Code: `requested_schema`; the others are tolerated). */
function boxSchema(input) {
  if (!input || typeof input !== 'object') return null;
  for (const v of [input.requested_schema, input.requestedSchema, input.elicitation && input.elicitation.requestedSchema, input.params && input.params.requestedSchema]) {
    if (v && typeof v === 'object') return v;
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (s.length < 1_000_000) s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

async function main() {
  let message = null; let schema = null;
  const timer = setTimeout(() => finish({ message, schema, error: 'timeout' }), DEADLINE_MS);
  timer.unref();
  try {
    let input = null;
    try { input = JSON.parse(await readStdin()); } catch { return finish({ error: 'hook input is not JSON' }); }
    message = boxMessage(input);
    if (message === null) return finish({ error: 'no box message in the hook input' });
    // The field as the server asked for it; if the host did not pass the
    // schema on, the one the server would send for the recipient on line 1.
    schema = boxSchema(input) || serverSchema(message);
    const file = process.env.VIBE_LAB_BOX_CONTEXT;
    if (!file) return finish({ message, schema, error: 'VIBE_LAB_BOX_CONTEXT is not set' });
    let ctx;
    try { ctx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return finish({ message, schema, error: 'context file unreadable' }); }
    const player = await import(pathToFileURL(path.join(__dirname, 'player.mjs')).href);
    const r = await player.askPlayer({ prompt: player.boxPrompt(ctx, message, player.boxField(schema)), player: ctx.player || {}, emptyDir: ctx.emptyDir || process.cwd(), timeoutMs: Number(ctx.timeoutMs) || 180000 });
    if (r.isError) return finish({ message, schema, error: r.timedOut ? 'player timed out' : 'player failed' });
    const got = player.parseBox(r.raw);
    if (!got) return finish({ message, schema, error: 'player answer unreadable' });
    return finish({ message, schema, typed: got.press === 'accept' ? got.typed : null, why: got.why });
  } catch (e) {
    return finish({ message, schema, error: `hook error: ${e && e.message ? e.message : e}`.slice(0, 300) });
  }
}

if (require.main === module) main();

module.exports = { boxMessage, boxSchema, serverSchema, answerFor, recipientOf, wouldSend };
