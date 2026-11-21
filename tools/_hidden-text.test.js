'use strict';
// What the person approves must show what it is (showable.js). Review
// 2026-11-21, fifth pass: tag characters can spell a whole hidden string after
// "Thanks!", and zero-width, format and filler characters can carry or
// disguise text, on the typed path as much as any other. vibe_prepare refuses
// them in a body, a link title and a link address, without echoing the text;
// ordinary emoji sequences still pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hidden-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';
delete process.env.VIBE_AGENT_HANDLE;
delete process.env.VIBE_AGENT_MINT_FILE;
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'ada', authMethod: 'github', authToken: jwt('ada') }));

const store = require('../store');
const drafts = require('./drafts');
const { hasHiddenCharacters } = require('../showable');
store.getActiveUsers = async () => [];
store.getActiveUsersResult = async () => ({ ok: true, users: [] });
// linus is someone ada knows: no lookup.
fs.writeFileSync(path.join(HOME, 'reach.json'), JSON.stringify({ quiet: false, muted: {}, known: { linus: 1 } }));

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tag = (s) => [...s].map((c) => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('');
const HIDDEN = {
  'tag characters (the reviewer\'s hidden string)': 'Thanks!' + tag('token=abc123'),
  'zero-width space': 'Than​ks',
  'soft hyphen': 'Than­ks',
  'variation selectors outside emoji': 'ok️︎️',
  'variation selector supplement': 'ok\u{E0100}',
  'LRM, RLM, ALM': 'pay 10‏-5؜',
  'bidi override': 'pay ‮yrros',
  'line separator': 'a b',
  'paragraph separator': 'a b',
  'Hangul fillers': 'hiㅤㅤ ᅟᅠﾠ',
  'invisible operators': 'x⁡⁢⁣⁤y',
  'word joiner': 'a⁠b',
  'byte order mark': '﻿hello',
  'a lone zero-width joiner': 'a‍b',
  'a digit and U+FE0F without the keycap': 'step 1\uFE0F next',
  'a letter as a keycap': 'a\uFE0F\u20E3',
  'a subdivision flag other than England, Scotland, Wales (Texas)': '\u{1F3F4}\u{E0075}\u{E0073}\u{E0074}\u{E0078}\u{E007F}',
  // Sixth pass: other default-ignorable, private-use, unassigned and lone surrogate code points.
  'combining grapheme joiner (U+034F)': 'pa\u034Fy',
  'Mongolian free variation selector': 'a\u180Bb',
  'Khmer inherent vowel': 'a\u17B4b',
  'private use': 'a\uE000b',
  'unassigned': 'a\u0378b',
  'lone high surrogate': 'a\uD800b',
  'lone low surrogate': 'a\uDC00b',
  'escape sequence': 'hi \u001b[8mtoken\u001b[0m',
  'carriage return': 'a\rb',
  'C1 control': 'a\u0085b',
};
const SHOWABLE = {
  'family emoji': 'see you there 👨‍👩‍👧',
  'flag': 'bonjour 🇫🇷',
  'heart with FE0F': 'thanks ❤️',
  'skin-tone modifier': 'nice 👍🏽',
  'skin tone inside a ZWJ sequence': 'pairing 🧑🏽‍💻',
  'rainbow flag (FE0F then ZWJ)': '🏳️‍🌈',
  'woman shrugging': '🤷‍♀️',
  'newlines and tabs': 'line one\n\tline two',
  'accents and other scripts': 'café, Привет, こんにちは',
  'keycap numbering': '1\uFE0F\u20E3 first 2\uFE0F\u20E3 second',
  'keycap # and *': '#\uFE0F\u20E3 and *\uFE0F\u20E3',
};

test('the rule: hidden characters are found; emoji sequences and ordinary text pass', () => {
  for (const [what, text] of Object.entries(HIDDEN)) assert.equal(hasHiddenCharacters(text), true, what);
  for (const [what, text] of Object.entries(SHOWABLE)) assert.equal(hasHiddenCharacters(text), false, what);
});

test('vibe_prepare refuses a body with hidden characters, and does not echo it', async () => {
  for (const [what, text] of Object.entries(HIDDEN)) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: text });
    assert.match(r.display, /^Not prepared: the message contains a character that does not show \(U\+[0-9A-F]{4,6} at character \d+\); remove it\. Nothing was sent\.$/, what);
    assert.ok(!r.display.includes(text), `${what}: not echoed`);
    assert.ok(!r.data, what);
  }
  assert.equal(drafts.loadDrafts().length, 0, 'nothing was stored');
});

