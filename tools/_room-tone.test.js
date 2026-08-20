/**
 * ROOM TONE conformance for LLM-rendered output (docs/ROOM-TONE.md).
 *
 * The terminal is a design surface, and the thing that made it drift was that nothing
 * checked it: `getHeat` alone had grown NINE competing glyphs (🔥⚡🧠🐛🌙✨🔨●○) so the
 * same board looked different depending on what someone happened to be doing. Style rules
 * that live only in a doc decay; these assert them.
 *
 * The closed vocabulary is presence-only — 🟢 here · ○ idle · 💤 away · 🤖 agent — because
 * emoji is the only color a terminal reliably gives us and that budget belongs to the one
 * thing /vibe sells. Activity is words: shipping, debugging, deep focus.
 *
 * Run: node --test tools/_room-tone.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const TOOLS_DIR = __dirname;
const ALLOWED = ['🟢', '○', '💤', '🤖'];

/** Emoji/pictographs that appear in an output STRING (not in input comparisons). */
function outputGlyphs(src) {
  const found = new Set();
  // Only look at template literals and quoted strings that are being written to output:
  // `display +=`, `footer +=`, `text +=`, or a `display:` property.
  const outputLines = src
    .split('\n')
    .filter((l) => /(display|footer|text)\s*(\+=|:)/.test(l) || /^\s*['"`].*['"`],?\s*$/.test(l));
  for (const line of outputLines) {
    for (const ch of line) {
      if (/\p{Extended_Pictographic}/u.test(ch) && !ALLOWED.includes(ch)) found.add(ch);
    }
  }
  return [...found];
}

test('who.js output uses only the closed presence vocabulary', () => {
  const src = readFileSync(path.join(TOOLS_DIR, 'who.js'), 'utf8');
  assert.deepEqual(outputGlyphs(src), [],
    'activity must be words, not glyphs — see docs/ROOM-TONE.md');
});

test('who.js renders no markdown tables and no exclamation marks in system copy', () => {
  const src = readFileSync(path.join(TOOLS_DIR, 'who.js'), 'utf8');
  const outputText = src.split('\n').filter((l) => /(display|text)\s*(\+=|:)/.test(l)).join('\n');
  assert.ok(!/\|\s*-{3,}\s*\|/.test(outputText), 'markdown tables wrap badly in terminals');
  assert.ok(!/!`|!'|!"|!\\n/.test(outputText), 'system copy does not exclaim');
});

test('activity vocabulary is the agreed lowercase set', () => {
  const src = readFileSync(path.join(TOOLS_DIR, 'who.js'), 'utf8');
  const labels = [...src.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length > 0, 'expected activity labels');
  for (const l of labels) {
    assert.equal(l, l.toLowerCase(), `activity label "${l}" must be lowercase`);
  }
  // 'deep work' and 'deep focus' both existed — one vocabulary, not two.
  assert.ok(!labels.includes('deep work'), 'use "deep focus", not both spellings');
});

test('the presence board caps rows instead of printing a log', () => {
  const src = readFileSync(path.join(TOOLS_DIR, 'who.js'), 'utf8');
  assert.match(src, /slice\(0,\s*5\)/, 'cap the board at 5 rows');
  assert.match(src, /more here/, 'say how many were not shown');
});

test('the empty room invites rather than apologizes', () => {
  const src = readFileSync(path.join(TOOLS_DIR, 'who.js'), 'utf8');
  // The most important screen in the product: it is where most people land first.
  assert.match(src, /Quiet right now/, 'empty state should name the quiet plainly');
  assert.ok(!/only one here\.\.\./.test(src), 'no trailing ellipsis sigh');
});

test('no tool output smuggles in a decorative glyph', () => {
  // Sweep the whole shipped tool surface, not just who.js — this is what stops the zoo
  // from growing back one file at a time.
  const offenders = [];
  for (const f of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js') && !f.includes('.test.'))) {
    const glyphs = outputGlyphs(readFileSync(path.join(TOOLS_DIR, f), 'utf8'));
    if (glyphs.length) offenders.push(`${f}: ${glyphs.join(' ')}`);
  }
  // Known debt: older tools predate ROOM TONE. Keep this list SHRINKING, never growing —
  // a new entry means a new surface drifted.
  const KNOWN = new Set([
    'bye.js', 'corpse.js', 'dm.js', 'doctor.js', 'email.js', 'fable.js', 'feed.js',
    'game.js', 'help.js', 'inbox.js', 'init.js', 'intro.js', 'play.js', 'poem.js',
    'reply.js', 'ship.js', 'start.js', 'status.js', 'test.js', 'token.js', 'update.js',
    'admin-inbox.js', 'artifact-view.js', 'patterns.js', 'summarize.js', 'weave.js',
    '_actions.js', '_discovery.js', '_shared.js', '_work-context.js',
    'echo.js',   // feedback tool: 📝🎧📣🔒🎤🔇🦗⚠ — its own pass
  ]);
  const unexpected = offenders.filter((o) => !KNOWN.has(o.split(':')[0]));
  assert.deepEqual(unexpected, [],
    'new ROOM TONE violation — activity is words, glyphs are presence-only');
});
