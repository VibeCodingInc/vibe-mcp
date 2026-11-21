'use strict';
// The lab's population runner (lab/population.mjs): the pure pieces only.
// Nothing here starts a Claude Code session, a stub or a /vibe server: world
// validation, the vibe_send outcome classifier, the summary's send figures and
// the --human-cmd player (run against a tiny shell stub).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lab = () => import(path.join(ROOT, 'lab', 'population.mjs'));

const person = (name) => ({ name, role: 'engineer', says: `${name} work`, persona: 'plain' });
function world(days, extra = {}) {
  return {
    id: 'w-days', archetype: 'a week', relationship: 'established', open_line: false,
    people: { ada: person('Ada'), ben: person('Ben') },
    timeline: days.map((day, i) => ({ who: i % 2 ? 'ben' : 'ada', day, prompt: `day ${day}` })),
    ...extra,
  };
}

test('a five-day world is accepted, in day order', async () => {
  const { validateWorld } = await lab();
  assert.deepEqual(validateWorld(world([1, 1, 2, 3, 3, 4, 5])), []);
  assert.deepEqual(validateWorld(world([1, 7])), []);
});

test('day 8, day 0, a fractional day and a string day are rejected', async () => {
  const { validateWorld } = await lab();
  for (const bad of [8, 0, 2.5, '2']) {
    const errs = validateWorld(world([1, bad]));
    assert.ok(errs.some((e) => /timeline\[1\]\.day must be a whole number from 1 to 7/.test(e)), `${bad}: ${errs.join('\n')}`);
  }
});

test('a timeline out of day order is rejected (days are played in order)', async () => {
  const { validateWorld } = await lab();
  const errs = validateWorld(world([1, 3, 2]));
  assert.ok(errs.some((e) => /timeline\[2\]\.day is 2 after a day-3 entry/.test(e)), errs.join('\n'));
});

// ── --human-cmd ─────────────────────────────────────────────────────────────

test('--human-cmd is parsed; the player is recorded as "cmd", never the command', async () => {
  const { parseArgs, humanPlayer } = await lab();
  const o = parseArgs(['w.json', '--out', 'o', '--human-cmd', 'SECRET_KEY=abc my-player']);
  assert.equal(o.humanCmd, 'SECRET_KEY=abc my-player');
  assert.equal(humanPlayer(o), 'cmd');
  assert.equal(humanPlayer(parseArgs(['w.json', '--human-model', 'opus'])), 'opus');
  assert.equal(humanPlayer(parseArgs(['w.json'])), 'sonnet');
  assert.throws(() => parseArgs(['--human-cmd']), /needs a value/);
  assert.throws(() => parseArgs(['--human-cmd', '  ']), /needs a command/);
});

test('--human-cmd: the stub command\'s stdout is parsed like the built-in player\'s', async () => {
  const { askHumanCmd } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  try {
    const h = await askHumanCmd({ prompt: 'p', cmd: 'cat > /dev/null; echo \'{"reply":"ok","why":"t"}\'', emptyDir: dir, timeoutMs: 10000 });
    assert.equal(h.isError, false);
    assert.equal(h.timedOut, false);
    assert.deepEqual(h.parsed, { reply: 'ok', why: 't' });
    const nothing = await askHumanCmd({ prompt: 'p', cmd: 'echo \'{"reply":null,"why":"nothing to say"}\'', emptyDir: dir, timeoutMs: 10000 });
    assert.deepEqual(nothing.parsed, { reply: null, why: 'nothing to say' });
    const failed = await askHumanCmd({ prompt: 'p', cmd: 'echo \'{"reply":"ok","why":"t"}\'; exit 3', emptyDir: dir, timeoutMs: 10000 });
    assert.equal(failed.isError, true); assert.equal(failed.code, 3); assert.equal(failed.parsed, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--human-cmd gets the full prompt on stdin, runs in the empty dir, and sees no /vibe variables', async () => {
  const { askHumanCmd, humanPrompt, HUMAN_SYSTEM } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-rec-'));
  try {
    const prompt = humanPrompt(person('Ada'), 'ada', 'fix the limits', '[Claude]\ndone', '');
    const env = { PATH: process.env.PATH, VIBE_HOME: '/nope/.vibe', VIBE_API_URL: 'http://127.0.0.1:1', VIBE_AGENT_MINT_FILE: '/nope/mint', SLASHVIBE_TOKEN: 'x', KEEP_ME: 'yes' };
    const cmd = `cat > ${JSON.stringify(path.join(rec, 'stdin.txt'))}; pwd -P > ${JSON.stringify(path.join(rec, 'cwd.txt'))}; env > ${JSON.stringify(path.join(rec, 'env.txt'))}; echo '{"reply":"ok","why":"t"}'`;
    const h = await askHumanCmd({ prompt, cmd, emptyDir: dir, timeoutMs: 10000, env });
    assert.deepEqual(h.parsed, { reply: 'ok', why: 't' });
    assert.equal(fs.readFileSync(path.join(rec, 'stdin.txt'), 'utf8'), `${HUMAN_SYSTEM}\n\n${prompt}`);
    assert.equal(fs.readFileSync(path.join(rec, 'cwd.txt'), 'utf8').trim(), fs.realpathSync(dir));
    const seen = fs.readFileSync(path.join(rec, 'env.txt'), 'utf8');
    assert.ok(!/^(VIBE_|SLASHVIBE_)/m.test(seen), seen);
    assert.match(seen, /^KEEP_ME=yes$/m);
  } finally { for (const d of [dir, rec]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('--human-cmd: a command that outlives the timeout is killed with its children, and nothing is parsed', async () => {
  const { askHumanCmd } = await lab();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pop-human-'));
  try {
    const t0 = Date.now();
    const h = await askHumanCmd({ prompt: 'p', cmd: 'sleep 30 | cat; echo \'{"reply":"late","why":"t"}\'', emptyDir: dir, timeoutMs: 300 });
    assert.equal(h.timedOut, true); assert.equal(h.isError, true); assert.equal(h.parsed, null);
    assert.ok(Date.now() - t0 < 10000, 'the timeout did not end the command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
