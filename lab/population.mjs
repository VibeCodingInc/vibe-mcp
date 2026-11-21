#!/usr/bin/env node
// Population runner: many fictional PAIRS of people, each pair doing two
// "days" of ordinary work in separate REAL Claude Code sessions (`claude -p`),
// with a simulated human at each keyboard deciding what to type next. Nothing
// is scripted to approve anything: whether a message is offered, what it says,
// whether the person sends it, and whether it arrives and is answered is all
// left to the product, the agent and the simulated person. Everything is
// recorded so a later judge can read it against each world's answer key.
//
//   node lab/population.mjs <world.json|dir> [more ...] --out <dir>
//        [--model sonnet] [--human-model sonnet] [--concurrency 3]
//        [--turn-timeout 300] [--max-human-replies 3] [--limit N]
//        [--force] [--keep]
//
// In plain words: each world file describes two fictional people (who they
// are, how they talk, the files in their project folder), whether they already
// know each other or one just invited the other, and a timeline of what each
// of them types on day 1 and day 2. The runner plays that timeline: a person's
// first prompt on a day opens a new Claude Code session, later prompts that day
// continue it. A continued session is what a person who left Claude Code open
// sees when they come back and type: that day's /vibe server is kept running
// between turns (harness keepOpen), so what arrived meanwhile is at their next
// prompt, as it would be; the SessionStart hook does not run again. After every turn a separate model, given only that person's
// persona and what appeared on their screen, decides what they would type next
// (or nothing). Per world it writes <out>/<id>/transcript.json, transcript.md
// and summary.json (prepares, sends, sends with no human reply between the
// preview and the send, messages that never reached the recipient's screen,
// tool errors, time), and <out>/population-summary.{json,md} across worlds.
// A world with a summary.json is skipped on rerun unless --force. A directory
// argument means every *.json in it.
//
// Same safety as rehearse.mjs: every world gets its own in-process stub on
// 127.0.0.1, every person their own VIBE_HOME, MCP config and scratch settings
// file. Nothing reaches production or ~/.claude/settings.json. The world's
// `truth` is never shown to any session or to the human simulator.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startStub } from './stub.mjs';
import { identity, session, keepOpen, caughtUp, REPO } from './harness.mjs';

const require = createRequire(import.meta.url);

// The person's session: their files, and /vibe. No Bash, no Agent, no web.
// vibe_send is always allowed: the product must enforce approval itself.
const BUILTINS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const TOOLS = [...BUILTINS, 'mcp__vibe__vibe_people', 'mcp__vibe__vibe_thread', 'mcp__vibe__vibe_prepare', 'mcp__vibe__vibe_discard', 'mcp__vibe__vibe_start',
  'mcp__vibe__vibe_ask', 'mcp__vibe__vibe_answer', 'mcp__vibe__vibe_visit', 'mcp__vibe__vibe_bump', 'mcp__vibe__vibe_send'];

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const o = { files: [], out: null, model: null, humanModel: 'sonnet', concurrency: 3, turnTimeout: 300, maxHumanReplies: 3, limit: 0, force: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--out') o.out = next();
    else if (a === '--model') o.model = next();
    else if (a === '--human-model') o.humanModel = next();
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
  else if (handles.length !== 2) errs.push(`people must name exactly two handles (got ${handles.length})`);
  for (const h of handles) {
    const p = people[h];
    if (!HANDLE.test(h)) errs.push(`people.${h}: handle must match ${HANDLE}`);
    if (!p || typeof p !== 'object') { errs.push(`people.${h} must be an object`); continue; }
    for (const k of ['name', 'role', 'says', 'persona']) if (!str(p[k])) errs.push(`people.${h}.${k} must be a non-empty string`);
    if (p.files !== undefined && (typeof p.files !== 'object' || p.files === null || Array.isArray(p.files))) errs.push(`people.${h}.files must be an object of "rel/path": "content"`);
    for (const [rel, content] of Object.entries(p.files || {})) {
      if (typeof content !== 'string') errs.push(`people.${h}.files["${rel}"] must be a string`);
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) errs.push(`people.${h}.files["${rel}"]: path must be relative and stay inside the work dir`);
    }
  }
  if (w.relationship === 'fresh_invite') {
    if (!handles.includes(w.inviter)) errs.push('fresh_invite needs inviter: one of the two handles');
  } else if (w.inviter !== undefined && !handles.includes(w.inviter)) errs.push('inviter, when given, must be one of the two handles');
  if (!Array.isArray(w.timeline) || w.timeline.length === 0) errs.push('timeline must be a non-empty array');
  else w.timeline.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errs.push(`timeline[${i}] must be an object`); return; }
    if (!handles.includes(t.who)) errs.push(`timeline[${i}].who must be one of ${handles.join(', ')}`);
    if (t.day !== 1 && t.day !== 2) errs.push(`timeline[${i}].day must be 1 or 2`);
    if (!str(t.prompt)) errs.push(`timeline[${i}].prompt must be a non-empty string`);
  });
  return errs;
}

