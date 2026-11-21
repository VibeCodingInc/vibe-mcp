'use strict';
// A draft revision is sent only after the person has had a turn to see it.
//
// Found by simulation: the person typed "send it. add one line: …", and the
// agent made a new rev with the line and sent it in the same turn. The rev was
// bound to the digest, so nothing was "changed since the preview": the person
// simply never saw that preview. The rule now: vibe_send sends a rev only if a
// person-turn (a UserPromptSubmit, recorded by the real arrival hook) for this
// project came strictly after that rev was prepared (turns.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-'));
process.env.VIBE_HOME = HOME;
delete process.env.VIBE_TURNS_DIR;
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-project-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-other-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

// This server is inside Claude Code, as the host says in its handshake.
require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const TURNS = path.join(HOME, 'turns');
const ARRIVALS = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-turn-arrivals-'));

/** The real hook, as Claude Code runs it. */
function hook(event, { projectDir = PROJECT, cwd = projectDir, prompt = 'send it' } = {}) {
  const env = { PATH: process.env.PATH, VIBE_TURNS_DIR: TURNS, VIBE_ARRIVALS_DIR: ARRIVALS };
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  const input = { session_id: 'sess1', cwd, hook_event_name: event, ...(event === 'UserPromptSubmit' ? { prompt } : { tool_name: 'Bash' }) };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const personTurn = (o) => { const t = Date.now(); while (Date.now() === t) { /* next ms */ } hook('UserPromptSubmit', o); };

async function withWire(fn) {
  const sends = [];
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body, type, payload, opts) => { sends.push({ from, to, body, opts }); return { id: `msg_${sends.length}`, storedLength: body.length }; };
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const h = decodeURIComponent(String(url).split('/api/identity/')[1] || '');
    return { ok: true, status: 200, json: async () => ({ handle: h, kind: 'human' }) };
  };
  try { await fn(sends); } finally { Object.assign(store, orig); global.fetch = origFetch; }
}
const prepare = (o) => drafts.vibe_prepare.handler({ handle: 'linus', message: 'the lease fixed it', ...o });

test.after(() => { for (const d of [HOME, PROJECT, OTHER, ARRIVALS]) fs.rmSync(d, { recursive: true, force: true }); });

test('no turn ever recorded (no hook): it sends as before, and says the check was unavailable', async () => {
  assert.equal(turns.anyRecorded(), false);
  await withWire(async (sends) => {
    const p = await prepare();
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn_check, 'unavailable');
    assert.equal(sends.length, 1);
  });
});

test('the hook records a turn on UserPromptSubmit, and NOT after a tool call', () => {
  hook('PostToolUse');
  assert.equal(turns.anyRecorded(), false, 'a tool call is the agent\'s own turn');
  assert.equal(turns.lastTurn(PROJECT), null);
  const before = Date.now();
  hook('UserPromptSubmit', { prompt: 'send it. add one line: always use retry-after' });
  const at = turns.lastTurn(PROJECT);
  assert.ok(at >= before, 'a person prompted, and when');
  const t = turns.lastTurn(PROJECT);
  hook('PostToolUse');
  assert.equal(turns.lastTurn(PROJECT), t, 'a later tool call does not move it');
});

