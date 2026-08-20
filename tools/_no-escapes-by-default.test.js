/**
 * Tool results are client-agnostic. Terminal escapes are opt-in.
 *
 * The ambient footer appended OSC 0 (window title) and OSC 1337 (iTerm badge) to EVERY
 * tool result, ungated. An MCP server cannot know what renders its output, so on every
 * client that is not an iTerm-like terminal those arrive as literal junk:
 *
 *     ]0;vibe: 2 online · @pastelle]1337;SetBadgeFormat=4peL
 *
 * The comment above the generator claimed the sequences were "invisible in the
 * transcript". They were visible on every single vibe tool call across a full working
 * session in Claude Code — the claim is what stopped anyone from looking, which makes it
 * costlier than the bug. Canon law 2: never claim a state you have not verified.
 *
 * Filed as #157 by a second session that hit it independently.
 *
 * The fix is not TTY detection. `process.stdout` is the MCP protocol channel, not the
 * user's screen, so isTTY answers a question nobody asked. The only honest position is
 * that the server does not know — so it stays quiet unless told otherwise.
 *
 * Run: node --test tools/_no-escapes-by-default.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
/** Source with comments stripped — the fix is documented in prose that mentions escapes. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the escape block is gated, not emitted unconditionally', () => {
  assert.match(CODE, /const escapes = TERM_ESCAPES/,
    'escapes must be behind the opt-in flag');
  assert.ok(!/const escapes =\s*\n?\s*getTerminalTitle\(/.test(CODE),
    'escapes must not be built unconditionally');
});

test('the flag defaults to OFF', () => {
  // An opt-OUT would leave every existing client emitting junk until they discovered a
  // variable they have no reason to know exists.
  const m = CODE.match(/const TERM_ESCAPES = ([^\n]+)/);
  assert.ok(m, 'TERM_ESCAPES must be defined');
  assert.match(m[1], /process\.env\.VIBE_TERM_ESCAPES/,
    'the flag reads an explicit env var');
  assert.ok(!/!==/.test(m[1]),
    'a `!== "0"` style test would default ON — this must default OFF');
});

test('no raw OSC sequence is emitted outside the generators', () => {
  // The generators may contain them; nothing else may. Catches a well-meaning "just add
  // the title back" edit elsewhere in the file.
  const withoutGenerators = CODE
    .replace(/function getTerminalTitle[\s\S]*?\n}/, '')
    .replace(/function getBadgeSequence[\s\S]*?\n}/, '');
  assert.ok(!/\\x1b\]/.test(withoutGenerators),
    'raw OSC escape found outside getTerminalTitle/getBadgeSequence');
});

test('the source records that the escapes ARE visible', () => {
  // Not "the false sentence is gone" — the fix QUOTES that sentence deliberately, as the
  // record of why this survived review, and a guard that cannot tell a quotation from a
  // claim would force deleting exactly the history worth keeping.
  //
  // So assert the corrected understanding is present instead. Someone who reads this file
  // before re-enabling the escapes should meet the evidence, not just the flag.
  assert.match(SRC, /visible/i);
  assert.match(SRC, /cannot know what renders its output/i,
    'the reason must be stated: an MCP server does not know its client surface');
});