test('vibe_prepare accepts emoji sequences', async () => {
  for (const [what, text] of Object.entries(SHOWABLE)) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: text });
    assert.ok(r.data && r.data.draft, `${what}: ${r.display}`);
    await drafts.vibe_discard.handler({ id: r.data.draft.id });
  }
});

test('an edit with hidden characters is refused, and the draft keeps its text', async () => {
  const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'clean text' });
  const r = await drafts.vibe_prepare.handler({ id: p.data.draft.id, message: 'clean text' + tag('x') });
  assert.match(r.display, /contains a character that does not show/);
  assert.equal(drafts.loadDrafts().find((d) => d.id === p.data.draft.id).body, 'clean text');
});

test('a link title or address with hidden characters is refused', async () => {
  for (const ref of [{ title: 'doc​', url: 'https://example.com/a' }, { title: 'doc', url: 'https://example.com/‮a' }]) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see the doc', refs: [ref] });
    assert.match(r.display, /^Not prepared: a link (title|address) contains a character that does not show \(U\+(200B|202E) at character \d+\); remove it\. Nothing was sent\.$/);
  }
});

test('more than two blank lines in a row is refused; two are fine', async () => {
  for (const text of ['top\n\n\n\nbottom', 'top\n \n\t\n  \nbottom', 'top' + '\n'.repeat(400) + 'bottom']) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: text });
    assert.equal(r.display, 'Not prepared: the message has more than two blank lines in a row; remove the extra ones. Nothing was sent.');
  }
  const ok = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'top\n\n\nbottom' });
  assert.ok(ok.data && ok.data.draft, ok.display);
  const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'short' });
  const e = await drafts.vibe_prepare.handler({ id: p.data.draft.id, message: 'short\n\n\n\n\nhidden below' });
  assert.match(e.display, /more than two blank lines/, 'an edit too');
});

test('a recipient handle must be canonical ASCII: a Cyrillic look-alike is refused, without echoing it', async () => {
  const lookalike = 's\u0430m';   // Cyrillic a
  const r = await drafts.vibe_prepare.handler({ handle: lookalike, message: 'hi' });
  assert.equal(r.display, "Not prepared: that is not a /vibe handle. Handles are plain letters a-z, digits, '_' and '-'. Nothing was sent.");
  assert.ok(!r.display.includes(lookalike));
  for (const h of ['linus', '@Linus', ' linus ', 'synth-stan', 'a_b']) {
    const ok = await drafts.vibe_prepare.handler({ handle: h, message: `hi ${h.trim()}` });
    assert.ok(!/not a \/vibe handle/.test(ok.display), `${h}: ${ok.display}`);
    if (ok.data && ok.data.draft) await drafts.vibe_discard.handler({ id: ok.data.draft.id });
  }
  const live = await drafts.vibe_prepare.handler({ handle: 'linus/claude', message: 'hi' });
  assert.match(live.display, /not a live session/, 'the live-session address keeps its own answer');
});

test('U+034F as a one-bit-per-letter carrier is refused', async () => {
  const bits = [...Buffer.from('sk-12')].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = ''; let k = 0;
  for (const c of 'Thanks for the review, the fix looks good to me and I will merge it after lunch') { out += c; if (k < bits.length) { if (bits[k] === '1') out += '\u034F'; k++; } }
  const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: out });
  assert.ok(!r.data, r.display);
});

test('two lone surrogates cannot be two drafts that read the same', async () => {
  for (const body of ['pay \uD800 now', 'pay \uDBFF now']) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: body });
    assert.ok(!r.data, 'refused');
  }
});

