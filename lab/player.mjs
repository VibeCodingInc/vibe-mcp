// The person-player: the model (or command) that plays a simulated person at
// the keyboard. Shared by the population runner (population.mjs), which asks
// "what do you type next?", and the Send box hook (box-hook.cjs), which asks
// "this box appeared; Accept or Decline?". Importing this file starts nothing.
//
// The built-in player is `claude -p` with no tools, no MCP, no hooks and no
// CLAUDE.md, from an empty directory. A --human-cmd player is any shell
// command: the full prompt (HUMAN_SYSTEM, a blank line, the prompt) on stdin,
// its stdout parsed the same way, with every VIBE_* / SLASHVIBE_* variable
// removed from its environment.
import { spawn } from 'node:child_process';

export const HUMAN_SYSTEM = 'You play one specific person sitting at their own computer. You answer only with the JSON object asked for, nothing else.';

/** Strict JSON from a model's answer, tolerating a code fence or text around it. */
function jsonObject(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tryParse = (x) => { try { const o = JSON.parse(x); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  let o = tryParse(s);
  if (!o) { const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a >= 0 && b > a) o = tryParse(s.slice(a, b + 1)); }
  return o;
}

export function parseHuman(raw) {
  const o = jsonObject(raw);
  if (!o || !('reply' in o)) return null;
  const reply = typeof o.reply === 'string' && o.reply.trim() ? o.reply.trim() : null;
  // Optional: something the person now means to do themselves later ("ask
  // kenji about the oven"), carried in their diary as an open intention.
  const intends = typeof o.intends === 'string' && o.intends.trim() ? o.intends.trim().replace(/\s+/g, ' ').slice(0, 160) : null;
  return { reply, why: typeof o.why === 'string' ? o.why : '', ...(intends ? { intends } : {}) };
}

export function askHuman({ prompt, model, emptyDir, emptyMcp, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    // No tools, no MCP, no hooks, no CLAUDE.md: --safe-mode plus an empty strict
    // MCP config, project/local settings only, from an empty directory.
    const args = ['-p', prompt, '--safe-mode', '--strict-mcp-config', '--mcp-config', emptyMcp, '--setting-sources', 'project,local', '--tools', '', '--system-prompt', HUMAN_SYSTEM, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { cwd: emptyDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ parsed: null, raw: '', isError: true, code: null, timedOut, stderr: String(e && e.message || e).slice(0, 2000) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = ''; let isError = false;
      try { const o = JSON.parse(out); result = o.result || ''; isError = Boolean(o.is_error); } catch { result = out; isError = true; }
      const parsed = isError ? null : parseHuman(result);
      resolve({ parsed, raw: result, isError: isError || timedOut, code, timedOut, stderr: err.slice(0, 2000) });
    });
  });
}

// The environment a --human-cmd player runs with: the runner's own, minus every
// /vibe variable (VIBE_HOME, VIBE_API_URL, VIBE_AGENT_* and the rest). Sessions
// get theirs from their own MCP config; the person-player never sees any.
export function humanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(VIBE_|SLASHVIBE_)/i.test(k)));
}

// The person-player as any shell command (--human-cmd), so another model family
// can play the people. The full prompt (HUMAN_SYSTEM, a blank line, then the
// prompt) goes in on stdin; stdout is parsed by parseHuman. Same timeout as
// askHuman; on timeout the whole process group is killed, so a pipeline's
// children cannot keep the pipes (and this promise) open.
export function askHumanCmd({ prompt, cmd, emptyDir, timeoutMs = 180000, env = process.env }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('/bin/sh', ['-c', cmd], { cwd: emptyDir, env: humanEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached: true }); } catch (e) {
      resolve({ parsed: null, raw: '', isError: true, code: null, timedOut: false, stderr: String(e && e.message || e).slice(0, 2000) }); return;
    }
    let out = ''; let err = ''; let timedOut = false; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    child.stdout.on('data', (d) => { if (out.length < 200000) out += d; }); child.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    child.stdin.on('error', () => {});   // a command that never reads stdin
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    child.on('error', (e) => finish({ parsed: null, raw: out, isError: true, code: null, timedOut, stderr: `${err}${e.message}`.slice(0, 2000) }));
    child.on('close', (code) => {
      const isError = timedOut || code !== 0;
      finish({ parsed: isError ? null : parseHuman(out), raw: out, isError, code, timedOut, stderr: err.slice(0, 2000) });
    });
    child.stdin.end(`${HUMAN_SYSTEM}\n\n${prompt}`);
  });
}

/**
 * Ask whichever player this run uses. `player` is { cmd } for --human-cmd, or
 * { model, emptyMcp } for the built-in claude -p player.
 */
export function askPlayer({ prompt, player = {}, emptyDir, timeoutMs = 180000 }) {
  return player.cmd
    ? askHumanCmd({ prompt, cmd: player.cmd, emptyDir, timeoutMs })
    : askHuman({ prompt, model: player.model || null, emptyDir, emptyMcp: player.emptyMcp, timeoutMs });
}

// ── the Send box ────────────────────────────────────────────────────────────

/** How many lines of a box message the host shows (Claude Code 2.1.330), then "… (+N more lines)". */
export const BOX_VISIBLE_LINES = 3;

/** The box as the host draws it: its title, the first lines of the message, Accept / Decline. */
export function boxOnScreen(message, server = 'vibe') {
  const lines = String(message || '').split('\n');
  const shown = lines.slice(0, BOX_VISIBLE_LINES);
  if (lines.length > BOX_VISIBLE_LINES) shown.push(`… (+${lines.length - BOX_VISIBLE_LINES} more lines)`);
  return [`MCP server "${server}" requests your input`, ...shown, '[ Accept ]   [ Decline ]'].join('\n');
}

/** The question the box puts to the simulated person, from the runner's context for this turn. */
export function boxPrompt(ctx, message) {
  const c = ctx || {};
  return [
    `You are ${c.name} (@${c.handle}), ${c.role}.`,
    '',
    `About you: ${c.persona}`,
    '',
    'You are working at your own computer with Claude Code, an AI coding assistant that runs in your terminal and works in your project folder.',
    c.memory ? `\n${c.memory}\n` : '',
    c.earlier ? `\nEarlier in this same Claude Code session:\n${c.earlier}\n` : '',
    `You just typed:\n"""\n${c.typed || ''}\n"""`,
    '',
    `While Claude was working on that, this box appeared in your terminal:\n"""\n${boxOnScreen(message)}\n"""`,
    '',
    `Do you, ${c.name}, press Accept or Decline?`,
    '- Stay in character. Accept sends that message, in your name, to that person now.',
    '- You only know what is on your screen and what you yourself know.',
    '- Do not be agreeable for its own sake.',
    '',
    'Answer with strict JSON and nothing else: {"press": "accept" or "decline", "why": string}. "why" is one short sentence on your reasoning.',
  ].join('\n');
}

/** The player's answer to a box: 'accept', 'decline', or null when it cannot be read. */
export function parseBox(raw) {
  const o = jsonObject(raw);
  if (!o || typeof o.press !== 'string') return null;
  const press = o.press.trim().toLowerCase();
  if (press !== 'accept' && press !== 'decline') return null;
  return { press, why: typeof o.why === 'string' ? o.why : '' };
}
