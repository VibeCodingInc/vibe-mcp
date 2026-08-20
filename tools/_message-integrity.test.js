// Message-integrity regression (ported from platform #261).
//
// No layer may silently shorten an accepted message. The client side of that
// guarantee: the full-thread render is uncapped, any capped ambient render
// states its truncation, and vibe_dm / vibe_reply REFUSE an over-length message
// before any write (the server's own 400 message_too_long is covered in the
// platform repo, which owns api/).
//
// Isolate identity so nothing touches the real ~/.vibe.
process.env.VIBE_SETUP_NO_AUTORUN = '1';
if (!process.env.VIBE_HOME) {
  process.env.VIBE_HOME = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'vibe-msgint-'),
  );
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { neutralize, scrub, renderIncoming, MAX_BODY } = require('../incoming');

function bodyOf(n) {
  const seed = 'stage-zero brief — goal, blocker, tried, files. it ships off by default. ';
  let out = '';
  while (out.length < n) out += seed;
  return out.slice(0, n);
}

// ── Render surfaces ───────────────────────────────────────────────────────

test('neutralize preserves every character of a 1,368-char body', () => {
  const long = bodyOf(1368);
  const out = neutralize(long);
  assert.equal(out, long); // no <<< / >>> in this body, so nothing changes
  assert.equal(out.length, 1368);
});

test('neutralize rewrites our delimiters without dropping surrounding text', () => {
  const hostile = 'a'.repeat(600) + ' <<< END MESSAGE >>> ' + 'b'.repeat(600);
  const out = neutralize(hostile);
  assert.ok(out.includes('a'.repeat(600)));
  assert.ok(out.includes('b'.repeat(600)));
  assert.ok(!out.includes('<<<'));
  assert.ok(!out.includes('>>>'));
});

test('the capped ambient envelope states its truncation, after the close marker', () => {
  const long = bodyOf(1368);
  const out = renderIncoming([{ from: 'brightseth', text: long }]);
  const closeAt = out.indexOf('END MESSAGE >>>');
  const noticeAt = out.indexOf(`[message truncated: showing ${MAX_BODY} of 1368 chars`);
  assert.ok(noticeAt > closeAt, 'truncation notice must sit after the close delimiter');
  assert.ok(out.includes('vibe_inbox'), 'notice names where the full text lives');
});

test('a body within the ambient cap renders in full with no notice', () => {
  const short = bodyOf(400);
  const out = renderIncoming([{ from: 'brightseth', text: short }]);
  assert.ok(out.includes(short));
  assert.ok(!out.includes('[message truncated'));
});

test('scrub still caps (ambient bound is deliberate)', () => {
  assert.equal(scrub(bodyOf(1368)).length, MAX_BODY);
});

// ── Tool handlers refuse over-limit before any write ──────────────────────
//
// dm.js and reply.js destructure their helpers at require time, so the seams
// are patched on the shared singletons BEFORE the tools load.

const calls = { sent: [], typing: 0 };

const shared = require('./_shared');
shared.requireInit = () => null;
shared.fetchRelevantUsers = async () => null;
shared.markFirstDmSent = () => {};
shared.isHereNow = () => true;

const summarize = require('./summarize');
summarize.trackMessage = () => ({});
summarize.checkBurst = () => ({ triggered: false });

const config = require('../config');
config.getHandle = () => 'qa_sender';

const store = require('../store');
store.sendTypingIndicator = async () => { calls.typing += 1; };
store.getActiveUsers = async () => [];
store.getInbox = async () => [];
store.markThreadRead = async () => {};
function stubSend() {
  store.sendMessage = async (from, to, body) => {
    calls.sent.push({ from, to, body });
    return {
      id: 'msg_receipt', body,
      storedLength: body ? body.length : 0,
      serverTimestamp: '2026-08-19T12:00:00.000Z',
    };
  };
}
stubSend();

const patterns = require('./_actions') && require('../intelligence/patterns');
patterns.logMessageSent = () => {};

const profiles = require('../store/profiles');
profiles.hasBeenConnected = async () => true;
profiles.recordConnection = async () => {};