test('the turn record holds a time and nothing else: no prompt text, no path', () => {
  const files = fs.readdirSync(TURNS);
  assert.ok(files.length >= 1);
  for (const f of files) {
    assert.match(f, /^[0-9a-f]{32}\.json$/, 'named by a hash, not the path');
    const raw = fs.readFileSync(path.join(TURNS, f), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['at']);
    assert.doesNotMatch(raw, /send it|retry-after|vibe-turn-project|sess1/);
    assert.equal(fs.statSync(path.join(TURNS, f)).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(TURNS).mode & 0o777, 0o700);
});

test('prepare then send in the same turn: refused, nothing sent, and the preview comes back to show', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'send it, and it is not live yet' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(sends.length, 0, 'nothing reached the wire');
    assert.equal(r.data.sent, false);
    assert.equal(r.data.definite, true);
    assert.equal(r.data.reason, 'not_yet_seen');
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.match(r.display, /^Not sent yet: the person has not seen this draft\./);
    assert.match(r.display, /\*\*Message \(exact\):\*\*\nsend it, and it is not live yet/);
    assert.match(r.display, new RegExp(`rev ${p.data.draft.rev}`));
    assert.equal(r.data.draft.rev, p.data.draft.rev);
    assert.ok(!r.isError, 'a normal result, not an error');
    // The draft is still there to send once they have seen it.
    assert.equal(drafts.loadDrafts().find((d) => d.id === p.data.draft.id).status, 'previewed');
    personTurn();
    const again = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(again.data.sent, true);
    assert.equal(again.data.turn_check, 'passed');
    assert.equal(sends.length, 1);
  });
});

test('prepare, the person takes a turn, send: it goes', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'cloud owns placement' });
    personTurn();
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn_check, 'passed');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body, 'cloud owns placement');
  });
});

test('rev 1, a turn, then rev 2 with an added line and Send in the same turn: rev 2 is refused and shown; after a turn it goes', async () => {
  await withWire(async (sends) => {
    const p1 = await prepare({ message: 'cap retries at 60s' });
    personTurn({ prompt: 'send it. add one line: always use retry-after over your own 60s cap' });
    const p2 = await drafts.vibe_prepare.handler({ id: p1.data.draft.id, message: 'cap retries at 60s\nalways use retry-after over your own 60s cap' });
    assert.notEqual(p2.data.draft.rev, p1.data.draft.rev);
    const r = await drafts.vibe_send.handler({ id: p2.data.draft.id, rev: p2.data.draft.rev });
    assert.equal(sends.length, 0);
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'changed_since_seen');
    assert.match(r.display, /^Not sent yet: the text changed, and the person has not seen this version\. A changed draft must be shown again before it can be sent\./);
    assert.match(r.display, /cap retries at 60s\nalways use retry-after over your own 60s cap/);
    assert.equal(r.data.draft.rev, p2.data.draft.rev);
    assert.ok(r.data.actions.some((a) => a.tool === 'vibe_send' && a.args.rev === p2.data.draft.rev));
    // The old rev is not a way around it either.
    const old = await drafts.vibe_send.handler({ id: p1.data.draft.id, rev: p1.data.draft.rev });
    assert.match(old.display, /is not the version that rev names/);
    assert.ok(!old.display.includes(p2.data.draft.rev), 'the refusal names no rev');
    personTurn({ prompt: 'yes send' });
    const ok = await drafts.vibe_send.handler({ id: p2.data.draft.id, rev: p2.data.draft.rev });
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body, 'cap retries at 60s\nalways use retry-after over your own 60s cap');
  });
});

test('changing the text back to one already seen still needs a turn', async () => {
  await withWire(async (sends) => {
    const p1 = await prepare({ message: 'version A' });
    personTurn();
    await drafts.vibe_prepare.handler({ id: p1.data.draft.id, message: 'version B' });
    const back = await drafts.vibe_prepare.handler({ id: p1.data.draft.id, message: 'version A' });
    assert.equal(back.data.draft.rev, p1.data.draft.rev);
    const r = await drafts.vibe_send.handler({ id: p1.data.draft.id, rev: p1.data.draft.rev });
    assert.equal(r.data.sent, false);
    assert.equal(sends.length, 0);
  });
});

