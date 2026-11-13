// A two-sided stand-in for the /vibe API, for rehearsals. In-process, on
// 127.0.0.1 only, state in memory. Identity comes from the bearer token's
// handle. Nothing here can reach a real person.
import http from 'node:http';

export function startStub({ people = {}, agentMints = {} } = {}) {
  const messages = [];            // { id, seq, from, to, body, created_at, reply_to }
  const effects = [];             // every request, for the report
  const cursors = new Map();      // `${me}|${peer}` -> seq read up to
  let seq = 0;
  // Agent identities (agent-auth.js): handle -> credential the platform host would hold;
  // agents that have minted once; and who is named as running which agent.
  const agentPrincipals = new Set();
  const grants = [];             // { grant_id, operator, agent_handle, expires_at, revoked_at }
  const sessionJwt = (h, extra = {}) => `h.${Buffer.from(JSON.stringify({ sub: h, handle: h, exp: Math.floor(Date.now() / 1000) + 30 * 86400, ...extra })).toString('base64url')}.sig`;
  const liveGrant = (agent) => grants.find((g) => g.agent_handle === agent && !g.revoked_at && Date.parse(g.expires_at) > Date.now());
  const claims = (req) => { try { return JSON.parse(Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString()); } catch { return null; } };
  const iso = () => new Date().toISOString();
  const tid = (a, b) => `thread_${[a, b].sort().join('_')}`;
  const who = (req) => {
    try { const p = JSON.parse(Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString()); return p.handle || p.sub; } catch { return null; }
  };
  const shape = (m) => ({
    id: m.id, seq: m.seq, from: m.from, to: m.to, body: m.body, created_at: m.created_at,
    actor: { principal_id: `p_${m.from}`, kind: agentPrincipals.has(m.from) ? 'agent' : (people[m.from]?.kind || 'human'), operator: liveGrant(m.from)?.operator || null },
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
        if (req.method !== 'GET') { rec('heartbeat', { as: me || String(body?.username || '') || null, register: body?.action === 'register' }); return send(200, { success: true }); }
        rec('read_presence');
        const active = Object.entries(people).map(([handle, x]) => ({ handle, username: handle, status: 'active', one_liner: x.says, workingOn: x.says, isAgent: x.kind === 'agent', lastSeen: iso(), firstSeen: iso() }));
        return send(200, { success: true, active, away: [], recent: [], counts: { active: active.length, total: active.length } });
      }
      if ((m = p.match(/^\/api\/identity\/([^/]+)$/))) {
        rec('read_identity');
        const h = decodeURIComponent(m[1]);
        if (!people[h] && !agentPrincipals.has(h)) return send(404, { error: 'identity_not_found' });
        const g = liveGrant(h);
        return send(200, { handle: h, kind: agentPrincipals.has(h) ? 'agent' : (people[h]?.kind || 'human'), operator: g ? g.operator : null });
      }
      // The agent mint, as the platform does it: a per-handle credential in the x-agent-mint header.
      if (p === '/api/auth/buddy-token' && req.method === 'POST') {
        const h = String(body?.handle || '').toLowerCase();
        const given = req.headers['x-agent-mint'];
        rec('AGENT_MINT', { handle: h, presented: Boolean(given) });
        if (!agentMints[h]) return send(403, { success: false, error: 'Handle not in alpha whitelist' });
        if (!given || given !== agentMints[h]) return send(403, { success: false, error: 'Agent credential required' });
        if (people[h] && people[h].kind !== 'agent' && !people[h].agent) return send(503, { success: false, error: 'Agent identity unavailable' });
        agentPrincipals.add(h);
        return send(200, { success: true, token: sessionJwt(h, { mint: 'agent', principal_id: `p_${h}` }), handle: h });
      }
      // Operator grants: a person's own session AND the agent's credential, in one request.
      if (p === '/api/operator-grants') {
        const c = claims(req);
        if (!c || !c.handle) return send(401, { success: false, error: 'unauthorized' });
        if (c.mint === 'agent') return send(403, { success: false, error: 'principal_credential_required' });
        if (req.method === 'GET') { rec('read_grants'); return send(200, { success: true, grants: grants.filter((g) => g.operator === c.handle).slice().reverse() }); }
        if (req.method === 'DELETE') {
          const g = grants.find((x) => x.grant_id === q.grant_id && x.operator === c.handle && !x.revoked_at);
          rec('GRANT_REVOKE', { ok: Boolean(g) });
          if (!g) return send(404, { success: false, error: 'grant_not_found' });
          g.revoked_at = iso(); return send(200, { success: true, revoked: true });
        }
        if (req.method === 'POST') {
          const agent = String(body?.agent_handle || '').toLowerCase();
          const hours = Number(body?.expires_in_hours ?? 168);
          rec('GRANT', { operator: c.handle, agent, presented: Boolean(req.headers['x-agent-mint']) });
          if (!agent) return send(400, { success: false, error: 'agent_handle_required' });
          if (!(hours > 0 && hours <= 720)) return send(400, { success: false, error: 'invalid_expiry' });
          if (!agentMints[agent] || req.headers['x-agent-mint'] !== agentMints[agent]) return send(403, { success: false, error: 'agent_credential_required' });
          if (!agentPrincipals.has(agent)) return send(404, { success: false, error: 'agent_not_found' });
          if (liveGrant(agent)) return send(409, { success: false, error: 'live_grant_exists' });
          const g = { grant_id: `grant_${grants.length + 1}`, operator: c.handle, agent_handle: agent, scope: ['messages:send'], expires_at: new Date(Date.now() + hours * 3600 * 1000).toISOString(), revoked_at: null };
          grants.push(g);
          return send(200, { success: true, grant_id: g.grant_id, agent_handle: agent, scope: g.scope, expires_at: g.expires_at });
        }
      }
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
    url: `http://127.0.0.1:${server.address().port}`, messages, effects, post, grants, agentPrincipals,
    close: () => new Promise((r) => server.close(r)),
  })));
}
