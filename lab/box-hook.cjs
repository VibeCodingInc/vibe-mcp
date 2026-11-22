#!/usr/bin/env node
'use strict';
// The lab's answer to /vibe's Send box. LAB ONLY.
//
// When the /vibe server under test opens a confirmation box (MCP
// elicitation), Claude Code runs this as an Elicitation hook instead of
// showing it. It asks the same person-player the population runner uses
// (lab/player.mjs: `claude -p`, or --human-cmd) whether this simulated person
// presses Accept or Decline, from the context the runner wrote before the
// turn (persona, what they last typed, what was on their screen earlier), and
// prints the hook's answer. Any error, unreadable answer or timeout is a
// Decline. Each box and its answer is appended to the person's box log, which
// the runner folds into the transcript and summary.
//
// The /vibe server refuses to open a box while a hook like this is configured,
// unless VIBE_LAB_BOX_HOOK=1 AND its API is on this machine (confirm-box.js).
//
//   env VIBE_LAB_BOX_CONTEXT  the context file (JSON) the runner rewrites per turn
//   env VIBE_LAB_BOX_LOG      the per-person log (JSON lines) this appends to
//   stdin                     Claude Code's hook input (its `message` is the box text)
//   stdout                    {"hookSpecificOutput":{"hookEventName":"Elicitation","action":...,"content":{}}}

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEADLINE_MS = Number(process.env.VIBE_LAB_BOX_DEADLINE_MS) || 220000;

let finished = false;
function finish({ message = null, decision = 'decline', why = null, error = null }) {
  if (finished) return;
  finished = true;
  const action = decision === 'accept' ? 'accept' : 'decline';
  const log = process.env.VIBE_LAB_BOX_LOG;
  if (log) {
    try { fs.appendFileSync(log, JSON.stringify({ at: Date.now(), message, decision: action, why, ...(error ? { error } : {}) }) + '\n', { mode: 0o600 }); } catch {}
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action, content: {} } }) + '\n');
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
  let message = null;
  const timer = setTimeout(() => finish({ message, error: 'timeout' }), DEADLINE_MS);
  timer.unref();
  try {
    let input = null;
    try { input = JSON.parse(await readStdin()); } catch { return finish({ error: 'hook input is not JSON' }); }
    message = boxMessage(input);
    if (message === null) return finish({ error: 'no box message in the hook input' });
    const file = process.env.VIBE_LAB_BOX_CONTEXT;
    if (!file) return finish({ message, error: 'VIBE_LAB_BOX_CONTEXT is not set' });
    let ctx;
    try { ctx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return finish({ message, error: 'context file unreadable' }); }
    const player = await import(pathToFileURL(path.join(__dirname, 'player.mjs')).href);
    const r = await player.askPlayer({ prompt: player.boxPrompt(ctx, message), player: ctx.player || {}, emptyDir: ctx.emptyDir || process.cwd(), timeoutMs: Number(ctx.timeoutMs) || 180000 });
    if (r.isError) return finish({ message, error: r.timedOut ? 'player timed out' : 'player failed' });
    const got = player.parseBox(r.raw);
    if (!got) return finish({ message, error: 'player answer unreadable' });
    return finish({ message, decision: got.press, why: got.why });
  } catch (e) {
    return finish({ message, error: `hook error: ${e && e.message ? e.message : e}`.slice(0, 300) });
  }
}

if (require.main === module) main();

module.exports = { boxMessage };