// Reversed 2026-11-21 (review of the unsent-reply reminder): showing unchanged
// text again used to keep the first showing's time, so a reminder that handed
// an old draft id to a new session let "send it" -> prepare{id} -> send go out
// in one turn, the text unseen in that session. Every showing now needs a turn.
test('showing the same text again resets it: a send in the same turn as the re-show is refused; after a turn it goes', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'unchanged words' });
    personTurn();
    const again = await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    assert.equal(again.data.draft.rev, p.data.draft.rev, 'same text, same rev');
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, false);
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(r.data.reason, 'shown_again');
    assert.equal(sends.length, 0);
    personTurn({ prompt: 'yes, send' });
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('the normal flow is unchanged: prepare, the person says send, send (no re-show) goes', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'normal flow' });
    personTurn({ prompt: 'send it' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('unsent-reply reminder: shown, "send it", reopen + send in that turn is refused; the next prompt lets it go', async () => {
  await withWire(async (sends) => {
    // Yesterday: prepared, shown, the person took a turn, then never chose.
    const p = await prepare({ message: 'yesterday\'s reply' });
    personTurn({ prompt: 'something else entirely' });
    // Today: the reminder line was shown at session start (unsent.js); the person answers it.
    const unsent = require('../unsent');
    const line = unsent.render({ id: p.data.draft.id, to: 'linus', at: Date.now() - 3 * 3600e3 }).line;
    assert.match(line, /want to see it again\?$/);
    personTurn({ prompt: 'send it' });
    const shown = await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: shown.data.draft.rev });
    assert.equal(sends.length, 0, 'nothing went out unseen');
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'shown_again');
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.match(r.display, /^Not sent yet: the draft was shown again just now; it can go after their next message\./);
    personTurn({ prompt: 'yes, send' });
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: shown.data.draft.rev });
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

// Review 2026-11-21 (scratchpad probe bypass.test.js): a reminder handed the
// draft id to a new session; vibe_send with a made-up rev answered with the
// current rev ("rev X → Y"), and a second vibe_send with it went out in the
// same turn, the text never shown. A refusal never names a rev now.
test('a wrong rev is refused without naming the current rev', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: "yesterday's reply" });
    personTurn({ prompt: 'something else' });
    personTurn({ prompt: 'send it' });
    const id = p.data.draft.id;
    const probe = await drafts.vibe_send.handler({ id, rev: 'deadbeef' });
    assert.ok(!probe.display.includes(p.data.draft.rev), `leaked the rev: ${probe.display}`);
    assert.ok(!/→/.test(probe.display));
    assert.match(probe.display, /Show it again with vibe_prepare \{id: "w[0-9a-f]+"\}/);
    assert.ok(!probe.data || !probe.data.draft, 'no draft data either');
    assert.equal(sends.length, 0);
  });
});

test('a turn recorded for a different project directory does not unlock this one', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'other project' });
    personTurn({ projectDir: OTHER });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, false);
    assert.equal(r.data.turn_check, 'needs_turn');
    assert.equal(sends.length, 0);
  });
});

test('the project is the project root: a cd into a subdirectory, or a symlinked path, is the same project', async () => {
  const sub = path.join(PROJECT, 'sub'); fs.mkdirSync(sub, { recursive: true });
  const link = path.join(OTHER, 'link-to-project'); fs.symlinkSync(PROJECT, link);
  await withWire(async (sends) => {
    const p = await prepare({ message: 'subdir' });
    personTurn({ projectDir: PROJECT, cwd: sub }); // Claude Code: input cwd follows the cd, CLAUDE_PROJECT_DIR does not
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, true);
    const q = await prepare({ message: 'symlink' });
    personTurn({ projectDir: link });
    assert.equal((await drafts.vibe_send.handler({ id: q.data.draft.id, rev: q.data.draft.rev })).data.sent, true);
    // Without CLAUDE_PROJECT_DIR the hook keys by its input cwd.
    const r = await prepare({ message: 'cwd only' });
    personTurn({ projectDir: null, cwd: PROJECT });
    assert.equal((await drafts.vibe_send.handler({ id: r.data.draft.id, rev: r.data.draft.rev })).data.sent, true);
    assert.equal(sends.length, 3);
  });
  assert.equal(turns.key(link), turns.key(PROJECT));
});

