#!/usr/bin/env node
// Population runner: many fictional PAIRS of people, each pair doing up to a
// week ("days" 1..7) of ordinary work in separate REAL Claude Code sessions (`claude -p`),
// with a simulated human at each keyboard deciding what to type next. Nothing
// is scripted to approve anything: whether a message is offered, what it says,
// whether the person sends it, and whether it arrives and is answered is all
// left to the product, the agent and the simulated person. Everything is
// recorded so a later judge can read it against each world's answer key.
//
//   node lab/population.mjs <world.json|dir> [more ...] --out <dir>
//        [--model sonnet] [--human-model sonnet | --human-cmd "<command>"] [--concurrency 3]
//        [--turn-timeout 300] [--max-human-replies 3] [--limit N]
//        [--force] [--keep]
//
// In plain words: each world file describes two or three fictional people (who they
// are, how they talk, the files in their project folder), whether they already
// know each other or one just invited the others (with three people, all know
// each other when "established"; in a fresh_invite only pairs with the inviter
// start out known), and a timeline of what each
// of them types on each day (a whole number 1..7; the timeline is listed in day
// order and played in that order). The runner plays that timeline: a person's
// first prompt on a day opens a new Claude Code session, later prompts that day
// continue it. A continued session is what a person who left Claude Code open
// sees when they come back and type: that day's /vibe server is kept running
// between turns (harness keepOpen), so what arrived meanwhile is at their next
// prompt, as it would be; the SessionStart hook does not run again. After every turn a separate model, given only that person's
// persona and what appeared on their screen, decides what they would type next
// (or nothing). Per world it writes <out>/<id>/transcript.json, transcript.md
// and summary.json (prepares, sends, sends that went out with no human reply
// between the preview and the send, send attempts the product refused (counted
// apart: nothing went out), messages that never reached the recipient's screen,
// tool errors, time), and <out>/population-summary.{json,md} across worlds.
// A world with a summary.json is skipped on rerun unless --force. A directory
// argument means every *.json in it. A person may carry an optional
// `knows_as: { "<other handle>": "<line>" }`: who that person is to them, in
// their words, written to their own store at setup (who.js) so the same world
// can be run with and without it.
//
// The person-player is `claude -p` (--human-model picks its model) unless
// --human-cmd "<command>" is given, so a different model family can play the
// people. Then every decision runs that command through /bin/sh, from the same
// empty directory, with the full prompt on stdin (the HUMAN_SYSTEM line, a
// blank line, then the prompt humanPrompt builds); its stdout must hold the
// same JSON ({"reply": string|null, "why": string}), read by parseHuman. Same
// timeout as claude -p. Its environment is the runner's minus every VIBE_* /
// SLASHVIBE_* variable: it never gets a person's VIBE_HOME or /vibe credentials.
// A non-zero exit counts as "typed nothing" (unparsed), and a failure whose
// output looks like auth/limits stops the run as for claude -p.
// summary.json and population-summary record which player was used (the
// --human-model value, or "cmd"), never the command itself: it may hold a key.
//
// /vibe's Send box: where the server opens a confirmation box, Claude Code runs
// an Elicitation hook (lab/box-hook.cjs) from each person's scratch settings
// instead of drawing it. The hook asks the same person-player, from a context
// file this runner rewrites before every turn, and the box and the answer are
// folded into the transcript (kind "box") and the summary (boxes shown,
// accepted, declined). A send that went out is unattended only with neither an
// accepted box nor a human reply since the draft was last shown. The server
// allows a hook to answer its box only with VIBE_LAB_BOX_HOOK=1 and a loopback
// API, which every lab server has.
//
// Same safety as rehearse.mjs: every world gets its own in-process stub on
// 127.0.0.1, every person their own VIBE_HOME, MCP config and scratch settings
// file. Nothing reaches production or ~/.claude/settings.json. The world's
// `truth` is never shown to any session or to the human simulator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startStub } from './stub.mjs';
import { identity, session, keepOpen, caughtUp, REPO } from './harness.mjs';
import { HUMAN_SYSTEM, parseHuman, askHuman, askHumanCmd, humanEnv, boxOnScreen } from './player.mjs';

// The person-player functions live in player.mjs so the Send box hook
// (box-hook.cjs) asks the same player; re-exported for the lab's tests.
export { askHumanCmd, humanEnv };
const LAB = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

// The person's session: their files, and /vibe. No Bash, no Agent, no web.
// vibe_send is always allowed: the product must enforce approval itself.
const BUILTINS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const TOOLS = [...BUILTINS, 'mcp__vibe__vibe_people', 'mcp__vibe__vibe_thread', 'mcp__vibe__vibe_prepare', 'mcp__vibe__vibe_discard', 'mcp__vibe__vibe_start',
  'mcp__vibe__vibe_ask', 'mcp__vibe__vibe_answer', 'mcp__vibe__vibe_visit', 'mcp__vibe__vibe_bump', 'mcp__vibe__vibe_send'];

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const o = { files: [], out: null, model: null, humanModel: 'sonnet', humanCmd: null, concurrency: 3, turnTimeout: 300, maxHumanReplies: 3, limit: 0, force: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--out') o.out = next();
    else if (a === '--model') o.model = next();
    else if (a === '--human-model') o.humanModel = next();
    else if (a === '--human-cmd') { o.humanCmd = next(); if (!o.humanCmd.trim()) throw new Error('--human-cmd needs a command'); }
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === '--turn-timeout') o.turnTimeout = Math.max(10, Number(next()) || 300);
    else if (a === '--max-human-replies') o.maxHumanReplies = Math.max(0, Number(next()) || 0);
    else if (a === '--limit') o.limit = Math.max(0, Number(next()) || 0);
    else if (a === '--force') o.force = true;
    else if (a === '--keep') o.keep = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.files.push(a);
  }
  return o;
}

// A directory argument means every *.json in it, sorted.
function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) out.push(...fs.readdirSync(f).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(f, n)));
    else out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- validation
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,38}$/;

