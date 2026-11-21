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
};

test('the rule: hidden characters are found; emoji sequences and ordinary text pass', () => {
  for (const [what, text] of Object.entries(HIDDEN)) assert.equal(hasHiddenCharacters(text), true, what);
  for (const [what, text] of Object.entries(SHOWABLE)) assert.equal(hasHiddenCharacters(text), false, what);
});

test('vibe_prepare refuses a body with hidden characters, and does not echo it', async () => {
  for (const [what, text] of Object.entries(HIDDEN)) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: text });
    assert.equal(r.display, 'Not prepared: the message contains characters that do not show; remove them. Nothing was sent.', what);
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
  assert.match(r.display, /contains characters that do not show/);
  assert.equal(drafts.loadDrafts().find((d) => d.id === p.data.draft.id).body, 'clean text');
});

test('a link title or address with hidden characters is refused', async () => {
  for (const ref of [{ title: 'doc​', url: 'https://example.com/a' }, { title: 'doc', url: 'https://example.com/‮a' }]) {
    const r = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'see the doc', refs: [ref] });
    assert.equal(r.display, 'Not prepared: a link title or address contains characters that do not show; remove them. Nothing was sent.');
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