test('a turn in the same millisecond as the rev does not count as after it', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'same instant' });
    const d = drafts.loadDrafts().find((x) => x.id === p.data.draft.id);
    assert.ok(Number.isFinite(d.revAt));
    turns.record(PROJECT, d.revAt);
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, false);
    // The refusal showed the preview again, and that showing is stamped.
    const shown = drafts.loadDrafts().find((x) => x.id === p.data.draft.id).revAt;
    assert.ok(shown >= d.revAt);
    turns.record(PROJECT, shown);
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, false, 'same millisecond as the re-show: still not after it');
    const again = drafts.loadDrafts().find((x) => x.id === p.data.draft.id).revAt;
    turns.record(PROJECT, again + 1);
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('the person\'s own Send (vibe-draft / Buddy) is their turn: no recorded turn needed', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'from buddy' });
    const r = await drafts.sendByPerson({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(r.data.turn_check, 'by_person');
    assert.equal(sends.length, 1);
  });
  // ...and the tool cannot ask for that path: the handler takes args only.
  assert.equal(drafts.vibe_send.handler.length, 1);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'draft-cli.js'), 'utf8'), /moves\.sendByPerson\(\{ id, rev \}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), /sendByPerson/);
});

test('a host without the hook (not Claude Code) keeps today\'s behaviour', () => {
  assert.deepEqual(turns.judge(Date.now(), { host: 'codex' }), { check: 'unavailable', why: 'host_without_turn_hook' });
  assert.equal(turns.judge(Date.now() + 60_000, { host: 'claude-code' }).check, 'needs_turn');
});

test('the hook and the server compute the same key', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.match(src, /createHash\('sha256'\)\.update\(real, 'utf8'\)\.digest\('hex'\)\.slice\(0, 32\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'turns.js'), 'utf8'), /createHash\('sha256'\)\.update\(real, 'utf8'\)\.digest\('hex'\)\.slice\(0, 32\)/);
});

test('the agent is told, in the tool descriptions and the server instructions', () => {
  const line = 'A changed draft must be shown again before it can be sent';
  assert.ok(drafts.vibe_send.definition.description.includes(line));
  assert.ok(drafts.vibe_prepare.definition.description.includes(line));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').includes(line));
});

// ── a new session is a new screen (turns.js recordSessionStart) ─────────────
// Review 2026-11-21: the send must not depend on the agent choosing to show
// the draft again. A draft whose last showing came before the latest session
// start for the project is refused, whatever rev the agent holds.
const SESSION_HOOK = path.join(__dirname, '..', 'session-start-hook.cjs');
function sessionStart(source, { projectDir = PROJECT } = {}) {
  const t = Date.now(); while (Date.now() === t) { /* next ms */ }
  const env = { PATH: process.env.PATH, HOME, VIBE_HOME: HOME, VIBE_API_URL: 'http://127.0.0.1:9', VIBE_SESSION_START_DEADLINE_MS: '300', NODE_OPTIONS: process.env.NODE_OPTIONS || '', CLAUDE_PROJECT_DIR: projectDir };
  const r = spawnSync(process.execPath, [SESSION_HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: `s-${source}`, cwd: projectDir }), env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('a draft shown in an earlier session: the new session refuses it with the right rev; shown again, the next prompt sends it', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'shown yesterday' });
    personTurn({ prompt: 'not now' });
    sessionStart('startup');
    assert.ok(turns.lastSessionStart(PROJECT).at > drafts.loadDrafts().find((d) => d.id === p.data.draft.id).revAt);
    personTurn({ prompt: 'send it' });
    // The correct rev, however the agent came by it (the old preview, the file on disk).
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(sends.length, 0, 'not sent: never shown in this session');
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, 'shown_in_earlier_session');
    assert.match(r.display, /^Not sent yet: this draft was last shown in an earlier session, so the person has not seen it in this one\./);
    // Shown again with vibe_prepare; a send in that same turn still waits.
    const shown = await drafts.vibe_prepare.handler({ id: p.data.draft.id });
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: shown.data.draft.rev })).data.sent, false);
    personTurn({ prompt: 'yes, send it' });
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: shown.data.draft.rev });
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('resume, clear and fork are new screens too', async () => {
  for (const source of ['resume', 'clear', 'fork']) {
    await withWire(async (sends) => {
      const p = await prepare({ message: `before ${source}` });
      personTurn();
      sessionStart(source);
      personTurn({ prompt: 'send it' });
      const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
      assert.equal(r.data.reason, 'shown_in_earlier_session', source);
      assert.equal(sends.length, 0);
    });
  }
});