// ---------------------------------------------------------------- the Send box
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
/** Add the Elicitation hook (matcher: the lab's server name) that answers /vibe's box with box-hook.cjs. */
export function installBoxHook(settingsFile, id) {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  s.hooks ||= {};
  s.hooks.Elicitation = [{ matcher: 'vibe', hooks: [{ type: 'command', timeout: 240, command: `VIBE_LAB_BOX_CONTEXT=${q(id.boxContext)} VIBE_LAB_BOX_LOG=${q(id.boxLog)} ${q(process.execPath)} ${q(path.join(LAB, 'box-hook.cjs'))}` }] }];
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  return s;
}
/** What the box hook needs to ask the person-player, rewritten before every turn. */
export function writeBoxContext(id, { person, handle, typed, earlier, opts, emptyDir, emptyMcp }) {
  const ctx = { name: person.name, role: person.role, persona: person.persona, handle, typed, earlier, emptyDir, timeoutMs: 180000,
    player: opts.humanCmd ? { cmd: opts.humanCmd } : { model: opts.humanModel || null, emptyMcp } };
  fs.writeFileSync(id.boxContext, JSON.stringify(ctx), { mode: 0o600 });
  return ctx;
}
/** The boxes the hook recorded for one person, oldest first. */
export function readBoxLog(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** Who a box was for, read from its first line ("To @x: ", "Reply to @x: ", "Keep for @x: "). */
export const boxRecipient = (text) => { const m = String(text || '').match(/^(?:To|Reply to|Keep for) @([a-z0-9_-]+)/); return m ? m[1] : null; };
// A story may run up to a week: timeline days are whole numbers 1..MAX_DAY.
export const MAX_DAY = 7;
// A world is a pair, or three people who all work near each other.
export const MAX_PEOPLE = 3;
function validateWorld(w) {
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return ['world is not a JSON object'];
  if (!str(w.id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(w.id)) errs.push('id must be a short string of letters, digits, "-", "_" or "."');
  if (!str(w.archetype)) errs.push('archetype must be a non-empty string');
  if (!['established', 'fresh_invite'].includes(w.relationship)) errs.push('relationship must be "established" or "fresh_invite"');
  if (typeof w.open_line !== 'boolean') errs.push('open_line must be true or false');
  const people = w.people && typeof w.people === 'object' && !Array.isArray(w.people) ? w.people : null;
  const handles = people ? Object.keys(people) : [];
  if (!people) errs.push('people must be an object keyed by handle');
  else if (handles.length < 2 || handles.length > MAX_PEOPLE) errs.push(`people must name two or three handles (got ${handles.length})`);
  for (const h of handles) {
    const p = people[h];
    if (!HANDLE.test(h)) errs.push(`people.${h}: handle must match ${HANDLE}`);
    if (!p || typeof p !== 'object') { errs.push(`people.${h} must be an object`); continue; }
    for (const k of ['name', 'role', 'says', 'persona']) if (!str(p[k])) errs.push(`people.${h}.${k} must be a non-empty string`);
    if (p.files !== undefined && (typeof p.files !== 'object' || p.files === null || Array.isArray(p.files))) errs.push(`people.${h}.files must be an object of "rel/path": "content"`);
    // Optional: who the other person is to this one, in this person's words
    // (who.js), written to their store at setup so a world can run with and without it.
    if (p.knows_as !== undefined) {
      if (typeof p.knows_as !== 'object' || p.knows_as === null || Array.isArray(p.knows_as)) errs.push(`people.${h}.knows_as must be an object of "<handle>": "<line>"`);
      else for (const [k, v] of Object.entries(p.knows_as)) {
        if (!HANDLE.test(k)) errs.push(`people.${h}.knows_as: "${k}" must be a handle matching ${HANDLE}`);
        else if (k === h) errs.push(`people.${h}.knows_as: a person does not note themselves`);
        if (!str(v)) errs.push(`people.${h}.knows_as["${k}"] must be a non-empty string`);
      }
    }
    for (const [rel, content] of Object.entries(p.files || {})) {
      if (typeof content !== 'string') errs.push(`people.${h}.files["${rel}"] must be a string`);
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) errs.push(`people.${h}.files["${rel}"]: path must be relative and stay inside the work dir`);
    }
  }
  if (w.relationship === 'fresh_invite') {
    if (!handles.includes(w.inviter)) errs.push('fresh_invite needs inviter: one of the handles');
  } else if (w.inviter !== undefined && !handles.includes(w.inviter)) errs.push('inviter, when given, must be one of the handles');
  if (!Array.isArray(w.timeline) || w.timeline.length === 0) errs.push('timeline must be a non-empty array');
  else w.timeline.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errs.push(`timeline[${i}] must be an object`); return; }
    if (!handles.includes(t.who)) errs.push(`timeline[${i}].who must be one of ${handles.join(', ')}`);
    if (!Number.isInteger(t.day) || t.day < 1 || t.day > MAX_DAY) errs.push(`timeline[${i}].day must be a whole number from 1 to ${MAX_DAY}`);
    if (!str(t.prompt)) errs.push(`timeline[${i}].prompt must be a non-empty string`);
  });
  // The timeline is played in file order, so it must already be in day order:
  // a day-3 entry after a day-4 one would open a session "back in time".
  if (Array.isArray(w.timeline)) {
    let last = 0;
    w.timeline.forEach((t, i) => {
      if (!t || !Number.isInteger(t.day)) return;
      if (t.day < last) errs.push(`timeline[${i}].day is ${t.day} after a day-${last} entry: list the timeline in day order`);
      else last = t.day;
    });
  }
  return errs;
}

/** Write a person's knows_as lines into their own store (who.js), as `who @h "..."` would. Returns what is stored. */
export function seedKnowsAs(home, knowsAs) {
  const who = require(path.join(REPO, 'who.js'));
  const env = { ...process.env, VIBE_HOME: home };
  for (const [k, v] of Object.entries(knowsAs || {})) who.set(k, v, env);
  return who.all(env).map((e) => ({ handle: e.handle, line: e.line }));
}
export { validateWorld, parseArgs, parseHuman, humanPrompt, HUMAN_SYSTEM, writePopulation, analyse };

// ---------------------------------------------------------------- human simulator
function screenText(evts) {
  const lines = [];
  for (const e of evts) {
    if (e.kind === 'shown') lines.push(`[a line appeared in your terminal]\n${e.text}`);
    else if (e.kind === 'text') lines.push(`[Claude]\n${e.text}`);
    else if (e.kind === 'returned') lines.push(`[the /vibe tool printed]\n${e.text}`);
    else if (e.kind === 'box') lines.push(`[a box appeared]\n${boxOnScreen(e.text)}\n[you pressed ${e.decision === 'accept' ? 'Accept' : 'Decline'}]`);
  }
  return lines.join('\n\n') || '(nothing appeared on the screen)';
}

function humanPrompt(person, handle, typed, screen, earlier) {
  return [
    `You are ${person.name} (@${handle}), ${person.role}.`,
    '',
    `About you: ${person.persona}`,
    '',
    'You are working at your own computer with Claude Code, an AI coding assistant that runs in your terminal and works in your project folder.',
    earlier ? `\nEarlier in this same Claude Code session:\n${earlier}\n` : '',
    `You just typed:\n"""\n${typed}\n"""`,
    '',
    `This is what then appeared on your screen, in order:\n"""\n${screen}\n"""`,
    '',
    `Decide what you, ${person.name}, would type next in this session, if anything.`,
    '- Stay in character: your own voice, your usual length, your usual habits.',
    '- You only know what is on your screen and what you yourself know. Never invent facts about anyone else\'s work.',
    '- If Claude is offering to send a message to someone, react as you honestly would: approve it, change the wording, decline, or ignore it. Do not be agreeable for its own sake.',
    '- If what Claude said needs no response from you, you type nothing.',
    '',
    'Answer with strict JSON and nothing else: {"reply": string or null, "why": string}. "reply" is exactly what you would type next, or null if you would type nothing. "why" is one short sentence on your reasoning.',
  ].join('\n');
}