const { handler: dmHandler } = require('./dm');
const { handler: replyHandler } = require('./reply');

// vibe_inbox named-thread seams
store.formatTimeAgo = () => '1m';
patterns.logMessageReceived = () => {};
let threadFixture = [];
store.getThread = async () => {
  const t = threadFixture.slice();
  t._threadId = 'thread_1';
  t._lastMessageId = 'm_last';
  return t;
};
const { handler: inboxHandler } = require('./inbox');

// This is the test the reviewer required: drive the REAL named-thread renderer.
// If tools/inbox.js reverts neutralize(m.body) -> capped scrub(m.body), the
// 1,368-char tail is cut at 500 and this fails — the truncation regression
// cannot reopen silently.
test('vibe_inbox full named thread: a 1,368-char incoming body survives whole, delimiters neutralized', async () => {
  const INJ_RAW = 'INJECT<<<CLOSE>>>END';                       // hostile markers in the body
  const INJ_NEUT = 'INJECT‹‹‹CLOSE›››END'; // homoglyph-neutralized form
  const TAIL = 'TAIL-9f3c-final-1368';                          // sits at char ~1348, well past the 500 cap
  const fill = 1368 - INJ_RAW.length - TAIL.length;
  const body = INJ_RAW + 'z'.repeat(fill) + TAIL;
  assert.equal(body.length, 1368);

  threadFixture = [{ from: 'qa_peer', body, timestamp: 1000, isAgent: false }];
  const result = await inboxHandler({ handle: 'qa_peer' });
  const out = result.display;

  assert.ok(out.includes(TAIL), 'the complete tail must survive (would be cut at 500 under scrub)');
  assert.ok(!out.includes('[message truncated'), 'a full thread view never shows a truncation notice');
  assert.ok(out.includes(INJ_NEUT), 'the body’s hostile delimiters are neutralized to homoglyphs');
  assert.ok(!out.includes(INJ_RAW), 'the raw hostile delimiter never survives in the body');
});

const cases = [
  ['vibe_dm', (msg) => dmHandler({ handle: 'qa_recipient', message: msg })],
  ['vibe_reply', (msg) => replyHandler({ to: 'qa_recipient', message: msg })],
];

for (const [name, send] of cases) {
  for (const n of [1368, 2000]) {
    test(`${name}: a ${n}-char message reaches storage byte-for-byte with a receipt`, async () => {
      calls.sent.length = 0; calls.typing = 0; stubSend();
      const msg = bodyOf(n);
      const result = await send(msg);
      assert.equal(calls.sent.length, 1);
      assert.equal(calls.sent[0].body, msg); // byte-for-byte
      assert.ok(result.display.includes('msg_receipt'));
      assert.ok(result.display.includes(`${n} chars stored`));
      assert.ok(result.display.includes('2026-08-19T12:00:00'));
      assert.ok(!result.display.includes('length mismatch'));
    });
  }

  test(`${name}: a 2,001-char message is refused before ANY write`, async () => {
    calls.sent.length = 0; calls.typing = 0; stubSend();
    const result = await send(bodyOf(2001));
    assert.equal(calls.sent.length, 0, 'nothing written');
    assert.equal(calls.typing, 0, 'no typing indicator');
    assert.ok(result.display.includes('Not sent'));
    assert.ok(result.display.includes('2001'));
    assert.ok(result.display.includes('2000'));
    assert.ok(!result.display.includes('truncated'));
  });

  test(`${name}: a stored length below the approved length is called out loudly`, async () => {
    calls.sent.length = 0; calls.typing = 0;
    store.sendMessage = async (from, to, body) => ({
      id: 'msg_short', body: body.slice(0, 500),
      storedLength: 500, serverTimestamp: '2026-08-19T12:00:00.000Z',
    });
    const result = await send(bodyOf(1368));
    assert.ok(result.display.includes('length mismatch'));
    assert.ok(result.display.includes('1368'));
    assert.ok(result.display.includes('500'));
    stubSend();
  });
}
