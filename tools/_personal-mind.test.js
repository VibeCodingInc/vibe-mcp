const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mind-'));
process.env.VIBE_HOME = HOME;
const mindDir = path.join(HOME, 'mind');
fs.mkdirSync(mindDir, { recursive: true, mode: 0o700 });
const tokenFile = path.join(mindDir, 'runtime-token');
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const mind = require('../personal-mind');
const mindTool = require('./mind');
const toolPrivacy = require('../tool-privacy');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function installToken(mode = 0o600) {
  fs.writeFileSync(tokenFile, TOKEN, { mode });
  fs.chmodSync(tokenFile, mode);
}

function jsonResponse(value) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    headers: { get: (name) => name === 'content-length' ? String(body.length) : null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

function statusResponse(status, value = {}) {
  const response = jsonResponse(value);
  return { ...response, ok: status >= 200 && status < 300, status };
}

test('capability exists only as a regular private file', () => {
  installToken(0o644);
  assert.equal(mind.isAvailable(), false);
  fs.chmodSync(tokenFile, 0o600);
  assert.equal(mind.isAvailable(), true);
});

test('one fixed Tailnet origin is structurally outside Platform', () => {
  assert.equal(mind.MIND_ORIGIN, 'http://100.121.205.111:7788');
  assert.ok(!mind.MIND_ORIGIN.includes('slashvibe.dev'));
});

test('ask sends only eight visible messages under 2000 bytes and the exact draft', async () => {
  installToken();
  const calls = [];
  const draft = 'Should this launch now, or wait until the quieter architecture is finished?';
  const recentMessages = Array.from({ length: 10 }, (_, i) => ({
    from: `person${i}`,
    text: i === 9 ? 'é'.repeat(2_000) : `visible message ${i}`,
  }));
  const fakeFetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse(url.endsWith('/prime') ? { ok: true } : {
      silence: false,
      facet: 'A source-backed rotation.',
      source: '/private/note.md',
    });
  };

  const result = await mind.ask({ handle: '@friend', draft, recentMessages }, fakeFetch);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), [
    `${mind.MIND_ORIGIN}/prime`,
    `${mind.MIND_ORIGIN}/facet`,
  ]);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['context', 'handle']);
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['draft', 'handle']);
  assert.equal(calls[1].body.draft, draft);
  assert.ok(Buffer.byteLength(calls[0].body.context, 'utf8') <= mind.MAX_CONTEXT_BYTES);
  assert.ok(!calls[0].body.context.includes('person0:'));
  assert.ok(!calls[0].body.context.includes('person1:'));
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(result.facet.facet, 'A source-backed rotation.');
});

test('over-bound active drafts never leave the process', async () => {
  installToken();
  let calls = 0;
  const result = await mind.ask({
    handle: 'friend',
    draft: 'é'.repeat(2_001),
    recentMessages: [],
  }, async () => { calls += 1; return jsonResponse({}); });
  assert.equal(result.error, 'draft_too_large');
  assert.equal(calls, 0);
});

test('a refused credential is unavailable, never articulated silence', async () => {
  installToken();
  const result = await mind.ask({
    handle: 'friend',
    draft: 'Should this decision use the old frame or the new one?',
    recentMessages: [],
  }, async () => statusResponse(401));
  assert.equal(result.error, 'unavailable');
  assert.equal(result.silence, undefined);
});

test('an unsourced or empty candidate renders as silence', async () => {
  const originalAsk = mind.ask;
  mind.ask = async () => ({ facet: { silence: false } });
  try {
    const unsourced = await mindTool.handler({
      handle: 'friend',
      draft: 'Should this decision use the old frame or the new one?',
    });
    assert.match(unsourced.display, /stayed quiet/);
    assert.ok(!unsourced.display.includes('from your private sources'));
  } finally {
    mind.ask = originalAsk;
  }
});

test('direct send tools do not import or invoke Personal Mind', () => {
  for (const file of ['dm.js', 'reply.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!source.includes('personal-mind'));
    assert.ok(!source.includes('vibe_mind'));
  }
});

test('Mind calls behaviorally bypass prompt retention and the presence footer', () => {
  const args = {
    _prompt: 'private unsent thought',
    handle: 'friend',
    draft: 'Should this remain private?',
  };
  let inferenceCalls = 0;
  const retained = toolPrivacy.retainedPrompt('vibe_mind', args, () => {
    inferenceCalls += 1;
    return 'derived private thought';
  });
  assert.equal(retained, null);
  assert.equal(inferenceCalls, 0);
  assert.equal(toolPrivacy.shouldAppendAmbientFooter('vibe_mind', []), false);
});