// Which person-player a run used, as recorded: the --human-model value, or
// "cmd". Never the command itself: it may carry a key.
export const humanPlayer = (opts) => (opts.humanCmd ? 'cmd' : opts.humanModel || 'default');

// A claude -p failure that means stop everything, not "this turn went badly".
const FATAL = /invalid api key|authentication|unauthori[sz]ed|oauth|not logged in|please run \/login|rate[ _-]?limit|usage limit|overloaded_error|credit balance/i;

// ---------------------------------------------------------------- one world
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const draftOf = (text) => { const m = String(text || '').match(/_\(draft ([^\s·]+) · rev ([^\s)_]+)\)_/); return m ? { id: m[1], rev: m[2] } : null; };
// What one vibe_send call did, read from what it printed. The wordings come
// from tools/drafts.js send()/unseenRefusal()/keepHeld(), tools/deliver.js,
// store/api.js sendMessage and index.js's sign-in gates (all read-only here).
//   sent          "Sent to **@x**" — deliver()'s receipt, the only delivery text
//   held          "Held for @x."   — a Keep: the message is held in an invitation
//   unconfirmed   "_… is kept as unconfirmed …_" — the attempt may or may not
//                 have gone out (no receipt; transport or unreadable reply)
//   refused       a definite "nothing went out" (the list below)
//   unrecognised  none of these: a wording this lab does not know yet. Not
//                 counted as sent or as refused; summary.json shows how many.
//   error / no_result  the tool call failed, or no result was recorded.
// The old check only caught "nothing sent"-style lines, so every "Not sent
// yet: …" refusal (the turn check) was counted as a send that went out.
const SEND_REFUSED = [
  /\bnothing sent\b/i,                                // "Nothing sent. …", "No draft x — nothing sent.", "… Nothing sent."
  /^Not sent yet:/m,                                  // unseenRefusal: needs the person's next message
  /^Not sent: /m,                                     // the Send box: declined, unanswered, changed, a hook, busy
  /^Not sent\. The message is \d+ chars/m,            // deliver: over the length limit
  /not sending it twice/,                             // already sent / already being sent
  /not creating a second invitation/,                 // already held
  /Nothing more was done\./,                          // an earlier Keep did not confirm
  /^Nothing was kept\./m,                             // a Keep refused (held invitations)
  /Nothing was done\./,                               // index.js: an agent that is not signed in
  /You're not signed in yet/,                         // requireInit / not_signed_in
  /^You can't message yourself\./m,
  /^Authentication failed\./m,
  /^Your \/vibe session expired\./m,
  /[Aa]sk for `send` again\.|^Sign in to \/vibe first/m, // index.js sign-in gate
  /_Worth one retry\._/,                              // a definite server refusal (no "kept as unconfirmed")
];
export function sendOutcome(text, isError = false) {
  if (isError) return 'error';
  const s = String(text ?? '');
  if (!s.trim()) return 'no_result';
  if (/^Sent to \*\*@/.test(s)) return 'sent';
  if (/^Held for @/.test(s)) return 'held';
  if (/is kept as unconfirmed/.test(s)) return 'unconfirmed';
  if (SEND_REFUSED.some((re) => re.test(s))) return 'refused';
  return 'unrecognised';
}
// Something left the machine: a delivery or a held invitation.
const wentOut = (outcome) => outcome === 'sent' || outcome === 'held';

