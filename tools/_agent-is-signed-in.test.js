'use strict';
// The agent exemption (no Send box, no turn check) belongs to a session that
// is really signed in as the agent with its own credential, where the agent is
// who sends. VIBE_AGENT_HANDLE alone is not that: see tools/_send-box.test.js
// for a person's token under an agent handle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-in-'));
process.env.VIBE_HOME = HOME;
process.env.VIBE_API_URL = 'http://127.0.0.1:9';
process.env.VIBE_AGENT_HANDLE = 'bot1';
process.env.VIBE_AGENT_MINT = 'an-agent-credential-of-enough-length';
delete process.env.VIBE_AGENT_MINT_FILE;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-in-project-'));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-in-claude-'));
const token = `h.${Buffer.from(JSON.stringify({ sub: 'bot1', handle: 'bot1', mint: 'agent', exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url')}.sig`;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ username: 'bot1', authMethod: 'agent', authToken: token }));

require('../host').setClientInfo({ name: 'claude-code', version: 'test' });
const store = require('../store');
const drafts = require('./drafts');
const turns = require('../turns');
const agentAuth = require('../agent-auth');

test.after(() => { for (const d of [HOME, PROJECT, process.env.CLAUDE_CONFIG_DIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('signed in as the agent, with its own credential: no box, no turn check, it sends as itself', async () => {
  turns.record(PROJECT, Date.now() - 60_000);
  assert.equal(agentAuth.signedInAsAgent(), true);
  const sends = [];
  const orig = { sendMessage: store.sendMessage, getActiveUsers: store.getActiveUsers, getActiveUsersResult: store.getActiveUsersResult };
  store.sendMessage = async (from, to, body) => { sends.push({ from, to, body }); return { id: 'msg_1', storedLength: body.length }; };
  store.getActiveUsers = async () => [];
  store.getActiveUsersResult = async () => ({ ok: true, users: [] });
  const origFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ handle: decodeURIComponent(String(url).split('/api/identity/')[1] || ''), kind: 'human' }) });
  try {
    const p = await drafts.vibe_prepare.handler({ handle: 'linus', message: 'build is green' });
    const asked = [];
    const box = { protocolVersion: '2025-11-25', request: async (params) => { asked.push(params); return { action: 'decline' }; } };
    const r = await drafts.vibe_send.handler({ id: p.data.draft.id, rev: p.data.draft.rev }, { box });
    assert.equal(asked.length, 0, 'no box');
    assert.equal(r.data.turn_check, 'agent_identity');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].from, 'bot1');
  } finally { Object.assign(store, orig); global.fetch = origFetch; }
});