test('a compact in between does not force a re-show', async () => {
  await withWire(async (sends) => {
    const before = turns.lastSessionStart(PROJECT);
    const p = await prepare({ message: 'before compact' });
    sessionStart('compact');
    assert.deepEqual(turns.lastSessionStart(PROJECT), before, 'compact records nothing');
    personTurn({ prompt: 'send it' });
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(r.data.sent, true);
    assert.equal(sends.length, 1);
  });
});

test('a session start in another project does not touch this one; a host without the hook is unaffected', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'other project start' });
    sessionStart('startup', { projectDir: OTHER });
    personTurn();
    assert.equal((await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev })).data.sent, true);
    assert.equal(sends.length, 1);
  });
  sessionStart('startup');
  assert.deepEqual(turns.judge(0, { host: 'codex' }), { check: 'unavailable', why: 'host_without_turn_hook' });
});

test('a session-start record that cannot be parsed is dated by its file time', () => {
  const f = path.join(TURNS, `${turns.key(PROJECT)}.start.json`);
  fs.writeFileSync(f, 'not json');
  const st = turns.lastSessionStart(PROJECT);
  assert.ok(Number.isFinite(st.at) && Math.abs(st.at - fs.statSync(f).mtimeMs) < 1);
});

// ── a question-menu answer is never the person's Send ───────────────────────
// Reviews 2026-11-21 (third to fifth pass): a menu can be about anything, the
// agent opens it mid-run, and what it shows can differ from what is sent
// (invisible characters, rendered markdown, the reply target, layout). So an
// AskUserQuestion answer records nothing, however well it shows the draft.
function menuAnswer(label, options) {
  const q = { question: 'Send this to @linus?', header: 'Send', multiSelect: false, options };
  const t = Date.now(); while (Date.now() === t) { /* next ms */ }
  const env = { PATH: process.env.PATH, VIBE_TURNS_DIR: TURNS, VIBE_ARRIVALS_DIR: path.join(HOME, 'arrivals'), CLAUDE_PROJECT_DIR: PROJECT };
  const input = { session_id: 'sess1', cwd: PROJECT, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] }, tool_response: { questions: [q], answers: { [q.question]: label }, annotations: {} } };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('a menu answer of any kind, even "Send to @linus" with the full text as preview, does not send; a typed prompt then does', async () => {
  await withWire(async (sends) => {
    const p = await prepare({ message: 'the whole message, exactly' });
    const before = turns.lastTurn(PROJECT);
    const files = () => fs.readdirSync(TURNS).sort();
    const listed = files();
    for (const [label, options] of [
      ['Send to @linus', [{ label: 'Send to @linus', description: '', preview: 'the whole message, exactly' }, { label: 'Edit', description: '' }, { label: 'Cancel', description: '' }]],
      ['Send', [{ label: 'Send', description: '' }, { label: 'Cancel', description: '' }]],
      ['Yes', [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]],
      ['Cancel', [{ label: 'Send to @linus', description: '' }, { label: 'Cancel', description: '' }]],
    ]) {
      menuAnswer(label, options);
      assert.equal(turns.lastTurn(PROJECT), before, `${label}: no turn recorded`);
      assert.deepEqual(files(), listed, `${label}: nothing written`);
      const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
      assert.equal(r.data.sent, false, label);
      assert.equal(r.data.turn_check, 'needs_turn');
    }
    assert.equal(sends.length, 0);
    personTurn({ prompt: 'send it' });
    const ok = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev });
    assert.equal(ok.data.sent, true);
    assert.equal(sends.length, 1);
  });
});