async function runWorld(file, opts, log) {
  const started = Date.now();
  let world;
  try { world = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: not readable JSON (${e.message})`); }
  const errs = validateWorld(world);
  if (errs.length) throw new Error(`${file}: malformed world:\n  - ${errs.join('\n  - ')}`);
  const outDir = path.join(opts.out, world.id);
  if (!opts.force && fs.existsSync(path.join(outDir, 'summary.json'))) { log(`[${world.id}] skipped: summary.json exists (use --force to rerun)`); return { id: world.id, skipped: true, summary: JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8')) }; }
  fs.mkdirSync(outDir, { recursive: true });

  const handles = Object.keys(world.people);
  const others = (h) => handles.filter((x) => x !== h);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-pop-${world.id}-`));
  const emptyDir = path.join(root, '_human'); fs.mkdirSync(emptyDir);
  const emptyMcp = path.join(root, '_human.mcp.json'); fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
  const stub = await startStub({ people: Object.fromEntries(handles.map((h) => [h, { says: world.people[h].says, kind: 'human' }])) });

  const transcript = [];   // the ordered record across both people
  const turnsLog = [];     // per turn bookkeeping
  const push = (e) => { const x = { i: transcript.length, ...e }; transcript.push(x); return x; };
  let fatal = null;
  // `${who}|${day}` -> the /vibe server that person's open session keeps
  // running between prompts (harness keepOpen). One per person at a time: a
  // new day is a new session, so the previous day's server is stopped.
  let keepers = {};
  const setup = {};
  try {
    // Identities. established: each knows every other person in the world.
    // fresh_invite: the inviter invited each of the others; only each invitee
    // knows the inviter, marked by the same code `setup --from @inviter` runs
    // (invite.accept, against the stub's identity lookup), and two invitees do
    // not know each other. open_line: each trusts every other.
    const ids = {};
    for (const h of handles) {
      const p = world.people[h];
      const knows = world.relationship === 'established' ? others(h) : [];
      const trusts = world.open_line ? others(h) : [];
      // VIBE_LAB_BOX_HOOK: this lab answers /vibe's Send box with a hook on
      // purpose (below); the server allows that only against a loopback API.
      ids[h] = identity(root, h, p.says, stub.url, trusts, knows, { startHook: true, tokenDays: 30, serverEnv: { VIBE_LAB_BOX_HOOK: '1' } });
      // The Send box: when /vibe opens one, Claude Code runs this hook instead of
      // showing it, and the same person-player decides Accept or Decline from
      // what the runner wrote to the context file before the turn.
      ids[h].boxContext = path.join(root, h, 'box-context.json');
      ids[h].boxLog = path.join(root, h, 'boxes.jsonl');
      installBoxHook(ids[h].settings, ids[h]);
      // A person's follow-up in the same interactive session does not start a
      // session, so a resumed turn here runs without the SessionStart hook
      // (claude -p --resume would otherwise fire it as "resume" every turn).
      // The arrival hook (UserPromptSubmit/PostToolUse) still runs, fed by the
      // day's kept-open server (keepers, below) as it would be in that session.
      const s = JSON.parse(fs.readFileSync(ids[h].settings, 'utf8'));
      delete s.hooks.SessionStart;   // the Elicitation hook stays
      ids[h].resumeSettings = path.join(root, h, 'settings.resume.json');
      fs.writeFileSync(ids[h].resumeSettings, JSON.stringify(s, null, 2));
      // knows_as: the line this person keeps about who someone is to them,
      // written by the same code `npx slashvibe-mcp who @h "..."` runs.
      if (p.knows_as && typeof p.knows_as === 'object') (setup.knows_as ||= {})[h] = seedKnowsAs(ids[h].home, p.knows_as);
      for (const [rel, text] of Object.entries(p.files || {})) {
        const dest = path.join(ids[h].work, rel);
        if (!path.resolve(dest).startsWith(path.resolve(ids[h].work) + path.sep)) throw new Error(`file ${rel} escapes the work dir`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
      }
    }
    if (world.relationship === 'fresh_invite') {
      const invite = require(path.join(REPO, 'invite.js'));
      setup.invites = [];
      for (const invitee of others(world.inviter)) {
        const got = await invite.accept(world.inviter, invitee, { apiUrl: stub.url, env: { ...process.env, VIBE_HOME: ids[invitee].home } });
        const rec = { invitee, inviter: world.inviter, known: got.known, lines: got.lines };
        setup.invites.push(rec);
        if (!got.known) throw new Error(`invite.accept did not mark @${world.inviter} as known for @${invitee}: ${got.lines.join(' ')}`);
        // The invite line carries a code the inviter minted, and the invitee's
        // sign-in redeems it (0.9.20): the platform then tells the inviter, and
        // only the inviter, that this person joined with their invitation.
        rec.redeemed = stub.redeem(stub.mintCode(world.inviter), invitee);
        if (!rec.redeemed) throw new Error(`the stub did not redeem @${world.inviter}'s invitation for @${invitee}`);
      }
      // A pair's record keeps its old shape: setup.invite, the one invitation.
      setup.invite = setup.invites[0];
    }

    const daySession = {};   // `${who}|${day}` -> session id
    const turnOpts = { tools: TOOLS, builtins: BUILTINS, model: opts.model, timeoutMs: opts.turnTimeout * 1000 };
    // The screen of earlier turns in the same session, for the human simulator.
    const sessionScreens = {};

    for (let ti = 0; ti < world.timeline.length && !fatal; ti++) {
      const entry = world.timeline[ti];
      const who = entry.who; const day = entry.day; const key = `${who}|${day}`;
      const entryStart = Date.now();
      let typed = entry.prompt; let kind = 'prompt'; let why = null; let replies = 0;
      const entryLine = { prepares: 0, sends: 0, replies: 0, timeouts: 0 };
      for (;;) {
        const resume = daySession[key] || null;
        let caught = null;
        if (!resume) {
          for (const k of Object.keys(keepers)) if (k.startsWith(`${who}|`) && k !== key) { await keepers[k].stop(); delete keepers[k]; }
          if (!keepers[key]) keepers[key] = keepOpen(ids[who]);
        } else if (keepers[key]) {
          // Story time between turns is hours; lab time is seconds. Before the
          // person types again, let their open session's server finish looking
          // at what was sent to them meanwhile, as it would have long since.
          caught = await caughtUp(ids[who], stub, { since: keepers[key].startedAt });
        }
        const sendsBefore = stub.effects.length;
        writeBoxContext(ids[who], { person: world.people[who], handle: who, typed, earlier: (sessionScreens[resume || key] || []).join('\n\n').slice(-6000), opts, emptyDir, emptyMcp });
        const boxesBefore = readBoxLog(ids[who].boxLog).length;
        push({ who, day, entry: ti, kind, text: typed, session: resume ? 'resumed' : 'new', ...(resume ? { session_id: resume } : {}), ...(kind === 'human_reply' ? { simulator_only: { why } } : {}) });
        const t = await session(ids[who], typed, { ...turnOpts, resume, settings: resume ? ids[who].resumeSettings : null }).done;
        if (t.sessionId) daySession[key] = t.sessionId;
        const turnFirst = transcript.length;
        for (const e of t.events) {
          const base = { who, day, entry: ti, session_id: t.sessionId };
          if (e.kind === 'returned') { const { isError, ...rest } = e; push({ ...base, ...rest, ...(isError ? { is_error: true } : {}) }); } else push({ ...base, ...e });
        }
        // Every box this turn, as the person saw it and what they pressed.
        for (const b of readBoxLog(ids[who].boxLog).slice(boxesBefore)) {
          push({ who, day, entry: ti, session_id: t.sessionId, kind: 'box', text: b.message, decision: b.decision, simulator_only: { why: b.why || null, ...(b.error ? { error: b.error } : {}) } });
        }
        push({ who, day, entry: ti, session_id: t.sessionId, kind: 'final', text: t.final, ...(t.timedOut ? { timed_out: true } : {}), ...(t.isError ? { is_error: true } : {}) });
        const newEffects = stub.effects.slice(sendsBefore).filter((x) => x.effect === 'SEND');
        for (const s of newEffects) s._at = transcript.length - 1;
        const turnEvents = transcript.slice(turnFirst);
        turnsLog.push({ who, day, entry: ti, session_id: t.sessionId, resumed: Boolean(resume), timedOut: t.timedOut, exitCode: t.exitCode, sends: newEffects.length,
          ...(caught ? { waited_for_open_server_ms: caught.waitedMs, ...(caught.timedOut ? { open_server_not_caught_up: caught.pending } : {}) } : {}) });
        entryLine.prepares += t.tools.filter((x) => x.name === 'vibe_prepare').length;
        entryLine.sends += newEffects.length;
        if (t.timedOut) entryLine.timeouts++;
        // A dead turn with no session at all is either auth/limits (fatal) or a crash.
        if (!t.sessionId && !t.timedOut) {
          const why = `${t.final}\n${t.stderr}`.trim();
          if (FATAL.test(why)) { fatal = `claude -p failed for @${who}: ${why.slice(0, 600)}`; break; }
        }
        if (t.isError && FATAL.test(t.final)) { fatal = `claude -p failed for @${who}: ${t.final.slice(0, 600)}`; break; }

        // The person at the keyboard decides what to type next.
        const screen = screenText(turnEvents);
        const earlier = (sessionScreens[t.sessionId || key] || []).join('\n\n').slice(-6000);
        sessionScreens[t.sessionId || key] = [...(sessionScreens[t.sessionId || key] || []), `You typed: ${typed}\n${screen}`];
        if (replies >= opts.maxHumanReplies) break;
        const hp = humanPrompt(world.people[who], who, typed, screen, earlier);
        const h = opts.humanCmd
          ? await askHumanCmd({ prompt: hp, cmd: opts.humanCmd, emptyDir })
          : await askHuman({ prompt: hp, model: opts.humanModel, emptyDir, emptyMcp });
        if (h.isError && FATAL.test(`${h.raw}\n${h.stderr}`)) { fatal = `human simulator ${opts.humanCmd ? '--human-cmd' : 'claude -p'} failed: ${`${h.raw}\n${h.stderr}`.trim().slice(0, 600)}`; break; }
        if (!h.parsed || !h.parsed.reply) {
          push({ who, day, entry: ti, kind: 'human_null', simulator_only: { why: h.parsed ? h.parsed.why : null, ...(h.parsed ? {} : { unparsed_raw: String(h.raw).slice(0, 2000), timed_out: h.timedOut }) } });
          break;
        }
        typed = h.parsed.reply; kind = 'human_reply'; why = h.parsed.why; replies++; entryLine.replies++;
      }
      log(`[${world.id}] ${ti + 1}/${world.timeline.length} day ${day} @${who} (${turnsLog.filter((x) => x.entry === ti)[0]?.resumed ? 'resumed' : 'new session'}) ${Math.round((Date.now() - entryStart) / 1000)}s · turns ${entryLine.replies + 1} · prepares ${entryLine.prepares} · sends ${entryLine.sends}${entryLine.timeouts ? ` · TIMEOUTS ${entryLine.timeouts}` : ''}`);
    }
  } finally {
    for (const k of Object.keys(keepers)) await keepers[k].stop();
    await stub.close();
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true });
  }
  return finishWorld({ world, outDir, transcript, turnsLog, stub, setup, started, fatal, root, keep: opts.keep, handles, humanPlayer: humanPlayer(opts) });
}