test('a link title is cut by code point, never into a lone surrogate', async () => {
  const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see doc', refs: [{ title: 'x'.repeat(79) + '\u{1F600}extra', url: 'https://example.com' }] });
  assert.ok(r.data, r.display);
  const title = r.data.draft.refs[0].title;
  assert.equal(Array.from(title).length, 80);
  assert.ok(title.endsWith('\u{1F600}'));
  assert.equal(hasHiddenCharacters(title), false);
  await drafts.vibe_discard.handler({ id: r.data.draft.id });
});

// Sixth pass: ordinary writing that uses joiners is not refused.
const flag = (t) => '\u{1F3F4}' + [...t].map((c) => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('') + '\u{E007F}';
test('Persian ZWNJ, Indic and Sinhala conjuncts, and the England, Scotland and Wales flags pass', async () => {
  const ok = {
    'Persian (ZWNJ between Arabic-script letters)': '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
    'Sinhala sri (ZWJ after virama)': '\u0DC1\u0DCA\u200D\u0DBB\u0DD3',
    'Hindi (ZWNJ after virama)': '\u0915\u094D\u200C\u0937',
    England: flag('gbeng'), Scotland: flag('gbsct'), Wales: flag('gbwls'),
  };
  for (const [what, text] of Object.entries(ok)) {
    assert.equal(hasHiddenCharacters(text), false, what);
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: `note: ${text}` });
    assert.ok(r.data, `${what}: ${r.display}`);
    await drafts.vibe_discard.handler({ id: r.data.draft.id });
  }
  for (const [what, text] of Object.entries({
    'ZWNJ between Latin letters': 'a\u200Cb',
    'ZWJ after a Latin letter': 'a\u200Db',
    'ZWJ after a virama, Latin letter next': '\u0915\u094D\u200Db',
    'ZWNJ after an Arabic letter, Latin next': '\u0645\u200Cb',
    'another tag sequence (Texas)': flag('ustx'),
    'a tag sequence without its cancel tag': flag('gbeng').slice(0, -2),
  })) assert.equal(hasHiddenCharacters(text), true, what);
});

test('CRLF is stored as LF; a lone CR is still refused', async () => {
  const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'line one\r\nline two' });
  assert.ok(r.data, r.display);
  assert.equal(r.data.draft.body, 'line one\nline two');
  await drafts.vibe_discard.handler({ id: r.data.draft.id });
  assert.ok(!(await drafts.vibe_prepare.handler({ handle: 'linus', message: 'line one\rline two' })).data);
});

test('the refusal names the first hidden character and its position, counting characters from 1', async () => {
  const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: '\u{1F600}abc def gh\u200Cij' });
  assert.equal(r.display, 'Not prepared: the message contains a character that does not show (U+200C at character 12); remove it. Nothing was sent.');
});

test('layout: blank-looking lines count as blank; link titles are one line; link addresses have no spaces; trailing spaces are trimmed', async () => {
  for (const ch of ['\u2800', '\u3000', '\u00A0', '\u2003']) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see below' + `\n${ch}`.repeat(40) + '\nhidden line' });
    assert.equal(r.display, 'Not prepared: the message has more than two blank lines in a row; remove the extra ones. Nothing was sent.', `U+${ch.codePointAt(0).toString(16)}`);
  }
  const t = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see doc', refs: [{ title: 'doc' + '\n'.repeat(60) + 'HIDDEN', url: 'https://example.com' }] });
  assert.equal(t.display, 'Not prepared: a link title has a line break; keep it to one line. Nothing was sent.');
  for (const url of ['https://example.com/' + '\n'.repeat(200) + 'HIDDEN', 'https://example.com/ ' + ' '.repeat(200) + 'HIDDEN', 'https://example.com/a\u3000b']) {
    const u = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see doc', refs: [{ title: 'doc', url }] });
    assert.equal(u.display, 'Not prepared: a link address contains a space or a line break; remove it. Nothing was sent.');
  }
  const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'line one   \nline two\t\t\n\nend  ' });
  assert.equal(p.data.draft.body, 'line one\nline two\n\nend');
  assert.ok(p.display.includes('**Message (exact):**\nline one\nline two\n\nend\n'), 'the preview is the stored text');
  await drafts.vibe_discard.handler({ id: p.data.draft.id });
});
