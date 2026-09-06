/**
 * #392 approval digest — the ACTUAL serialized request and Platform's boundary.
 *
 * Astra's finding at 54cc5e4: approved_sha256 was never forwarded through
 * moves → dm → store → POST /api/v2/messages. This test drives the real
 * request builder (store/api.js requestOnce) with the transport stubbed at
 * https.request, captures the exact JSON that would leave the machine, and
 * checks it against Platform's own checkApprovedDigest when the platform
 * checkout is present beside this repo (skipped honestly otherwise).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-digest-'));
process.env.VIBE_HOME = HOME;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  username: 'ada', authMethod: 'github',
  authToken: `h.${b64({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`,
}));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
global.fetch = async () => ({ ok: false, json: async () => ({}) });

const store = require('../store/api.js');
const moves = require('../tools/moves');
const { storedRecipientHandle } = require('../protocol/handle');

/** Stub the wire: capture every request's method/path/body; answer with `respond(path, body)`. */
function stubWire(respond) {
  const captured = [];
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter(); let chunks = '';
    req.write = (c) => { chunks += c; }; req.setTimeout = () => {}; req.destroy = () => {};
    req.end = (c) => {
      if (c) chunks += c;
      const body = chunks ? JSON.parse(chunks) : null;
      captured.push({ method: opts.method, path: opts.path, body });
      const answer = respond(opts.path, body, opts.method);
      const res = new EventEmitter(); res.statusCode = answer.status || 200; res.headers = {};
      setImmediate(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(answer.json))); res.emit('end'); });
    };
    return req;
  };
  return { captured, restore: () => { https.request = orig; } };
}
const quietReads = (path) => {
  if (path.startsWith('/api/presence') || path.startsWith('/api/v2/presence')) return { json: { success: true, active: [{ handle: 'linus', one_liner: 'kernel', status: 'active', lastSeen: Date.now() }], away: [] } };
  if (path.startsWith('/api/v2/threads') || path.startsWith('/api/messages')) return { json: { success: true, threads: [], total_unread: 0 } };
  if (path.startsWith('/api/identity/')) return { json: { handle: 'linus', kind: 'human' } };
  return { json: { success: true } };
};
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('the serialized POST carries approved_sha256 over "<stored recipient>\\n<body>", the idempotency key, and no reserved composition keys', async () => {
  const wire = stubWire((p, body) => {
    if (p.startsWith('/api/v2/messages') && body) return { json: { success: true, id: 'msg_wire_1', message: { id: 'msg_wire_1' } } };
    return quietReads(p);
  });
  try {
    const d = await moves.vibe_draft.handler({ handle: '@Linus', message: '  re: kernel — the scheduler patch is in  ', refs: [{ title: 'PR', url: 'https://github.com/x/y/pull/9' }] });
    const r = await moves.vibe_send_draft.handler({ id: d.data.draft.id, rev: d.data.draft.rev });
    assert.match(r.display, /Sent to \*\*@linus\*\*/);
    const post = wire.captured.find(c => c.method === 'POST' && c.path.startsWith('/api/v2/messages'));
    assert.ok(post, 'a v2 send left through the real request builder');
    const expectedBody = 're: kernel — the scheduler patch is in\nPR: https://github.com/x/y/pull/9';
    assert.equal(post.body.to, 'linus');
    assert.equal(post.body.body, expectedBody);
    const expectedDigest = crypto.createHash('sha256').update(`${storedRecipientHandle('@Linus')}\n${expectedBody}`, 'utf8').digest('hex');
    assert.equal(post.body.approved_sha256, expectedDigest);
    assert.match(post.body.idempotency_key, new RegExp(`^draft-${d.data.draft.id}-[0-9a-f]{10}$`));
    for (const k of ['drafts', 'candidates', 'alternatives', 'sources', 'context_sources', 'ranking', 'rankings', 'discarded', 'composition']) assert.ok(!(k in post.body), `reserved key ${k} never leaves`);
    assert.ok(!JSON.stringify(post.body).includes(HOME), 'no local path leaves');
  } finally { wire.restore(); }
});

