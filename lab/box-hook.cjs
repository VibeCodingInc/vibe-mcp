#!/usr/bin/env node
'use strict';
// The lab's answer to /vibe's Send box. LAB ONLY.
//
// When the /vibe server under test opens a confirmation box (MCP
// elicitation), Claude Code runs this as an Elicitation hook instead of
// showing it. It asks the same person-player the population runner uses
// (lab/player.mjs: `claude -p`, or --human-cmd) what this simulated person
// does with the box as the host draws it (a required choice, nothing chosen):
// choose Send and Accept, choose Not now and Accept, or Decline. It decides
// from the context the runner wrote before the turn (persona, what they last
// typed, what was on their screen earlier), and prints the hook's answer:
//   Send     {action: "accept", content: {choice: "send"}}
//   Not now  {action: "accept", content: {choice: "not_now"}}
//   Decline  {action: "decline", content: {}}
// Any error, unreadable answer or timeout is a Decline. Each box and its
// answer is appended to the person's box log (`choice`, the `action` sent,
// and `decision`: "accept" only for Send, else "decline"), which the runner
// folds into the transcript and summary.
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

/**
 * The hook's answer for what the person did: Send and Not now are both an
 * Accept carrying the choice; anything else is a Decline. Defined here, not
 * in player.mjs, so the hook still answers when that import fails.
 */
function answerFor(choice) {
  if (choice === 'send') return { action: 'accept', content: { choice: 'send' } };
  if (choice === 'not_now') return { action: 'accept', content: { choice: 'not_now' } };
  return { action: 'decline', content: {} };
}

let finished = false;
function finish({ message = null, choice = 'decline', why = null, error = null }) {
  if (finished) return;
  finished = true;
  const c = choice === 'send' || choice === 'not_now' ? choice : 'decline';
  const answer = answerFor(c);
  const log = process.env.VIBE_LAB_BOX_LOG;
  if (log) {
    const entry = { at: Date.now(), message, choice: c, action: answer.action, decision: c === 'send' ? 'accept' : 'decline', why, ...(error ? { error } : {}) };
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
    return finish({ message, choice: got.choice, why: got.why });
  } catch (e) {
    return finish({ message, error: `hook error: ${e && e.message ? e.message : e}`.slice(0, 300) });
  }
}

if (require.main === module) main();

module.exports = { boxMessage, answerFor };
