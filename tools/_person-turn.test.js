'use strict';
// What counts as "the person prompted" (turns.js, hooks/arrival-hook.cjs).
//
// Seen live 2026-11-21: a subagent's hand-back arrived as a user-role message
// beginning "Another Claude session sent a message:" and the hook recorded a
// turn at that instant, which would let vibe_send go with no human between
// prepare and send. Claude Code runs UserPromptSubmit for hand-backs, messages
// from other sessions and scheduled tasks (hooks reference), and the input has
// no origin field, so the hook decides from the text, erring toward not
// counting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'arrival-hook.cjs');
const { personWrote, menuApproval } = require('../hooks/arrival-hook.cjs');

function run(input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-person-turn-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const turnsDir = path.join(root, 'turns'); const arrivals = path.join(root, 'arrivals');
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's1', cwd: project, ...input }),
    env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS || '', VIBE_TURNS_DIR: turnsDir, VIBE_ARRIVALS_DIR: arrivals, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  let recorded = false;
  try { recorded = fs.readdirSync(turnsDir).some((n) => /^[0-9a-f]{32}\.json$/.test(n)); } catch {}
  let nudged = false;
  try { nudged = /vibe_bump/.test(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || ''); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  return { recorded, nudged };
}
const prompt = (text) => run({ hook_event_name: 'UserPromptSubmit', prompt: text });

const NOT_TYPED = {
  'a subagent hand-back': 'Another Claude session sent a message:\n<agent-message from="mcp-held">\nDone. I am stuck on nothing.\n</agent-message>',
  'a bare agent message': '<agent-message from="x">I\'m stuck on the build</agent-message>',
  'a coordinator relay': 'The coordinator sent a message while you were working:\nResume the task.',
  'a task notification in a reminder': '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>b1</task-id><status>completed</status></task-notification>\n</system-reminder>',
  'a bare task notification': '<task-notification><status>completed</status></task-notification>',
  'a system notification line': '[SYSTEM NOTIFICATION - NOT USER INPUT] background task finished',
  'only system-reminder blocks': '<system-reminder>a</system-reminder>\n\n<system-reminder>b</system-reminder>',
  'leading whitespace before a wrapper': '   \n Another Claude session sent a message:\nhi',
  'empty': '   ',
};

for (const [what, text] of Object.entries(NOT_TYPED)) {
  test(`not a turn: ${what}`, () => {
    assert.equal(personWrote(text), false);
    assert.equal(prompt(text).recorded, false);
  });
}

test('another agent saying it is stuck does not trigger the stuck nudge', () => {
  assert.equal(prompt('Another Claude session sent a message:\n<agent-message from="x">I\'m stuck on the build</agent-message>').nudged, false);
  assert.equal(prompt('I\'m stuck on the build').nudged, true, 'the person saying it still does');
});

test('a prompt the person wrote counts, also when it quotes such text in the middle', () => {
  for (const text of [
    'send it',
    'yes',
    'the subagent said: Another Claude session sent a message: done. send it',
    'look at this <task-notification> thing in the log, then send it',
    'here is the reminder text [SYSTEM NOTIFICATION - NOT USER INPUT], ignore it. send it',
  ]) {
    assert.equal(personWrote(text), true, text);
    assert.equal(prompt(text).recorded, true, text);
  }
});

test('a prompt event without prompt text records nothing', () => {
  assert.equal(run({ hook_event_name: 'UserPromptSubmit' }).recorded, false);
});

// ── the question menu ───────────────────────────────────────────────────────
// A menu answer is never a general turn (the approval of one draft is tested
// in _send-needs-a-turn.test.js).
test('a question-menu answer records no turn, whatever it says', () => {
  const q = { question: 'Run the test suite now?', header: 'Run', options: [{ label: 'Yes', description: '' }, { label: 'Send', description: '' }], multiSelect: false };
  for (const label of ['Yes', 'Send']) {
    const input = { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] }, tool_response: { questions: [q], answers: { [q.question]: label }, annotations: {} } };
    assert.equal(menuApproval(input), null);
    assert.equal(run(input).recorded, false, label);
  }
});
