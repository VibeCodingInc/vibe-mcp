/**
 * Reply linkage is EXPLICIT, verified, and never guessed (#254 contract).
 *
 * The server has always stored reply_to_id and served the quoted parent; no
 * client wrote or rendered it. Pass 3A demonstrated the cost live: with two
 * asks interleaved in one thread, the answer to one read as the answer to the
 * other. These tests pin the Terminal writer slice:
 *
 *   1. vibe_reply with an explicit reply_to sends options.replyTo and the
 *      receipt names BOTH the new message id and the reply target.
 *   2. An unknown reply_to is REFUSED with the candidate messages listed —
 *      nothing sends, and the newest message is never silently chosen.
 *   3. No reply_to = an ordinary unlinked message (replyTo null).
 *   4. The thread view exposes #ids beside messages, renders the compact
 *      quoted parent, and renders "unavailable" when the server could not
 *      serve the parent — never re-guessing content.
 *
 * Run: node --test tools/_reply-target.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reply-target-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada',
  authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');

function toolWith(name, stubs) {
  const originals = {};
  // The inbox tool now reads through getInboxResult (a failed read is not an
  // empty inbox); a test that stubs getInbox alone gets the same threads back.
  if (stubs.getInbox && !stubs.getInboxResult) {
    stubs = { ...stubs, getInboxResult: async (...a) => ({ ok: true, threads: await stubs.getInbox(...a) }) };
  }
  for (const [k, v] of Object.entries(stubs)) {
    originals[k] = store[k];
    store[k] = v;
  }
  const toolPath = require.resolve(`./${name}.js`);
  delete require.cache[toolPath];
  const tool = require(toolPath);
  return {
    run: (args = {}) => tool.handler(args),
    restore: () => {
      for (const [k, v] of Object.entries(originals)) store[k] = v;
      delete require.cache[toolPath];
    },
  };
}

const THREAD = [
  { id: 'msg_askA', from: 'stan', body: 'which db should the receipts use?', timestamp: Date.now() - 60000 },
  { id: 'msg_askB', from: 'stan', body: 'and separately: is the canary green?', timestamp: Date.now() - 30000 },
];

const QUIET = {
  getInbox: async () => [{ handle: 'stan', unread: 1, lastMessage: 'and separately…' }],
  getThread: async () => THREAD,
  markThreadRead: async () => {},
  sendTypingIndicator: async () => {},
  getActiveUsers: async () => [],
  getUnreadCount: async () => 0,
  formatTimeAgo: store.formatTimeAgo,
};

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('explicit reply_to writes the link and the receipt names both ids', async () => {
  const sent = [];
  const t = toolWith('reply', {
    ...QUIET,
    sendMessage: async (from, to, body, type, payload, options = {}) => {
      sent.push(options);
      return { id: 'msg_new1', body, storedLength: body.length, serverTimestamp: 'ts' };
    },
  });
  try {
    const res = await t.run({ message: 'postgres, and yes', to: 'stan', reply_to: 'msg_askA' });
    assert.equal(sent.length, 1, 'exactly one send');
    assert.equal(sent[0].replyTo, 'msg_askA', 'the EXISTING reply_to field is written');
    assert.match(res.display, /↩ replying to #msg_askA @stan/, 'quoted parent shown');
    assert.match(res.display, /msg_new1/, 'receipt names the new message id');
    assert.match(res.display, /replying to msg_askA/, 'receipt names the reply target');
  } finally {
    t.restore();
  }
});

test('an unknown target is refused with candidates — the newest is never silently chosen', async () => {
  const sent = [];
  const t = toolWith('reply', {
    ...QUIET,
    sendMessage: async (...a) => { sent.push(a); return { id: 'x' }; },
  });
  try {
    const res = await t.run({ message: 'yes', to: 'stan', reply_to: 'msg_nope' });
    assert.equal(sent.length, 0, 'nothing may send on an unresolved target');
    assert.match(res.display, /Which message are you answering\?/);
    assert.match(res.display, /#msg_askA/, 'candidate A listed');
    assert.match(res.display, /#msg_askB/, 'candidate B listed');
    assert.ok(!res.display.includes('✓ Replied'), 'no success claim');
  } finally {
    t.restore();
  }
});

test('no reply_to = ordinary unlinked message', async () => {
  const sent = [];
  const t = toolWith('reply', {
    ...QUIET,
    sendMessage: async (from, to, body, type, payload, options = {}) => {
      sent.push(options);
      return { id: 'msg_new2', body, storedLength: body.length };
    },
  });
  try {
    const res = await t.run({ message: 'on it', to: 'stan' });
    assert.equal(sent[0].replyTo, null, 'unlinked stays unlinked — no inferred target');
    assert.ok(!res.display.includes('↩'), 'no quoted parent invented');
  } finally {
    t.restore();
  }
});

test("the server's write-boundary refusal is shown as-is — no useless retry advice", async () => {
  const t = toolWith('reply', {
    ...QUIET,
    sendMessage: async () => ({
      error: 'invalid_reply_target',
      message: 'reply target not found in this conversation',
    }),
  });
  try {
    const res = await t.run({ message: 'x', to: 'stan', reply_to: 'msg_askA' });
    assert.match(res.display, /reply target not found in this conversation/);
    assert.ok(!/worth one retry/.test(res.display), 'retrying the same target cannot help');
  } finally {
    t.restore();
  }
});

test('the thread view exposes #ids, the quoted parent, and the unavailable state', async () => {
  const t = toolWith('inbox', {
    ...QUIET,
    getThread: async () => Object.assign([
      { id: 'msg_askA', from: 'stan', body: 'which db?', timestamp: Date.now() - 60000 },
      {
        id: 'msg_new1', from: 'ada', body: 'postgres', timestamp: Date.now() - 5000,
        reply_to: { id: 'msg_askA', from: 'stan', text: 'which db?' },
      },
      {
        id: 'msg_new2', from: 'ada', body: 'also — ping', timestamp: Date.now(),
        reply_to: { id: 'msg_gone', from: null, text: null },
      },
    ], { _threadId: 't1', _lastMessageId: 'msg_new2' }),
  });
  try {
    const res = await t.run({ handle: 'stan' });
    assert.match(res.display, /#msg_askA/, 'ids are visible beside messages');
    assert.match(res.display, /↩ replying to #msg_askA @stan: "which db\?"/, 'compact quoted parent');
    assert.match(res.display, /↩ replying to an unavailable message/, 'missing parent stays honest');
  } finally {
    t.restore();
  }
});
