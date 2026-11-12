// A two-sided stand-in for the /vibe API, for rehearsals. In-process, on
// 127.0.0.1 only, state in memory. Identity comes from the bearer token's
// handle. Nothing here can reach a real person.
import http from 'node:http';

export function startStub({ people = {} } = {}) {
  const messages = [];            // { id, seq, from, to, body, created_at, reply_to }
  const effects = [];             // every request, for the report
  const cursors = new Map();      // `${me}|${peer}` -> seq read up to
  let seq = 0;
  const iso = () => new Date().toISOString();
  const tid = (a, b) => `thread_${[a, b].sort().join('_')}`;
  const who = (req) => {
    try { const p = JSON.parse(Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString()); return p.handle || p.sub; } catch { return null; }
  };
  const shape = (m) => ({
    id: m.id, seq: m.seq, from: m.from, to: m.to, body: m.body, created_at: m.created_at,
    actor: { principal_id: `p_${m.from}`, kind: people[m.from]?.kind || 'human', operator: null },
    reply_to: m.reply_to ? { id: m.reply_to.id, from: m.reply_to.from, text: m.reply_to.body.slice(0, 200) } : null,
  });
  const between = (a, b) => messages.filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a));
  const threadsFor = (me) => {
    const peers = new Set(messages.filter((m) => m.from === me || m.to === me).map((m) => (m.from === me ? m.to : m.from)));
    return [...peers].map((p) => {
      const ms = between(me, p); const last = ms[ms.length - 1];
      const read = cursors.get(`${me}|${p}`) || 0;
      return {
        id: tid(me, p), with: p, message_count: ms.length,
        unread: ms.filter((m) => m.from === p && m.seq > read).length,
        last_message: { id: last.id, from: last.from, body: last.body, created_at: last.created_at, actor: shape(last).actor },
        preferences: { archived: false, muted: false, pinned: false },
      };
    });
  };
  function post(from, to, body, replyTo = null) {
    const parent = replyTo ? messages.find((m) => m.id === replyTo) : null;
    const m = { id: `msg_lab_${++seq}`, seq, from, to, body: String(body), created_at: iso(), reply_to: parent || null };
    messages.push(m);
    return m;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch {}
      const u = new URL(req.url, 'http://x'); const p = u.pathname; const q = Object.fromEntries(u.searchParams); const me = who(req);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const rec = (effect, extra = {}) => effects.push({ t: Date.now(), me, effect, ...extra });
      let m;
      if (p === '/api/auth/verify') { rec('auth'); return send(200, { valid: Boolean(me), handle: me, principal_id: `p_${me}`, github: me }); }
      if (p === '/api/presence' || p === '/api/v2/presence') {
        if (req.method !== 'GET') { rec('heartbeat'); return send(200, { success: true }); }
        rec('read_presence');
        const active = Object.entries(people).map(([handle, x]) => ({ handle, username: handle, status: 'active', one_liner: x.says, workingOn: x.says, isAgent: x.kind === 'agent', lastSeen: iso(), firstSeen: iso() }));
        return send(200, { success: true, active, away: [], recent: [], counts: { active: active.length, total: active.length } });
      }
      if ((m = p.match(/^\/api\/identity\/([^/]+)$/))) { rec('read_identity'); return send(200, { handle: m[1], kind: people[m[1]]?.kind || 'human', operator: null }); }
      if (p === '/api/v2/threads' && req.method === 'GET') { rec('read_threads'); const ts = threadsFor(me); return send(200, { success: true, threads: ts, total_unread: ts.reduce((a, t) => a + t.unread, 0) }); }
      if (p === '/api/messages' && req.method === 'GET') {
        if (q.with) { rec('read_thread', { with: q.with }); const ms = between(me, q.with); return send(200, { success: true, thread_id: tid(me, q.with), messages: ms.map(shape), last_message_id: ms.at(-1)?.id || null }); }
        rec('read_threads'); const ts = threadsFor(me); return send(200, { success: true, threads: ts, total_unread: ts.reduce((a, t) => a + t.unread, 0) });
      }
      if ((m = p.match(/^\/api\/v2\/threads\/([^/]+)\/read$/))) {
        const peer = m[1].replace('thread_', '').split('_').filter((h) => h !== me).join('_') || q.with;
        const last = between(me, peer).at(-1);
        if (last) cursors.set(`${me}|${peer}`, last.seq);
        rec('READ_CURSOR', { with: peer }); return send(200, { success: true });
      }
      if ((m = p.match(/^\/api\/v2\/threads\/([^/]+)$/))) { rec('read_thread_v2'); const ms = messages.filter((x) => tid(x.from, x.to) === m[1]); return send(200, { success: true, thread_id: m[1], messages: ms.map(shape) }); }
      if ((p === '/api/v2/messages' || p === '/api/messages') && req.method === 'POST') {
        const to = String(body?.to || '').replace(/^@/, '').toLowerCase();
        const msg = post(me, to, body?.body ?? body?.text ?? '', body?.reply_to || null);
        rec('SEND', { to, id: msg.id, reply_to: body?.reply_to || null, linked: Boolean(msg.reply_to), idempotency_key: body?.idempotency_key || null, approved: Boolean(body?.approved_sha256), origin: body?.origin || null, body: msg.body });
        return send(200, { success: true, id: msg.id, message_id: msg.id, message: shape(msg), stored: true, chars: msg.body.length, delivered: true });
      }
      rec('other', { path: p });
      return send(200, { success: true, messages: [], data: {} });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, messages, effects, post,
    close: () => new Promise((r) => server.close(r)),
  })));
}