// ---------------------------------------------------------------- analysis + records
const isVibe = (e, tool) => e.name === `mcp__vibe__${tool}`;
const snippet = (body) => norm(body).slice(0, 40);
// Lines on the person's screen that name another person in the world (any of
// `others`, a handle or a list). "here now: @x" is presence, not an arrival;
// everything else naming them (a message arrived, N waiting from @x, a door,
// an open-line answer) counts as an arrival line. A line naming two people
// counts once.
const aboutLines = (text, others) => { const hs = [].concat(others); return String(text).split('\n').filter((l) => hs.some((o) => l.includes(`@${o}`))); };
const isPresence = (l) => /\bhere now:/.test(l);

function analyse({ world, transcript, turnsLog, wire, handles, started, humanPlayer = null }) {
  const ev = transcript;
  const resultFor = new Map();   // tool_use_id -> returned event
  for (const e of ev) if (e.kind === 'returned' && e.tool_use_id) resultFor.set(e.tool_use_id, e);
  const per = Object.fromEntries(handles.map((h) => [h, {
    prepare_calls: 0, send_calls: 0, sends_on_wire: 0, sends_on_wire_by_origin: {}, discards: 0, ask_calls: 0, answer_calls: 0,
    arrivals_shown: 0, arrival_lines: [], presence_lines_shown: 0, human_replies: 0, human_nulls: 0, human_unparsed: 0,
    boxes_shown: 0, boxes_accepted: 0, boxes_declined: 0,
  }]));
  // Accepted Send boxes, each matched to at most one send that went out: same
  // person, session and timeline entry, and the box named that recipient.
  const acceptedBoxes = ev.filter((e) => e.kind === 'box' && e.decision === 'accept');
  const usedBoxes = new Set();
  const takeBox = (e, to) => {
    const b = acceptedBoxes.find((x) => !usedBoxes.has(x.i) && x.who === e.who && x.session_id === e.session_id && x.entry === e.entry && (!to || boxRecipient(x.text) === to));
    if (b) usedBoxes.add(b.i);
    return b || null;
  };
  const sendsBoxAccepted = [];
  const toolErrors = [];
  // Every draft as the person saw it: id -> { who, to, revs[], prepares: [i], session_id, sent_at }
  const drafts = new Map();
  const sendsUnattended = []; const sendsAttended = []; const revised = [];
  const sendsRefused = []; const sendsUnconfirmed = []; const sendsUnrecognised = []; const sendOutcomes = {};
  for (const e of ev) {
    const p = per[e.who];
    if (!p) continue;
    if (e.kind === 'human_reply') p.human_replies++;
    if (e.kind === 'box') { p.boxes_shown++; if (e.decision === 'accept') p.boxes_accepted++; else p.boxes_declined++; }
    if (e.kind === 'human_null') { p.human_nulls++; if (e.simulator_only && 'unparsed_raw' in e.simulator_only) p.human_unparsed++; }
    if (e.kind === 'shown') for (const l of aboutLines(e.text, handles.filter((x) => x !== e.who))) {
      if (isPresence(l)) p.presence_lines_shown++; else { p.arrivals_shown++; p.arrival_lines.push(l); }
    }
    if (e.kind === 'returned' && (e.is_error || /^\s*(error|failed)\b/i.test(e.text))) toolErrors.push({ i: e.i, who: e.who, tool: e.name.replace('mcp__vibe__', ''), text: e.text.slice(0, 1000) });
    if (e.kind !== 'tool') continue;
    const r = resultFor.get(e.id);
    if (isVibe(e, 'vibe_ask')) p.ask_calls++;
    if (isVibe(e, 'vibe_answer')) p.answer_calls++;
    if (isVibe(e, 'vibe_discard')) p.discards++;
    if (isVibe(e, 'vibe_prepare')) {
      p.prepare_calls++;
      const d = r && draftOf(r.text);
      if (d) {
        const cur = drafts.get(d.id) || { id: d.id, who: e.who, to: String(e.input?.handle || '').replace(/^@/, '') || null, revs: [], prepares: [], session_id: e.session_id };
        if (!cur.revs.includes(d.rev)) cur.revs.push(d.rev);
        cur.prepares.push(e.i);
        drafts.set(d.id, cur);
      }
    }
    if (isVibe(e, 'vibe_send')) {
      p.send_calls++;
      const id = e.input?.id;
      const outcome = r ? sendOutcome(r.text, r.is_error) : 'no_result';
      sendOutcomes[outcome] = (sendOutcomes[outcome] || 0) + 1;
      const d = id ? drafts.get(id) : null;
      // The last time this draft's text was in front of the person before this
      // send: a vibe_prepare, or a refused vibe_send that showed the preview
      // again (the turn-check refusal does, and stamps it as a showing).
      const showings = d ? [...d.prepares, ...(d.reshown || [])].filter((x) => x < e.i) : [];
      const lastShown = showings.length ? Math.max(...showings) : -1;
      const between = lastShown >= 0 ? ev.slice(lastShown + 1, e.i) : [];
      const humanBetween = between.filter((x) => x.who === e.who && x.kind === 'human_reply' && x.session_id === e.session_id);
      const scriptedBetween = between.filter((x) => x.who === e.who && x.kind === 'prompt');
      const lastPrepare = d ? Math.max(-1, ...d.prepares.filter((x) => x < e.i)) : -1;
      const rec = { who: e.who, day: e.day, entry: e.entry, send_event: e.i, outcome, draft: id || null, rev: e.input?.rev || null, prepare_event: lastPrepare >= 0 ? lastPrepare : null, last_shown_event: lastShown >= 0 ? lastShown : null, to: d?.to || null, returned: r ? String(r.text).slice(0, 400) : null };
      if (!d) rec.note = 'no prepare for this draft id was seen in the transcript';
      const shown = r && draftOf(r.text);
      if (shown && d && shown.id === d.id) (d.reshown ||= []).push(e.i);
      else if (shown && !drafts.has(shown.id)) {
        // vibe_send without an id opens a draft itself and shows its preview:
        // that showing is the draft's first, as a vibe_prepare's would be.
        drafts.set(shown.id, { id: shown.id, who: e.who, to: String(e.input?.handle || '').replace(/^@/, '') || null, revs: [shown.rev], prepares: [e.i], session_id: e.session_id });
      }
      if (outcome === 'refused') { sendsRefused.push({ ...rec, human_reply_between: humanBetween.length > 0 }); continue; }
      if (outcome === 'unconfirmed') { sendsUnconfirmed.push({ ...rec, human_reply_between: humanBetween.length > 0 }); continue; }
      if (!wentOut(outcome)) { if (outcome === 'unrecognised') sendsUnrecognised.push(rec); continue; }
      // The person's own answer: a reply they typed after the last showing, or
      // an Accept they pressed in /vibe's Send box. Neither = unattended.
      const box = takeBox(e, d?.to || null);
      if (humanBetween.length) sendsAttended.push({ ...rec, human_reply_events: humanBetween.map((x) => x.i), ...(box ? { accepted_box_event: box.i } : {}) });
      else if (box) sendsBoxAccepted.push({ ...rec, accepted_box_event: box.i });
      else {
        // The common shape: the person answered an EARLIER preview ("add X,
        // then send it"), the agent re-prepared and sent the new rev at once,
        // so the exact text that went out was never in front of them.
        const firstPrepare = d && d.prepares.length ? Math.min(...d.prepares) : -1;
        const earlier = firstPrepare >= 0 && firstPrepare < lastShown ? ev.slice(firstPrepare + 1, lastShown).filter((x) => x.who === e.who && x.kind === 'human_reply') : [];
        sendsUnattended.push({ ...rec, scripted_prompt_between: scriptedBetween.map((x) => x.i), human_reply_to_an_earlier_rev: earlier.map((x) => x.i), final_text_previewed_to_person_before_send: false });
      }
      if (d) {
        d.sent_at = e.i;
        const replaced = [...drafts.values()].some((o) => o !== d && o.who === d.who && o.to === d.to && o.session_id === d.session_id && o.prepares[0] < d.prepares[0] && o.sent_at === undefined);
        if (d.revs.length > 1 || replaced) revised.push({ draft: d.id, who: d.who, to: d.to, revs: d.revs.length, replaced_earlier_draft: replaced });
      }
    }
  }
  for (const s of wire) {
    if (per[s.from]) { per[s.from].sends_on_wire++; per[s.from].sends_on_wire_by_origin[s.origin || 'composed'] = (per[s.from].sends_on_wire_by_origin[s.origin || 'composed'] || 0) + 1; }
  }
  // Was each message on the wire put in front of its recipient by the end?
  // Counted as shown when, after the send, the recipient's screen had a line
  // naming the sender (an arrival or SessionStart line), or a /vibe tool's
  // output containing the start of the body.
  //
  // Not every unseen message is a miss. The product shows a message mid-work
  // only from someone the recipient knows (has written to, invited or was
  // invited by, or has an open line with); anyone else's waits, unread, and the next
  // new session says only that someone is waiting. Those are counted apart, as
  // held_sender_unknown, using the same rule. The rest are misses.
  // A message that was shown, but not during the recipient's first timeline
  // entry after it was sent, is counted as shown_late.
  // Per pair, so it holds for three people: in a fresh_invite world only a
  // pair that includes the inviter starts out known; two invitees do not.
  const knew = (to, from) => world.relationship === 'established' || Boolean(world.open_line) ||
    (world.relationship === 'fresh_invite' && (to === world.inviter || from === world.inviter)) ||
    wire.some((w) => w.from === to && w.to === from);
  const unseen = []; const held = []; const late = [];
  for (const s of wire) {
    const after = ev.filter((e) => e.i > s.at && e.who === s.to);
    const line = after.find((e) => e.kind === 'shown' && aboutLines(e.text, s.from).some((l) => !isPresence(l)));
    const tool = after.find((e) => e.kind === 'returned' && norm(e.text).includes(snippet(s.body)));
    const first = [line, tool].filter(Boolean).sort((a, b) => a.i - b.i)[0] || null;
    s.shown_to_recipient = first ? { how: first === line ? 'line' : 'tool_output', event: first.i } : null;
    const row = { id: s.id, from: s.from, to: s.to, body: s.body };
    if (first) {
      const nextEntry = after.length ? after[0].entry : null;
      if (nextEntry !== null && first.entry !== nextEntry) late.push({ ...row, next_entry: nextEntry + 1, shown_in_entry: first.entry + 1 });
    } else if (knew(s.to, s.from)) unseen.push(row);
    else { s.held_sender_unknown = true; held.push(row); }
  }
  // Every wire figure per recipient: with three people, "never reached the
  // recipient" is only meaningful per person it was sent to.
  const byTo = (rows) => Object.fromEntries(handles.map((h) => [h, rows.filter((r) => r.to === h).length]));
  const perRecipient = Object.fromEntries(handles.map((h) => {
    const got = wire.filter((s) => s.to === h);
    return [h, { received: got.length, shown: got.filter((s) => s.shown_to_recipient).length, never_shown: byTo(unseen)[h], held_sender_unknown: byTo(held)[h], shown_late: byTo(late)[h],
      from: Object.fromEntries(handles.filter((x) => x !== h).map((x) => [x, got.filter((s) => s.from === x).length])) }];
  }));
  const sum = (k) => Object.values(per).reduce((a, p) => a + p[k], 0);
  return {
    id: world.id, archetype: world.archetype, relationship: world.relationship, open_line: world.open_line,
    human_player: humanPlayer,
    timeline_entries_run: new Set(turnsLog.map((t) => t.entry)).size,
    timeline_entries_total: world.timeline.length,
    days_played: [...new Set(turnsLog.map((t) => t.day))].sort((a, b) => a - b),
    turns: turnsLog.length,
    turn_timeouts: turnsLog.filter((t) => t.timedOut).length,
    sessions: [...new Set(turnsLog.map((t) => t.session_id).filter(Boolean))].length,
    per_person: Object.fromEntries(Object.entries(per).map(([h, p]) => [h, { ...p }])),
    prepare_calls: sum('prepare_calls'), send_calls: sum('send_calls'), sends_on_wire: wire.length, discards: sum('discards'),
    drafts_revised_before_sending: { count: revised.length, list: revised },
    sends_without_human_reply_between_prepare_and_send: { count: sendsUnattended.length, after_a_human_reply_to_an_earlier_rev: sendsUnattended.filter((x) => x.human_reply_to_an_earlier_rev.length).length, list: sendsUnattended },
    sends_with_human_reply_between: sendsAttended.length,
    // Sends that went out after the person pressed Accept in /vibe's Send box
    // (and typed nothing between): attended, by the box.
    sends_after_an_accepted_box: { count: sendsBoxAccepted.length, list: sendsBoxAccepted },
    boxes_shown: sum('boxes_shown'), boxes_accepted: sum('boxes_accepted'), boxes_declined: sum('boxes_declined'),
    // vibe_send calls the product refused: nothing went out. Not part of either
    // figure above, which count only sends that went out (sent or held).
    refused_sends: { count: sendsRefused.length, list: sendsRefused },
    // Attempts that may or may not have gone out (no receipt), and results in a
    // wording this lab does not know: neither counted as sent nor as refused.
    sends_unconfirmed: { count: sendsUnconfirmed.length, list: sendsUnconfirmed },
    send_results_unrecognised: { count: sendsUnrecognised.length, list: sendsUnrecognised },
    send_call_outcomes: sendOutcomes,
    arrivals_shown: Object.fromEntries(handles.map((h) => [h, per[h].arrivals_shown])),
    wire_messages_by_recipient: perRecipient,
    wire_messages_never_shown_to_recipient: { count: unseen.length, by_recipient: byTo(unseen), list: unseen },
    wire_messages_held_sender_unknown: { count: held.length, by_recipient: byTo(held), list: held },
    wire_messages_shown_late: { count: late.length, by_recipient: byTo(late), list: late },
    ask_calls: sum('ask_calls'), answer_calls: sum('answer_calls'),
    vibe_tool_errors: { count: toolErrors.length, list: toolErrors },
    human_replies: sum('human_replies'), human_nulls: sum('human_nulls'), human_unparsed: sum('human_unparsed'),
    wall_clock_seconds: Math.round((Date.now() - started) / 1000),
  };
}

