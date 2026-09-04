/**
 * A failed inbox read is not an empty inbox.
 *
 * Routing corpus R02 (2026-09-04, fixture tool_failure_inbox_unavailable):
 * with the threads endpoint answering 500, vibe_inbox said "no messages yet"
 * and every host — Claude Code and Codex, 6/6 runs — told the person
 * "you're caught up". The tool had flattened "nobody answered" into [].
 * vibe_start was already moved to getInboxResult for the same review P1;
 * this pins vibe_inbox to the same honesty: unread is UNKNOWN, not zero.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-inbox-fail-'));
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
  for (const [k, v] of Object.entries(stubs)) { originals[k] = store[k]; store[k] = v; }
  const toolPath = require.resolve(`./${name}.js`);
  delete require.cache[toolPath];
  const tool = require(toolPath);
  return {
    run: (args = {}) => tool.handler(args),
    restore: () => { for (const [k, v] of Object.entries(originals)) store[k] = v; delete require.cache[toolPath]; },
  };
}
const QUIET = {
  getUnreadCount: async () => 0,
  getRawInbox: async () => [],
  getThread: async () => [],
  markThreadRead: async () => {},
  getActiveUsers: async () => [],
  heartbeat: async () => ({ ok: true }),
};
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('vibe_inbox: a failed read says "could not check", never "no messages yet"', async () => {
  const h = toolWith('inbox', {
    ...QUIET,
    getInboxResult: async () => ({ ok: false, threads: [], error: 'transport_failed', message: '500' }),
    getInbox: async () => [],
  });
  try {
    const res = await h.run({});
    assert.match(res.display, /could not check your inbox/);
    assert.match(res.display, /unknown, not zero/);
    assert.doesNotMatch(res.display, /no messages yet|caught up/i);
  } finally { h.restore(); }
});

test('vibe_inbox: a real empty inbox still reads as empty', async () => {
  const h = toolWith('inbox', {
    ...QUIET,
    getInboxResult: async () => ({ ok: true, threads: [] }),
    getInbox: async () => [],
  });
  try {
    const res = await h.run({});
    assert.doesNotMatch(res.display, /could not check/);
  } finally { h.restore(); }
});
