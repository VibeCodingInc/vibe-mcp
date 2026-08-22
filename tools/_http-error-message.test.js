/**
 * The server's human refusal message survives the REAL HTTP layer (#15 review).
 *
 * requestOnce kept parsed.error on non-2xx but dropped parsed.message, so a
 * remedy-carrying refusal like invalid_reply_target's "reply target not found
 * in this conversation" reached the tools as a generic "Failed to send
 * message." This test runs the ACTUAL boundary — a real local HTTP server
 * behind the real request() and the real store.sendMessage, with the reply
 * tool's sendMessage NOT stubbed — and asserts the server's words arrive
 * verbatim, with no useless retry advice appended.
 *
 * Run: node --test tools/_http-error-message.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-http-error-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

// The API base must point at the local server BEFORE store/api.js loads.
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.startsWith('/api/v2/messages')) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: 'invalid_reply_target',
        message: 'reply target not found in this conversation',
      }));
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, messages: [
        { id: 'msg_askA', from: 'stan', body: 'which db?', created_at: new Date().toISOString() },
      ] }));
    }
  });
});
const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let store;
before(async () => {
  await ready;
  process.env.VIBE_API_URL = `http://127.0.0.1:${server.address().port}`;
  store = require('../store/api.js');
});

after(() => {
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('store.sendMessage surfaces the server refusal message through the real HTTP layer', async () => {
  const result = await store.sendMessage('ada', 'stan', 'x', 'dm', null, { replyTo: 'msg_askA' });
  assert.equal(result.error, 'invalid_reply_target');
  assert.equal(result.message, 'reply target not found in this conversation',
    'parsed.message must survive requestOnce on non-2xx');
});

test('vibe_reply (REAL sendMessage, no stub) shows the server words with no retry advice', async () => {
  const toolPath = require.resolve('./reply.js');
  delete require.cache[toolPath];
  const reply = require(toolPath);
  const res = await reply.handler({ message: 'x', to: 'stan', reply_to: 'msg_askA' });
  assert.match(res.display, /reply target not found in this conversation/,
    'the server refusal reaches the human verbatim');
  assert.ok(!/worth one retry/.test(res.display), 'retrying the same target cannot help');
  assert.ok(!res.display.includes('✓ Replied'), 'no success claim');
});