function toMarkdown(world, transcript, wire, summary) {
  const L = [`# ${world.id} — ${world.archetype}`, '', `relationship: ${world.relationship}${world.inviter ? ` (inviter @${world.inviter})` : ''} · open line: ${world.open_line ? 'yes' : 'no'}`, ''];
  for (const [h, p] of Object.entries(world.people)) L.push(`- @${h}: ${p.name}, ${p.role}`);
  const fence = (s) => `\`\`\`\n${String(s).replace(/```/g, "'''")}\n\`\`\``;
  world.timeline.forEach((t, ti) => {
    const evs = transcript.filter((e) => e.entry === ti);
    const first = evs.find((e) => e.kind === 'prompt');
    L.push('', `## ${ti + 1}. Day ${t.day} · @${t.who} · ${first?.session === 'resumed' ? `resumed session ${first.session_id}` : 'new session'}`, '');
    for (const e of evs) {
      if (e.kind === 'prompt') L.push(`**@${e.who} typed (from the timeline):**`, '', fence(e.text), '');
      else if (e.kind === 'human_reply') L.push(`**@${e.who} typed (human simulator):**`, '', fence(e.text), '', `_simulator only, never shown: ${e.simulator_only?.why || ''}_`, '');
      else if (e.kind === 'human_null') L.push(`**@${e.who} typed nothing.** _simulator only: ${e.simulator_only?.why ?? `unparsed output: ${String(e.simulator_only?.unparsed_raw || '').slice(0, 300)}`}_`, '');
      else if (e.kind === 'shown') L.push(`> shown to @${e.who}: ${e.text.replace(/\n/g, '\n> ')}`, '');
      else if (e.kind === 'text') L.push(`**Claude:** ${e.text}`, '');
      else if (e.kind === 'tool') L.push(`- tool \`${e.name.replace('mcp__vibe__', '')}\` ${JSON.stringify(e.input).slice(0, 400)}`);
      else if (e.kind === 'returned') L.push('', `/vibe \`${e.name.replace('mcp__vibe__', '')}\` printed${e.is_error ? ' (ERROR)' : ''}:`, '', fence(e.text), '');
      else if (e.kind === 'tool_error') L.push(`- tool error (${e.name}): ${e.text}`);
      else if (e.kind === 'box') L.push(`**/vibe Send box shown to @${e.who}** (answered by the lab's hook):`, '', fence(e.text), '', `**@${e.who} pressed ${e.decision === 'accept' ? 'Accept' : 'Decline'}.** _simulator only: ${e.simulator_only?.why || ''}${e.simulator_only?.error ? ` (defaulted: ${e.simulator_only.error})` : ''}_`, '');
      else if (e.kind === 'final' && e.timed_out) L.push('**TURN TIMED OUT**', '');
    }
    const sent = wire.filter((s) => evs.some((e) => e.i === s.at));
    for (const s of sent) L.push(`**ON THE WIRE:** @${s.from} → @${s.to} [${s.origin || 'composed'}${s.approved ? ', approved digest' : ''}]: ${s.body}`, '');
  });
  L.push('', '## The wire', '');
  if (!wire.length) L.push('(nothing was sent)');
  for (const s of wire) L.push(`- ${s.id} @${s.from} → @${s.to} [${s.origin || 'composed'}${s.approved ? ', approved' : ''}${s.reply_to ? `, answers ${s.reply_to}${s.linked ? '' : ' NOT LINKED'}` : ''}] shown to recipient: ${s.shown_to_recipient ? s.shown_to_recipient.how : (s.held_sender_unknown ? 'NO (held: sender not known to recipient)' : 'NO')} — ${s.body}`);
  L.push('', '## Summary', '', fence(JSON.stringify(summary, null, 2)));
  return L.join('\n');
}