test('the digest is computed once from the approved snapshot: an edit after preview is refused before any request', async () => {
  const wire = stubWire((p, body) => { if (p.startsWith('/api/v2/messages') && body) throw new Error('must not reach the wire'); return quietReads(p); });
  try {
    const d = await moves.vibe_draft.handler({ handle: '@linus', message: 'v1' });
    await moves.vibe_draft.handler({ id: d.data.draft.id, message: 'v2' });
    const r = await moves.vibe_send_draft.handler({ id: d.data.draft.id, rev: d.data.draft.rev });
    assert.match(r.display, /changed since that preview/);
    assert.ok(!wire.captured.some(c => c.method === 'POST' && c.path.startsWith('/api/v2/messages')));
  } finally { wire.restore(); }
});

test("Platform's 409 approved_content_mismatch is a definite refusal: nothing stored, draft returns to editable, no retry loop", async () => {
  const wire = stubWire((p, body) => {
    if (p.startsWith('/api/v2/messages') && body) return { status: 409, json: { success: false, error: 'approved_content_mismatch', message: 'The message differs from what was approved. Nothing was sent — preview the updated message and approve it again.' } };
    return quietReads(p);
  });
  try {
    const d = await moves.vibe_draft.handler({ handle: '@linus', message: 'x' });
    const r = await moves.vibe_send_draft.handler({ id: d.data.draft.id, rev: d.data.draft.rev });
    assert.match(r.display, /differs from what was approved/);
    assert.doesNotMatch(r.display, /kept as unconfirmed/);
    const e = await moves.vibe_draft.handler({ id: d.data.draft.id, message: 'y' });
    assert.match(e.display, /\*\*Message \(exact\):\*\*\ny/);
  } finally { wire.restore(); }
});

test("Platform's boundary agrees: our digest passes checkApprovedDigest; an altered body is refused as approved_content_mismatch", async (t) => {
  const boundary = path.resolve(__dirname, '..', '..', 'platform', 'api', 'lib', 'composition-boundary.js');
  if (!fs.existsSync(boundary)) { t.skip('platform checkout not beside this repo — boundary check not run here'); return; }
  const { checkApprovedDigest, approvedDigest, findPrivateCompositionKeys } = await import(require('node:url').pathToFileURL(boundary).href);
  const to = 'linus'; const body = 're: kernel — the scheduler patch is in';
  const ours = crypto.createHash('sha256').update(`${storedRecipientHandle('@Linus')}\n${body}`, 'utf8').digest('hex');
  assert.equal(ours, approvedDigest(to, body), 'same bytes, same digest');
  assert.deepEqual(checkApprovedDigest(ours, to, body), { ok: true });
  assert.equal(checkApprovedDigest(ours, to, body + ' (edited)').error, 'approved_content_mismatch');
  assert.equal(checkApprovedDigest(ours, 'grace', body).error, 'approved_content_mismatch');
  assert.equal(checkApprovedDigest('nope', to, body).error, 'approved_sha256_malformed');
  assert.deepEqual(findPrivateCompositionKeys({ to, body, idempotency_key: 'k', origin: 'composed', approved_sha256: ours }), []);
});

test("getThreadAfter: a legacy server that ignores after_id (no echoed anchor, no has_more) is 'unsupported', never an anchored read", async () => {
  const wire = stubWire((p) => { if (p.includes('after_id=')) return { json: { success: true, thread_id: 'thread_x', messages: [{ id: 'msg_old', from: 'linus', body: 'x' }] } }; return quietReads(p); });
  try {
    const r = await store.getThreadAfter('thread_x', 'msg_anchor', 50);
    assert.equal(r.ok, false); assert.equal(r.error, 'unsupported');
  } finally { wire.restore(); }
  const wire2 = stubWire((p) => { if (p.includes('after_id=')) return { json: { success: true, thread_id: 'thread_x', after: { id: 'msg_anchor', seq: 7 }, has_more: false, messages: [] } }; return quietReads(p); });
  try {
    const r = await store.getThreadAfter('thread_x', 'msg_anchor', 50);
    assert.equal(r.ok, true); assert.equal(r.hasMore, false); assert.equal(r.messages.length, 0);
  } finally { wire2.restore(); }
});
