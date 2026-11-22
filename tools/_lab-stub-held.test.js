'use strict';
// The lab's stand-in API (lab/stub.mjs) must answer a Keep — a message held
// for someone not on /vibe yet — the way the platform does. It did not: a
// POST /api/invites carrying first_thought fell through to the catch-all
// `{success: true, messages: [], data: {}}`, so the client (tools/drafts.js
// createHeld) saw no dry_run digest and refused, correctly, with
// approval_mismatch: "Nothing was kept. What /vibe would store is not what you
// approved." Every Keep in every lab run failed this way (gate r13-box-2, p10);
// the box, the protocol and parallel calls had nothing to do with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const turns = require('../turns');
const jwt = (h) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
/** The platform's rule, written out independently (api/lib/invitation-email.js approvalInput). */
const platformDigest = (t) => crypto.createHash('sha256').update(['invitation-v1', '', '', '', '', '', '', t].join('\u0000'), 'utf8').digest('hex');

async function post(url, token, body) {
  const r = await fetch(`${url}/api/invites`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test('the stub answers a Keep as the platform does: dry run digest, refusal on a wrong digest, a code of the platform\'s shape', async () => {
  const { startStub } = await import(path.join(ROOT, 'lab', 'stub.mjs'));
  const stub = await startStub({ people: { ada: { says: 'me' } } });
  try {
    const t = jwt('ada');
    const thought = 'heads up: the pooler goes back to session mode';
    const dry = await post(stub.url, t, { first_thought: thought, for_github: 'dalia', dry_run: true });
    assert.equal(dry.status, 200);
    assert.deepEqual({ ...dry.json }, { success: true, dry_run: true, named_for: 'dalia', carries_thought: true, approval: { rule: 'invitation-v1', sha256: platformDigest(thought) } });
    const wrong = await post(stub.url, t, { first_thought: thought, for_github: 'dalia', approved_sha256: 'f'.repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error, 'approval_mismatch');
    const made = await post(stub.url, t, { first_thought: thought, for_github: 'dalia', approved_sha256: platformDigest(thought) });
    assert.equal(made.status, 200);
    assert.match(made.json.code, /^VIBE-[A-Z0-9]{4}-[A-Z0-9_-]{1,4}$/, 'the client accepts only this shape');
    assert.equal(made.json.carries_thought, true);
    assert.equal(made.json.named_for, 'dalia');
    const empty = await post(stub.url, t, {});
    assert.equal(empty.status, 200, 'a plain invitation still works');
  } finally { await stub.close(); }
});

test('the gate\'s case end to end: a long Keep, stateless box accepted, with vibe_thread in the same chunk both times, is held', async () => {
  const { startStub } = await import(path.join(ROOT, 'lab', 'stub.mjs'));
  const stub = await startStub({ people: { ada: { says: 'me', kind: 'human' }, ines: { says: 'ines', kind: 'human' } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-stub-held-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-stub-held-p-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ handle: 'ada', token: jwt('ada'), provider: 'github', authenticated_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ handle: 'ada', one_liner: 'me' }));
  turns.record(project, Date.now() - 60_000, { VIBE_HOME: home });
  const env = { ...process.env, HOME: home, VIBE_HOME: home, VIBE_API_URL: stub.url, CI: '1', VIBE_SETUP_NO_AUTORUN: '1', CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: home };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'VIBE_AGENT_HANDLE', 'VIBE_TURNS_DIR']) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], { env, cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
  const rows = []; let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { rows.push(JSON.parse(l)); } catch {} } });
  const send = (...ms) => child.stdin.write(ms.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n');
  const wait = (id) => new Promise((resolve, reject) => { const t0 = Date.now(); const f = () => { const r = rows.find((x) => x.id === id); if (r) return resolve(r); if (Date.now() - t0 > 15_000) return reject(new Error(`no response ${id}`)); setTimeout(f, 20); }; f(); });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: 'test' } };
  const text = 'Heads up: quote-service 5xx is at 7.8% and I am rolling back CHG-2291 on the quote-db pooler (6432 back to session mode, pool 120). Quote-service uses server-side prepares, which transaction mode breaks.';
  try {
    send({ id: 1, method: 'tools/call', params: { name: 'vibe_prepare', arguments: { handle: 'dalia', message: text }, _meta: meta } });
    const prep = (await wait(1)).result.content[0].text;
    assert.match(prep, /\*\*To:\*\* @dalia \(not on \/vibe yet\)/);
    const id = prep.match(/draft (w[0-9a-f]+)/)[1]; const rev = prep.match(/rev ([0-9a-f]{8})/)[1];
    await new Promise((r) => setTimeout(r, 5));
    turns.record(project, Date.now(), { VIBE_HOME: home });   // the person typed "send"
    send({ id: 2, method: 'tools/call', params: { name: 'vibe_send', arguments: { id, rev }, _meta: meta } },
      { id: 3, method: 'tools/call', params: { name: 'vibe_thread', arguments: { handle: 'ines' }, _meta: meta } });
    const first = (await wait(2)).result;
    assert.equal(first.resultType, 'input_required');
    assert.match(first.inputRequests.send_confirmation.params.message, /^Keep for @dalia\? \(\d+ chars, start only\)\n> Heads up/);
    send({ id: 4, method: 'tools/call', params: { name: 'vibe_send', arguments: { id, rev }, inputResponses: { send_confirmation: { action: 'accept', content: { choice: 'send' } } }, requestState: first.requestState, _meta: meta } },
      { id: 5, method: 'tools/call', params: { name: 'vibe_thread', arguments: { handle: 'ines' }, _meta: meta } });
    const done = (await wait(4)).result.content[0].text;
    assert.match(done, /^Held for @dalia\. \/vibe created the invitation\./, done);
    const held = stub.effects.filter((e) => e.effect === 'HELD');
    assert.equal(held.length, 1);
    assert.equal(held[0].body, text, 'the exact text approved is what is held');
  } finally { child.kill(); await stub.close(); for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true }); }
});