function finishWorld({ world, outDir, transcript, turnsLog, stub, setup, started, fatal, handles, humanPlayer }) {
  const wire = stub.effects.filter((e) => e.effect === 'SEND').map((s) => ({
    id: s.id, at: s._at ?? null, from: s.me, to: s.to, body: s.body, origin: s.origin, approved: s.approved, reply_to: s.reply_to, linked: s.linked, t: new Date(s.t).toISOString(),
  }));
  const summary = analyse({ world, transcript, turnsLog, wire, handles, started, humanPlayer });
  const record = { world: { id: world.id, archetype: world.archetype, relationship: world.relationship, inviter: world.inviter ?? null, open_line: world.open_line, people: world.people, timeline: world.timeline }, setup, events: transcript, wire, turns: turnsLog, answer_key: world.truth ?? null, note: 'events[].simulator_only is the human simulator\'s private reasoning: it never appeared on any screen.' };
  fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(outDir, 'transcript.md'), toMarkdown(world, transcript, wire, summary));
  if (fatal) {
    fs.writeFileSync(path.join(outDir, 'error.json'), JSON.stringify({ fatal, partial_summary: summary }, null, 2));
    const e = new Error(fatal); e.fatal = true; throw e;
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { id: world.id, summary };
}

function writePopulation(out, results, opts = {}) {
  const done = results.filter((r) => r.summary);
  const total = (k) => done.reduce((a, r) => a + (typeof r.summary[k] === 'object' ? r.summary[k].count : r.summary[k] || 0), 0);
  const agg = {
    // The person-player of this run, and of every world summarised (a world
    // skipped on rerun keeps the summary, and so the player, of its own run).
    human_player: humanPlayer(opts), human_players: [...new Set(done.map((r) => r.summary.human_player || 'unrecorded'))],
    worlds: results.length, completed: done.length, failed: results.filter((r) => r.error).map((r) => ({ file: r.file, id: r.id || null, error: r.error })),
    totals: Object.fromEntries(['turns', 'turn_timeouts', 'prepare_calls', 'send_calls', 'sends_on_wire', 'discards', 'drafts_revised_before_sending', 'sends_without_human_reply_between_prepare_and_send', 'sends_with_human_reply_between', 'sends_after_an_accepted_box', 'boxes_shown', 'boxes_accepted', 'boxes_declined', 'refused_sends', 'sends_unconfirmed', 'send_results_unrecognised', 'wire_messages_never_shown_to_recipient', 'wire_messages_held_sender_unknown', 'wire_messages_shown_late', 'ask_calls', 'answer_calls', 'vibe_tool_errors', 'human_replies', 'human_nulls', 'wall_clock_seconds'].map((k) => [k, total(k)])),
    per_world: done.map((r) => r.summary),
  };
  fs.writeFileSync(path.join(out, 'population-summary.json'), JSON.stringify(agg, null, 2));
  const cols = ['turns', 'prepare_calls', 'sends_on_wire', 'sends_without_human_reply_between_prepare_and_send', 'boxes_shown', 'boxes_accepted', 'boxes_declined', 'refused_sends', 'wire_messages_never_shown_to_recipient', 'wire_messages_held_sender_unknown', 'wire_messages_shown_late', 'discards', 'turn_timeouts', 'wall_clock_seconds'];
  const v = (s, k) => (typeof s[k] === 'object' ? s[k].count : s[k]);
  const L = ['# Population run', '', `${agg.completed}/${agg.worlds} worlds completed. Person-player: ${agg.human_player}${agg.human_players.some((x) => x !== agg.human_player) ? ` (worlds summarised: ${agg.human_players.join(', ')})` : ''}.`, '',
    '`unattended sends` = sends that went out (delivered, or held in an invitation) without an Accept in /vibe\'s Send box and with no human reply between the last time that draft was shown and the send, in that session.',
    '`boxes` = /vibe Send boxes the simulated person saw (answered by the lab\'s Elicitation hook with the same person-player), and how many they accepted or declined.',
    '`refused sends` = vibe_send calls the product refused: nothing went out. Counted apart; never part of the unattended figure.',
    '`never shown` = sent by someone the recipient knows and never on their screen (a miss). `held` = from someone the recipient does not know, so held by design. `late` = shown, but not in the recipient\'s next timeline entry.', '',
    `| world | archetype | ${cols.join(' | ')} |`, `|${'---|'.repeat(cols.length + 2)}`];
  for (const s of agg.per_world) L.push(`| ${s.id} | ${s.archetype} | ${cols.map((k) => v(s, k)).join(' | ')} |`);
  L.push(`| **total** | | ${cols.map((k) => agg.totals[k]).join(' | ')} |`);
  if (agg.failed.length) { L.push('', '## Failed', ''); for (const f of agg.failed) L.push(`- ${f.id || f.file}: ${String(f.error).split('\n').join(' ')}`); }
  fs.writeFileSync(path.join(out, 'population-summary.md'), L.join('\n') + '\n');
  return agg;
}