// ---------------------------------------------------------------- human simulator
const HUMAN_SYSTEM = 'You play one specific person sitting at their own computer. You answer only with the JSON object asked for, nothing else.';

function screenText(evts) {
  const lines = [];
  for (const e of evts) {
    if (e.kind === 'shown') lines.push(`[a line appeared in your terminal]\n${e.text}`);
    else if (e.kind === 'text') lines.push(`[Claude]\n${e.text}`);
    else if (e.kind === 'returned') lines.push(`[the /vibe tool printed]\n${e.text}`);
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

function parseHuman(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tryParse = (x) => { try { const o = JSON.parse(x); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  let o = tryParse(s);
  if (!o) { const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a >= 0 && b > a) o = tryParse(s.slice(a, b + 1)); }
  if (!o || !('reply' in o)) return null;
  const reply = typeof o.reply === 'string' && o.reply.trim() ? o.reply.trim() : null;
  return { reply, why: typeof o.why === 'string' ? o.why : '' };
}

function askHuman({ prompt, model, emptyDir, emptyMcp, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    // No tools, no MCP, no hooks, no CLAUDE.md: --safe-mode plus an empty strict
    // MCP config, project/local settings only, from an empty directory.
    const args = ['-p', prompt, '--safe-mode', '--strict-mcp-config', '--mcp-config', emptyMcp, '--setting-sources', 'project,local', '--tools', '', '--system-prompt', HUMAN_SYSTEM, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { cwd: emptyDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = ''; let isError = false;
      try { const o = JSON.parse(out); result = o.result || ''; isError = Boolean(o.is_error); } catch { result = out; isError = true; }
      const parsed = isError ? null : parseHuman(result);
      resolve({ parsed, raw: result, isError, code, timedOut, stderr: err.slice(0, 2000) });
    });
  });
}

// A claude -p failure that means stop everything, not "this turn went badly".
const FATAL = /invalid api key|authentication|unauthori[sz]ed|oauth|not logged in|please run \/login|rate[ _-]?limit|usage limit|overloaded_error|credit balance/i;

// ---------------------------------------------------------------- one world
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const draftOf = (text) => { const m = String(text || '').match(/_\(draft ([^\s·]+) · rev ([^\s)_]+)\)_/); return m ? { id: m[1], rev: m[2] } : null; };
const sendRefused = (text) => /nothing sent|not sending|didn't send|nothing confirmed|already sent|already being sent/i.test(String(text || ''));

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
  const other = (h) => handles.find((x) => x !== h);
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
    // Identities. established: each knows the other. fresh_invite: only the
    // invitee knows the inviter, marked by the same code `setup --from @inviter`
    // runs (invite.accept, against the stub's identity lookup). open_line: each
    // trusts the other.
    const ids = {};
    for (const h of handles) {
      const p = world.people[h];
      const knows = world.relationship === 'established' ? [other(h)] : [];
      const trusts = world.open_line ? [other(h)] : [];
      ids[h] = identity(root, h, p.says, stub.url, trusts, knows, { startHook: true, tokenDays: 30 });
      // A person's follow-up in the same interactive session does not start a
      // session, so a resumed turn here runs without the SessionStart hook
      // (claude -p --resume would otherwise fire it as "resume" every turn).
      // The arrival hook (UserPromptSubmit/PostToolUse) still runs, fed by the
      // day's kept-open server (keepers, below) as it would be in that session.
      const s = JSON.parse(fs.readFileSync(ids[h].settings, 'utf8'));
      delete s.hooks.SessionStart;
      ids[h].resumeSettings = path.join(root, h, 'settings.resume.json');
      fs.writeFileSync(ids[h].resumeSettings, JSON.stringify(s, null, 2));
      for (const [rel, text] of Object.entries(p.files || {})) {
        const dest = path.join(ids[h].work, rel);
        if (!path.resolve(dest).startsWith(path.resolve(ids[h].work) + path.sep)) throw new Error(`file ${rel} escapes the work dir`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
      }
    }
    if (world.relationship === 'fresh_invite') {
      const invitee = other(world.inviter);
      const invite = require(path.join(REPO, 'invite.js'));
      const got = await invite.accept(world.inviter, invitee, { apiUrl: stub.url, env: { ...process.env, VIBE_HOME: ids[invitee].home } });
      setup.invite = { invitee, inviter: world.inviter, known: got.known, lines: got.lines };
      if (!got.known) throw new Error(`invite.accept did not mark @${world.inviter} as known for @${invitee}: ${got.lines.join(' ')}`);
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
        push({ who, day, entry: ti, kind, text: typed, session: resume ? 'resumed' : 'new', ...(resume ? { session_id: resume } : {}), ...(kind === 'human_reply' ? { simulator_only: { why } } : {}) });
        const t = await session(ids[who], typed, { ...turnOpts, resume, settings: resume ? ids[who].resumeSettings : null }).done;
        if (t.sessionId) daySession[key] = t.sessionId;
        const turnFirst = transcript.length;
        for (const e of t.events) {
          const base = { who, day, entry: ti, session_id: t.sessionId };
          if (e.kind === 'returned') { const { isError, ...rest } = e; push({ ...base, ...rest, ...(isError ? { is_error: true } : {}) }); } else push({ ...base, ...e });
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
        const h = await askHuman({ prompt: humanPrompt(world.people[who], who, typed, screen, earlier), model: opts.humanModel, emptyDir, emptyMcp });
        if (h.isError && FATAL.test(`${h.raw}\n${h.stderr}`)) { fatal = `human simulator claude -p failed: ${`${h.raw}\n${h.stderr}`.trim().slice(0, 600)}`; break; }
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
  return finishWorld({ world, outDir, transcript, turnsLog, stub, setup, started, fatal, root, keep: opts.keep, handles });
}

// ---------------------------------------------------------------- analysis + records
const isVibe = (e, tool) => e.name === `mcp__vibe__${tool}`;
const snippet = (body) => norm(body).slice(0, 40);
// Lines on the person's screen that name the other person. "here now: @x" is
// presence, not an arrival; everything else naming them (a message arrived,
// N waiting from @x, a door, an open-line answer) counts as an arrival line.
const aboutLines = (text, other) => String(text).split('\n').filter((l) => l.includes(`@${other}`));
const isPresence = (l) => /\bhere now:/.test(l);

function analyse({ world, transcript, turnsLog, wire, handles, started }) {
  const ev = transcript;
  const resultFor = new Map();   // tool_use_id -> returned event
  for (const e of ev) if (e.kind === 'returned' && e.tool_use_id) resultFor.set(e.tool_use_id, e);
  const per = Object.fromEntries(handles.map((h) => [h, {
    prepare_calls: 0, send_calls: 0, sends_on_wire: 0, sends_on_wire_by_origin: {}, discards: 0, ask_calls: 0, answer_calls: 0,
    arrivals_shown: 0, arrival_lines: [], presence_lines_shown: 0, human_replies: 0, human_nulls: 0, human_unparsed: 0,
  }]));
  const toolErrors = [];
  // Every draft as the person saw it: id -> { who, to, revs[], prepares: [i], session_id, sent_at }
  const drafts = new Map();
  const sendsUnattended = []; const sendsAttended = []; const revised = [];
  for (const e of ev) {
    const p = per[e.who];
    if (!p) continue;
    if (e.kind === 'human_reply') p.human_replies++;
    if (e.kind === 'human_null') { p.human_nulls++; if (e.simulator_only && 'unparsed_raw' in e.simulator_only) p.human_unparsed++; }
    if (e.kind === 'shown') for (const l of aboutLines(e.text, handles.find((x) => x !== e.who))) {
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
      const delivered = r ? !sendRefused(r.text) && !r.is_error : false;
      if (!delivered) continue;
      const d = id ? drafts.get(id) : null;
      const lastPrepare = d ? Math.max(...d.prepares.filter((x) => x < e.i)) : -1;
      const between = lastPrepare >= 0 ? ev.slice(lastPrepare + 1, e.i) : [];
      const humanBetween = between.filter((x) => x.who === e.who && x.kind === 'human_reply' && x.session_id === e.session_id);
      const scriptedBetween = between.filter((x) => x.who === e.who && x.kind === 'prompt');
      const rec = { who: e.who, day: e.day, entry: e.entry, send_event: e.i, draft: id || null, rev: e.input?.rev || null, prepare_event: lastPrepare >= 0 ? lastPrepare : null, to: d?.to || null, returned: r.text.slice(0, 400) };
      if (!d) rec.note = 'no prepare for this draft id was seen in the transcript';
      if (humanBetween.length) sendsAttended.push({ ...rec, human_reply_events: humanBetween.map((x) => x.i) });
      else {
        // The common shape: the person answered an EARLIER preview ("add X,
        // then send it"), the agent re-prepared and sent the new rev at once,
        // so the exact text that went out was never in front of them.
        const firstPrepare = d ? Math.min(...d.prepares) : -1;
        const earlier = firstPrepare >= 0 && firstPrepare < lastPrepare ? ev.slice(firstPrepare + 1, lastPrepare).filter((x) => x.who === e.who && x.kind === 'human_reply') : [];
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
  // only from someone the recipient knows (has written to, accepted an invite
  // from, or has an open line with); anyone else's waits, unread, and the next
  // new session says only that someone is waiting. Those are counted apart, as
  // held_sender_unknown, using the same rule. The rest are misses.
  // A message that was shown, but not during the recipient's first timeline
  // entry after it was sent, is counted as shown_late.
  const knew = (to, from) => world.relationship === 'established' || Boolean(world.open_line) ||
    (world.relationship === 'fresh_invite' && from === world.inviter) ||
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
  const sum = (k) => Object.values(per).reduce((a, p) => a + p[k], 0);
  return {
    id: world.id, archetype: world.archetype, relationship: world.relationship, open_line: world.open_line,
    timeline_entries_run: new Set(turnsLog.map((t) => t.entry)).size,
    timeline_entries_total: world.timeline.length,
    turns: turnsLog.length,
    turn_timeouts: turnsLog.filter((t) => t.timedOut).length,
    sessions: [...new Set(turnsLog.map((t) => t.session_id).filter(Boolean))].length,
    per_person: Object.fromEntries(Object.entries(per).map(([h, p]) => [h, { ...p }])),
    prepare_calls: sum('prepare_calls'), send_calls: sum('send_calls'), sends_on_wire: wire.length, discards: sum('discards'),
    drafts_revised_before_sending: { count: revised.length, list: revised },
    sends_without_human_reply_between_prepare_and_send: { count: sendsUnattended.length, after_a_human_reply_to_an_earlier_rev: sendsUnattended.filter((x) => x.human_reply_to_an_earlier_rev.length).length, list: sendsUnattended },
    sends_with_human_reply_between: sendsAttended.length,
    arrivals_shown: Object.fromEntries(handles.map((h) => [h, per[h].arrivals_shown])),
    wire_messages_never_shown_to_recipient: { count: unseen.length, list: unseen },
    wire_messages_held_sender_unknown: { count: held.length, list: held },
    wire_messages_shown_late: { count: late.length, list: late },
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

function finishWorld({ world, outDir, transcript, turnsLog, stub, setup, started, fatal, handles }) {
  const wire = stub.effects.filter((e) => e.effect === 'SEND').map((s) => ({
    id: s.id, at: s._at ?? null, from: s.me, to: s.to, body: s.body, origin: s.origin, approved: s.approved, reply_to: s.reply_to, linked: s.linked, t: new Date(s.t).toISOString(),
  }));
  const summary = analyse({ world, transcript, turnsLog, wire, handles, started });
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

function writePopulation(out, results) {
  const done = results.filter((r) => r.summary);
  const total = (k) => done.reduce((a, r) => a + (typeof r.summary[k] === 'object' ? r.summary[k].count : r.summary[k] || 0), 0);
  const agg = {
    worlds: results.length, completed: done.length, failed: results.filter((r) => r.error).map((r) => ({ file: r.file, id: r.id || null, error: r.error })),
    totals: Object.fromEntries(['turns', 'turn_timeouts', 'prepare_calls', 'send_calls', 'sends_on_wire', 'discards', 'drafts_revised_before_sending', 'sends_without_human_reply_between_prepare_and_send', 'sends_with_human_reply_between', 'wire_messages_never_shown_to_recipient', 'wire_messages_held_sender_unknown', 'wire_messages_shown_late', 'ask_calls', 'answer_calls', 'vibe_tool_errors', 'human_replies', 'human_nulls', 'wall_clock_seconds'].map((k) => [k, total(k)])),
    per_world: done.map((r) => r.summary),
  };
  fs.writeFileSync(path.join(out, 'population-summary.json'), JSON.stringify(agg, null, 2));
  const cols = ['turns', 'prepare_calls', 'sends_on_wire', 'sends_without_human_reply_between_prepare_and_send', 'wire_messages_never_shown_to_recipient', 'wire_messages_held_sender_unknown', 'wire_messages_shown_late', 'discards', 'turn_timeouts', 'wall_clock_seconds'];
  const v = (s, k) => (typeof s[k] === 'object' ? s[k].count : s[k]);
  const L = ['# Population run', '', `${agg.completed}/${agg.worlds} worlds completed.`, '',
    '`unattended sends` = sends with no human reply between the prepare and the send in that session.',
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
    console.error('usage: node lab/population.mjs <world.json|dir> [more ...] --out <dir> [--model sonnet] [--human-model sonnet] [--concurrency 3] [--turn-timeout 300] [--max-human-replies 3] [--limit N] [--force] [--keep]');
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
  const agg = writePopulation(opts.out, results.filter(Boolean));
  console.log(`\n${agg.completed}/${agg.worlds} worlds · turns ${agg.totals.turns} · sends ${agg.totals.sends_on_wire} · unattended sends ${agg.totals.sends_without_human_reply_between_prepare_and_send} · never shown ${agg.totals.wire_messages_never_shown_to_recipient}`);
  console.log(`wrote ${path.join(opts.out, 'population-summary.md')}`);
  if (stop) { console.error(`\nSTOPPED: ${stop}`); process.exit(1); }
  process.exit(agg.failed.length ? 1 : 0);
}

await main();