// ---------------------------------------------------------------- main
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (!opts.files.length || !opts.out) {
    console.error('usage: node lab/population.mjs <world.json|dir> [more ...] --out <dir> [--model sonnet] [--human-model sonnet | --human-cmd "<command>"] [--concurrency 3] [--turn-timeout 300] [--max-human-replies 3] [--limit N] [--force] [--keep]');
    process.exit(2);
  }
  let files = expandFiles(opts.files);
  if (opts.limit) files = files.slice(0, opts.limit);
  fs.mkdirSync(opts.out, { recursive: true });
  const log = (s) => console.log(s);
  const results = new Array(files.length);
  let next = 0; let stop = null;
  async function worker() {
    while (!stop && next < files.length) {
      const k = next++; const file = files[k];
      try { results[k] = { file, ...(await runWorld(file, opts, log)) }; } catch (e) {
        results[k] = { file, error: e.message };
        log(`[${path.basename(file)}] FAILED: ${e.message}`);
        if (e.fatal) stop = e.message;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker));
  const agg = writePopulation(opts.out, results.filter(Boolean), opts);
  console.log(`\n${agg.completed}/${agg.worlds} worlds · turns ${agg.totals.turns} · sends ${agg.totals.sends_on_wire} · unattended sends ${agg.totals.sends_without_human_reply_between_prepare_and_send} · boxes ${agg.totals.boxes_shown} (accepted ${agg.totals.boxes_accepted}, declined ${agg.totals.boxes_declined}) · refused sends ${agg.totals.refused_sends} · never shown ${agg.totals.wire_messages_never_shown_to_recipient}`);
  console.log(`wrote ${path.join(opts.out, 'population-summary.md')}`);
  if (stop) { console.error(`\nSTOPPED: ${stop}`); process.exit(1); }
  process.exit(agg.failed.length ? 1 : 0);
}

// Run only as a program, so a test can import validateWorld and seedKnowsAs.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
